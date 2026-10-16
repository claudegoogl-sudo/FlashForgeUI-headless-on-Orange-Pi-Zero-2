/**
 * @fileoverview Light timer: turns the printer light off automatically.
 *
 * Runs on the WebUI host, so it works with every browser closed. Two mechanisms:
 *
 * - Daily auto-off at a local time of day (HH:MM, the host's time zone). It acts once
 *   per day, only when the light is on at that moment, and only if the host was running
 *   within {@link DAILY_GRACE_MINUTES} of the set time. A host that was down at the set
 *   time does not switch the light off hours later; switching the light on after the set
 *   time does not switch it off either (the day is already used up).
 * - One-shot "off in N minutes", stored as an absolute time so it survives restarts.
 *   It always acts when due, even hours late after downtime.
 *
 * The daily one can skip the day while a print is running (the light may be wanted for
 * the camera); the one-shot is an explicit request and never skips. A failed command is
 * retried every tick until {@link RETRY_WINDOW_MINUTES} have passed.
 *
 * State is persisted as JSON so settings and pending timers survive a restart.
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { getPrinterBackendManager } from '../managers/PrinterBackendManager';
import { getPrinterContextManager } from '../managers/PrinterContextManager';
import { getDataPath } from '../utils/setup';

export const DAILY_GRACE_MINUTES = 10;
export const RETRY_WINDOW_MINUTES = 5;
export const MAX_OFF_IN_MINUTES = 12 * 60;
const TICK_MS = 30_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface LightTimerConfig {
  dailyOff: { enabled: boolean; time: string };
  /** Daily auto-off leaves the light alone on a day when it is printing at the set time. */
  skipWhilePrinting: boolean;
  /** Epoch ms at which the one-shot timer turns the light off, or null. */
  offAt: number | null;
  /** Local date (YYYY-MM-DD) for which the daily auto-off is already used up. */
  lastDailyDate: string | null;
}

export interface LightTimerState {
  readonly config: LightTimerConfig;
  readonly now: number;
  /** Host local time, HH:MM, so the UI can show which clock the daily time refers to. */
  readonly localTime: string;
  /** Epoch ms of the next daily auto-off, or null when disabled. */
  readonly nextDailyAt: number | null;
}

/** Everything the service needs from the printers; injected so it can be tested. */
export interface LightTimerActions {
  /** Context ids of printers that have a controllable light and are connected. */
  contexts(): string[];
  /** True/false when known, undefined when the light state cannot be read. */
  isLightOn(contextId: string): Promise<boolean | undefined>;
  isPrinting(contextId: string): Promise<boolean>;
  turnOff(contextId: string): Promise<boolean>;
}

export function defaultLightTimerConfig(): LightTimerConfig {
  return {
    dailyOff: { enabled: false, time: '22:00' },
    skipWhilePrinting: false,
    offAt: null,
    lastDailyDate: null,
  };
}

export function isValidTime(value: unknown): value is string {
  return typeof value === 'string' && TIME_PATTERN.test(value);
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function minutesSinceMidnight(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

function targetMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Epoch ms of the next occurrence of HH:MM strictly after `from`. */
export function nextOccurrence(time: string, from: number): number {
  const [h, m] = time.split(':').map(Number);
  const candidate = new Date(from);
  candidate.setHours(h, m, 0, 0);
  if (candidate.getTime() <= from) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

function sanitize(raw: unknown): LightTimerConfig {
  const base = defaultLightTimerConfig();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const daily = (r.dailyOff ?? {}) as Record<string, unknown>;
  return {
    dailyOff: {
      enabled: daily.enabled === true,
      time: isValidTime(daily.time) ? daily.time : base.dailyOff.time,
    },
    skipWhilePrinting: r.skipWhilePrinting === true,
    offAt: typeof r.offAt === 'number' && Number.isFinite(r.offAt) ? r.offAt : null,
    lastDailyDate: typeof r.lastDailyDate === 'string' ? r.lastDailyDate : null,
  };
}

export class LightTimerService {
  private config: LightTimerConfig = defaultLightTimerConfig();
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private oneShotAttemptSince: number | null = null;

  constructor(
    private readonly filePath: string,
    private readonly actions: LightTimerActions,
    private readonly now: () => number = Date.now
  ) {}

  public async start(): Promise<void> {
    await this.load();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async getState(): Promise<LightTimerState> {
    await this.load();
    const now = this.now();
    return {
      config: { ...this.config, dailyOff: { ...this.config.dailyOff } },
      now,
      localTime: `${String(new Date(now).getHours()).padStart(2, '0')}:${String(new Date(now).getMinutes()).padStart(2, '0')}`,
      nextDailyAt: this.config.dailyOff.enabled
        ? nextOccurrence(this.config.dailyOff.time, now)
        : null,
    };
  }

  public async setDaily(update: {
    enabled?: boolean;
    time?: string;
    skipWhilePrinting?: boolean;
  }): Promise<void> {
    await this.load();
    if (update.time !== undefined) {
      if (!isValidTime(update.time)) throw new Error('time must be HH:MM (24 h)');
      this.config.dailyOff.time = update.time;
      this.config.lastDailyDate = null; // a new time may still be ahead today
    }
    if (update.enabled !== undefined) {
      this.config.dailyOff.enabled = update.enabled;
      if (update.enabled) {
        // Enabling after the set time passed must not fire retroactively today.
        const now = this.now();
        if (minutesSinceMidnight(now) >= targetMinutes(this.config.dailyOff.time)) {
          this.config.lastDailyDate = localDate(now);
        } else {
          this.config.lastDailyDate = null;
        }
      }
    }
    if (update.skipWhilePrinting !== undefined)
      this.config.skipWhilePrinting = update.skipWhilePrinting;
    await this.save();
  }

  public async offIn(minutes: number): Promise<number> {
    await this.load();
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_OFF_IN_MINUTES) {
      throw new Error(`minutes must be a whole number from 1 to ${MAX_OFF_IN_MINUTES}`);
    }
    this.config.offAt = this.now() + minutes * 60_000;
    this.oneShotAttemptSince = null;
    await this.save();
    return this.config.offAt;
  }

  public async cancelOffIn(): Promise<void> {
    await this.load();
    this.config.offAt = null;
    this.oneShotAttemptSince = null;
    await this.save();
  }

  /** One scheduling pass. Public so tests (and the routes, after a change) can drive it. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.load();
      const now = this.now();
      let changed = false;

      // ---- one-shot
      if (this.config.offAt !== null && now >= this.config.offAt) {
        this.oneShotAttemptSince ??= now;
        const done = await this.switchOff(false);
        if (done) {
          this.config.offAt = null;
          this.oneShotAttemptSince = null;
          changed = true;
        } else if (now - this.oneShotAttemptSince > RETRY_WINDOW_MINUTES * 60_000) {
          console.warn('[LightTimer] Could not switch the light off; giving up on this timer');
          this.config.offAt = null;
          this.oneShotAttemptSince = null;
          changed = true;
        }
      }

      // ---- daily
      const daily = this.config.dailyOff;
      if (daily.enabled) {
        const today = localDate(now);
        const sinceTarget = minutesSinceMidnight(now) - targetMinutes(daily.time);
        if (sinceTarget >= 0 && this.config.lastDailyDate !== today) {
          if (sinceTarget > DAILY_GRACE_MINUTES) {
            this.config.lastDailyDate = today; // host was down at the set time: nothing to do today
            changed = true;
          } else {
            const done = await this.switchOff(this.config.skipWhilePrinting);
            if (done || sinceTarget >= RETRY_WINDOW_MINUTES) {
              this.config.lastDailyDate = today;
              changed = true;
            }
          }
        }
      }

      if (changed) await this.save();
    } catch (error) {
      console.error('[LightTimer] Tick failed:', error);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Switch the light off on every connected printer that has it on.
   * @returns true when nothing is left to do (off, skipped on purpose, or no printer),
   *          false when at least one printer could not be switched and should be retried.
   */
  private async switchOff(skipWhilePrinting: boolean): Promise<boolean> {
    let allDone = true;
    for (const contextId of this.actions.contexts()) {
      try {
        if (skipWhilePrinting && (await this.actions.isPrinting(contextId))) continue;
        const on = await this.actions.isLightOn(contextId);
        if (on === false) continue;
        const ok = await this.actions.turnOff(contextId);
        if (!ok) allDone = false;
        else console.log(`[LightTimer] Light switched off (${contextId})`);
      } catch (error) {
        console.warn(`[LightTimer] ${contextId}:`, error instanceof Error ? error.message : error);
        allDone = false;
      }
    }
    return allDone;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.config = sanitize(JSON.parse(await fsp.readFile(this.filePath, 'utf8')));
    } catch {
      this.config = defaultLightTimerConfig();
    }
  }

  private async save(): Promise<void> {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(this.config, null, 2));
    await fsp.rename(temporary, this.filePath);
  }
}

// ---------------------------------------------------------------------------
// Real printers
// ---------------------------------------------------------------------------

/** Printer states in which a job is running (raw firmware values, any case). */
const PRINTING_STATES = new Set(['printing', 'paused', 'pausing', 'heating', 'calibrating']);

export function createPrinterLightActions(): LightTimerActions {
  const backends = getPrinterBackendManager();
  const contexts = getPrinterContextManager();
  const readStatus = async (contextId: string) => {
    const result = await backends.getPrinterStatus(contextId);
    return result.success
      ? (result.status as { printerState?: string; lightOn?: boolean })
      : undefined;
  };
  return {
    contexts: () =>
      contexts
        .getAllContexts()
        .map((context) => context.id)
        .filter(
          (id) => backends.isBackendReady(id) && backends.isFeatureAvailable(id, 'led-control')
        ),
    isLightOn: async (contextId) => (await readStatus(contextId))?.lightOn,
    isPrinting: async (contextId) =>
      PRINTING_STATES.has(((await readStatus(contextId))?.printerState ?? '').toLowerCase()),
    turnOff: async (contextId) => {
      const backend = backends.getBackendForContext(contextId);
      if (!backend) return false;
      return (await backend.setLedEnabled(false)).success;
    },
  };
}

let instance: LightTimerService | null = null;

export function getLightTimerService(): LightTimerService {
  if (!instance) {
    instance = new LightTimerService(
      path.join(getDataPath(), 'light-timer.json'),
      createPrinterLightActions()
    );
  }
  return instance;
}
