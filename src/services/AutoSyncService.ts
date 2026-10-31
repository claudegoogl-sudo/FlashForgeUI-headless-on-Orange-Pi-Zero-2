/**
 * @fileoverview Auto-sync: the job library is the upload queue for the printer.
 *
 * Files put into the library (PUT /api/files/library/<name>) are sent to the active
 * printer by this service, upload only, never started. It runs on the WebUI host, so it
 * works with every browser closed. Per tick (10 s):
 *
 * - The library is compared with <data dir>/library-sync.json. A new or changed file
 *   (size or mtime) becomes `queued`.
 * - Only when the polling data says the printer is `Ready` (not printing, paused, or
 *   finished and waiting to be cleared) and a fresh status check agrees, the oldest due
 *   queued file is sent. One file per tick.
 * - A failed send is retried with a growing delay; after {@link MAX_ATTEMPTS} attempts
 *   the file is `failed` until it is requeued by hand. A send that did not complete
 *   (restart, crash) leaves the file `queued`.
 *
 * Uploads into the library are written to a temporary file and renamed into place
 * (FileLibraryService.save), so a file that is listed is always complete.
 *
 * First run: files already in the library are not queued. They are `synced` when the
 * printer's file list has their name, else `unsynced` (not on the printer, not queued;
 * the manual Send button works on them). The Creator 5 lists only its 10 most recent
 * files, so older ones show as `unsynced`.
 *
 * Optional cleanup (off by default) deletes old files from the printer, but only files
 * this service synced, never the file printing or last printed, never anything younger
 * than 24 h, and it always keeps the newest N. The Creator 5 HTTP API has no delete call,
 * so this only acts on printers with SFTP file management (AD5X, Adventurer 5M family).
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { getConfigManager } from '../managers/ConfigManager';
import { getPrinterBackendManager } from '../managers/PrinterBackendManager';
import { getPrinterContextManager } from '../managers/PrinterContextManager';
import { getDataPath } from '../utils/setup';
import {
  FileLibraryError,
  type FileLibraryService,
  getFileLibraryService,
  type LibraryFile,
} from './FileLibraryService';
import { FileManagerService, getFileManagerService } from './FileManagerService';
import { getMultiContextPollingCoordinator } from './MultiContextPollingCoordinator';

export type SyncState = 'queued' | 'synced' | 'failed' | 'unsynced';

export interface SyncRecord {
  name: string;
  size: number;
  /** Library file mtime (ISO), together with size it identifies the content that was queued. */
  modified: string;
  state: SyncState;
  queuedAt: string;
  syncedAt?: string;
  attempts: number;
  lastError?: string;
  /** Epoch ms before which a failed send is not retried. */
  nextAttemptAt?: number;
  /** First-run record whose presence on the printer is not yet checked. */
  baseline?: boolean;
}

export interface SyncInfo {
  readonly syncState: SyncState;
  readonly syncedAt?: string;
  readonly lastError?: string;
}

export interface AutoSyncSettings {
  enabled: boolean;
  cleanup: { enabled: boolean; dryRun: boolean; keepNewest: number };
}

/** Everything the service needs from the printers; injected so it can be tested. */
export interface AutoSyncPrinter {
  /** The active context when its backend is ready, else undefined. */
  activeContext(): string | undefined;
  /** From the polling data (no request): connected, recently polled, state Ready. */
  isReady(contextId: string): boolean;
  /** Fresh status request, asked right before a send. */
  confirmReady(contextId: string): Promise<boolean>;
  /** Names on the printer, undefined when the list cannot be read. */
  listFiles(contextId: string): Promise<string[] | undefined>;
  send(
    contextId: string,
    name: string,
    filePath: string
  ): Promise<{ success: boolean; error?: string }>;
  /** File of the job shown in the polling data, if any. */
  currentJobFile(contextId: string): string | undefined;
  canDelete(contextId: string): boolean;
  deleteFile(contextId: string, name: string): Promise<{ success: boolean; error?: string }>;
}

export const TICK_MS = 10_000;
export const MAX_ATTEMPTS = 5;
export const MIN_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const CLEANUP_RETRY_MS = 10 * 60_000;
const STATES: readonly string[] = ['queued', 'synced', 'failed', 'unsynced'];

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

/**
 * Synced files this service may delete, oldest first. Records without `syncedAt`
 * (found on the printer at the first run) are never candidates.
 */
export function pickCleanupCandidates(
  records: readonly SyncRecord[],
  options: { keepNewest: number; now: number; protectedNames: ReadonlySet<string> }
): SyncRecord[] {
  const ours = records
    .filter((r) => r.state === 'synced' && r.syncedAt)
    .sort((a, b) => (b.syncedAt as string).localeCompare(a.syncedAt as string));
  return ours
    .slice(Math.max(1, options.keepNewest))
    .filter(
      (r) =>
        !options.protectedNames.has(r.name) &&
        options.now - Date.parse(r.syncedAt as string) >= MIN_CLEANUP_AGE_MS
    )
    .reverse();
}

export class AutoSyncService {
  private records = new Map<string, SyncRecord>();
  private lastPrintedFile: string | undefined;
  private loading: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private saving: Promise<void> = Promise.resolve();
  private cleanupRetryAt = 0;
  private readonly logged = new Set<string>();

  constructor(
    private readonly filePath: string,
    private readonly library: FileLibraryService,
    private readonly printer: AutoSyncPrinter,
    private readonly settings: () => AutoSyncSettings,
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

  /** Sync info for the given library files (records are brought up to date first). */
  public async describe(files: readonly LibraryFile[]): Promise<Map<string, SyncInfo>> {
    await this.load();
    if (this.reconcile(files)) await this.save();
    const info = new Map<string, SyncInfo>();
    for (const file of files) {
      const r = this.records.get(file.name);
      if (r)
        info.set(file.name, { syncState: r.state, syncedAt: r.syncedAt, lastError: r.lastError });
    }
    return info;
  }

  /** Queue a file again (failed, not synced, or to send it once more). */
  public async requeue(name: string): Promise<void> {
    if (!this.settings().enabled) {
      throw new FileLibraryError('Auto-sync is switched off (AutoSyncEnabled)', 409);
    }
    await this.load();
    const file = await this.library.stat(name);
    this.reconcile([file]);
    const record = this.records.get(name);
    if (!record) throw new Error('File not found');
    this.queue(record, file);
    await this.save();
  }

  /** A manual send reached the printer. */
  public async markSynced(name: string): Promise<void> {
    await this.load();
    const file = await this.library.stat(name);
    this.reconcile([file]);
    const record = this.records.get(name);
    if (!record) return;
    this.setSynced(record);
    await this.save();
  }

  /** One pass. Public so tests can drive it. */
  public async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.load();
      const settings = this.settings();
      const files = await this.library.list();
      this.reconcile(files);
      this.pruneMissing(files);
      if (settings.enabled) {
        const contextId = this.printer.activeContext();
        if (contextId) {
          this.trackLastPrinted(contextId);
          if (this.printer.isReady(contextId)) {
            await this.resolveBaseline(contextId);
            const outcome = await this.syncNext(contextId);
            if (outcome === 'none') await this.cleanup(contextId, settings.cleanup, files);
          }
        }
      }
      await this.save();
    } catch (error) {
      console.error('[AutoSync] Tick failed:', error);
    } finally {
      this.ticking = false;
    }
  }

  // ---- records

  private queue(record: SyncRecord, file: LibraryFile): void {
    record.size = file.size;
    record.modified = file.modified;
    record.state = 'queued';
    record.queuedAt = new Date(this.now()).toISOString();
    record.attempts = 0;
    record.baseline = undefined;
    record.syncedAt = undefined;
    record.lastError = undefined;
    record.nextAttemptAt = undefined;
  }

  private setSynced(record: SyncRecord): void {
    record.state = 'synced';
    record.syncedAt = new Date(this.now()).toISOString();
    record.attempts = 0;
    record.baseline = undefined;
    record.lastError = undefined;
    record.nextAttemptAt = undefined;
  }

  /** Bring records in line with the library. Returns true when anything changed. */
  private reconcile(files: readonly LibraryFile[]): boolean {
    const enabled = this.settings().enabled;
    let changed = false;
    for (const file of files) {
      const record = this.records.get(file.name);
      if (!record) {
        const created: SyncRecord = {
          name: file.name,
          size: file.size,
          modified: file.modified,
          state: 'unsynced',
          queuedAt: new Date(this.now()).toISOString(),
          attempts: 0,
        };
        if (enabled) this.queue(created, file);
        this.records.set(file.name, created);
        changed = true;
      } else if (record.size !== file.size || record.modified !== file.modified) {
        this.queue(record, file);
        if (!enabled) record.state = 'unsynced';
        changed = true;
      }
    }
    return changed;
  }

  /** Drop records of files that left the library, except synced ones cleanup may still delete. */
  private pruneMissing(files: readonly LibraryFile[]): void {
    const present = new Set(files.map((f) => f.name));
    for (const [name, record] of this.records) {
      if (!present.has(name) && !(record.state === 'synced' && record.syncedAt)) {
        this.records.delete(name);
      }
    }
  }

  // ---- printer work

  private trackLastPrinted(contextId: string): void {
    const current = this.printer.currentJobFile(contextId);
    if (current && current !== this.lastPrintedFile) this.lastPrintedFile = current;
  }

  private async resolveBaseline(contextId: string): Promise<void> {
    const pending = [...this.records.values()].filter((r) => r.baseline);
    if (pending.length === 0) return;
    const onPrinter = await this.printer.listFiles(contextId);
    if (!onPrinter) return;
    const names = new Set(onPrinter);
    for (const record of pending) {
      record.baseline = undefined;
      if (names.has(record.name)) record.state = 'synced';
    }
  }

  private async syncNext(contextId: string): Promise<'sent' | 'waiting' | 'none'> {
    const now = this.now();
    const due = [...this.records.values()]
      .filter((r) => r.state === 'queued' && (r.nextAttemptAt ?? 0) <= now)
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.name.localeCompare(b.name));
    const next = due[0];
    if (!next)
      return [...this.records.values()].some((r) => r.state === 'queued') ? 'waiting' : 'none';

    if (!(await this.printer.confirmReady(contextId))) return 'waiting';

    const sentSize = next.size;
    const sentModified = next.modified;
    console.log(`[AutoSync] Sending ${next.name} (${sentSize} bytes)`);
    let error: string | undefined;
    try {
      const result = await this.printer.send(
        contextId,
        next.name,
        this.library.resolvePath(next.name)
      );
      if (!result.success) error = result.error || 'Printer rejected the upload';
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (next.size !== sentSize || next.modified !== sentModified) return 'sent'; // replaced while sending: stays queued
    if (error === undefined) {
      this.setSynced(next);
      console.log(`[AutoSync] Synced ${next.name}`);
    } else {
      next.attempts += 1;
      next.lastError = error;
      if (next.attempts >= MAX_ATTEMPTS) {
        next.state = 'failed';
        next.nextAttemptAt = undefined;
        console.warn(`[AutoSync] ${next.name} failed after ${next.attempts} attempts: ${error}`);
      } else {
        next.nextAttemptAt = this.now() + backoffMs(next.attempts);
        console.warn(`[AutoSync] ${next.name} attempt ${next.attempts} failed: ${error}`);
      }
    }
    return 'sent';
  }

  private async cleanup(
    contextId: string,
    options: AutoSyncSettings['cleanup'],
    files: readonly LibraryFile[]
  ): Promise<void> {
    if (!options.enabled || this.now() < this.cleanupRetryAt) return;
    const protectedNames = new Set<string>();
    const current = this.printer.currentJobFile(contextId);
    if (current) protectedNames.add(current);
    if (this.lastPrintedFile) protectedNames.add(this.lastPrintedFile);
    const candidates = pickCleanupCandidates([...this.records.values()], {
      keepNewest: options.keepNewest,
      now: this.now(),
      protectedNames,
    });
    if (candidates.length === 0) return;

    if (!this.printer.canDelete(contextId)) {
      this.logOnce('This printer cannot delete files over its API; cleanup does nothing');
      return;
    }
    if (options.dryRun) {
      for (const candidate of candidates) {
        this.logOnce(`Cleanup dry run: would delete ${candidate.name} from the printer`);
      }
      return;
    }

    const target = candidates[0];
    const result = await this.printer.deleteFile(contextId, target.name);
    if (!result.success) {
      this.cleanupRetryAt = this.now() + CLEANUP_RETRY_MS;
      console.warn(
        `[AutoSync] Cleanup could not delete ${target.name}: ${result.error ?? 'unknown error'}`
      );
      return;
    }
    console.log(`[AutoSync] Cleanup deleted ${target.name} from the printer`);
    if (files.some((f) => f.name === target.name)) {
      target.state = 'unsynced';
      target.syncedAt = undefined;
    } else {
      this.records.delete(target.name);
    }
  }

  private logOnce(message: string): void {
    if (this.logged.has(message)) return;
    this.logged.add(message);
    console.log(`[AutoSync] ${message}`);
  }

  // ---- persistence

  private load(): Promise<void> {
    this.loading ??= this.read();
    return this.loading;
  }

  private async read(): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, 'utf8');
    } catch {
      await this.createBaseline();
      return;
    }
    try {
      const data = JSON.parse(raw) as { lastPrintedFile?: unknown; files?: unknown };
      if (typeof data.lastPrintedFile === 'string') this.lastPrintedFile = data.lastPrintedFile;
      for (const item of Array.isArray(data.files) ? data.files : []) {
        const r = item as SyncRecord;
        if (typeof r?.name === 'string' && STATES.includes(r.state)) this.records.set(r.name, r);
      }
    } catch (error) {
      console.error('[AutoSync] library-sync.json is unreadable, starting a new baseline:', error);
      await this.createBaseline();
    }
  }

  private async createBaseline(): Promise<void> {
    this.records.clear();
    for (const file of await this.library.list()) {
      this.records.set(file.name, {
        name: file.name,
        size: file.size,
        modified: file.modified,
        state: 'unsynced',
        queuedAt: new Date(this.now()).toISOString(),
        attempts: 0,
        baseline: true,
      });
    }
    await this.save();
  }

  private save(): Promise<void> {
    const write = async () => {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      const body = {
        version: 1,
        lastPrintedFile: this.lastPrintedFile,
        files: [...this.records.values()],
      };
      await fsp.writeFile(temporary, JSON.stringify(body, null, 2));
      await fsp.rename(temporary, this.filePath);
    };
    this.saving = this.saving.then(write, write);
    return this.saving;
  }
}

// ---------------------------------------------------------------------------
// Real printers
// ---------------------------------------------------------------------------

const POLL_MAX_AGE_MS = 30_000;

export function createPrinterSyncActions(): AutoSyncPrinter {
  const backends = getPrinterBackendManager();
  const contexts = getPrinterContextManager();
  const polling = getMultiContextPollingCoordinator();
  const fileManager = () => getFileManagerService();
  const target = (contextId: string) => {
    const details = backends.getPrinterDetailsForContext(contextId);
    return details
      ? {
          contextId,
          ipAddress: details.IPAddress,
          serialNumber: details.SerialNumber,
          printerName: details.Name,
          modelType: details.modelType,
        }
      : undefined;
  };

  return {
    activeContext: () => {
      const id = contexts.getActiveContextId();
      return id && backends.isBackendReady(id) ? id : undefined;
    },
    isReady: (contextId) => {
      const data = polling.getPollingDataForContext(contextId);
      return (
        !!data?.isConnected &&
        data.printerStatus?.state === 'Ready' &&
        Date.now() - data.lastPolled.getTime() < POLL_MAX_AGE_MS
      );
    },
    confirmReady: async (contextId) => {
      const result = await backends.getPrinterStatus(contextId);
      const state = (result.success ? result.status?.printerState : undefined) ?? '';
      return ['ready', 'idle'].includes(state.trim().toLowerCase());
    },
    listFiles: async (contextId) => {
      const result = await backends.getLocalJobs(contextId);
      return result.success ? result.jobs.map((job) => job.fileName) : undefined;
    },
    send: async (contextId, name, filePath) => {
      const result = await backends.startJob(contextId, {
        operation: 'start',
        fileName: name,
        filePath,
        startNow: false,
        leveling: false,
      });
      return { success: result.success, error: result.error };
    },
    currentJobFile: (contextId) =>
      polling.getPollingDataForContext(contextId)?.printerStatus?.currentJob?.fileName || undefined,
    canDelete: (contextId) =>
      FileManagerService.isModelSupported(
        backends.getPrinterDetailsForContext(contextId)?.modelType
      ),
    deleteFile: async (contextId, name) => {
      const t = target(contextId);
      if (!t) return { success: false, error: 'Printer details unknown' };
      const listing = await fileManager().listFiles(t, 'internal', '');
      if (!listing.success) return { success: false, error: listing.error };
      const entry = listing.entries.find((e) => !e.isDirectory && e.name === name);
      if (!entry) return { success: false, error: 'File not found on the printer' };
      const result = await fileManager().deleteFiles(t, 'internal', [entry.path]);
      return {
        success: result.success,
        error: result.error ?? result.outcomes.find((o) => o.error)?.error,
      };
    },
  };
}

export function getAutoSyncSettings(): AutoSyncSettings {
  const config = getConfigManager().getConfig();
  return {
    enabled: config.AutoSyncEnabled,
    cleanup: {
      enabled: config.AutoSyncCleanupEnabled,
      dryRun: config.AutoSyncCleanupDryRun,
      keepNewest: config.AutoSyncCleanupKeepNewest,
    },
  };
}

let instance: AutoSyncService | null = null;

export function getAutoSyncService(): AutoSyncService {
  if (!instance) {
    instance = new AutoSyncService(
      path.join(getDataPath(), 'library-sync.json'),
      getFileLibraryService(),
      createPrinterSyncActions(),
      getAutoSyncSettings
    );
  }
  return instance;
}
