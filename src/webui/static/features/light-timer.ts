/**
 * @fileoverview Light timer panel: automatic switch-off of the printer light.
 *
 * Settings live on the WebUI host (see LightTimerService), so they keep working
 * with every browser closed. This panel shows the light state, a daily "off at"
 * time, quick one-shot timers (off in 30 min / 1 h / 2 h / 4 h) with a countdown,
 * and an option to leave the light alone on days with a running print.
 * Daily times are the host's local time; the panel shows the host clock to make
 * that visible.
 */

import type { PrinterStatus } from '../app.js';
import { state } from '../core/AppState.js';
import { apiRequestWithMetadata, onStatusUpdate } from '../core/Transport.js';
import { $, showToast } from '../shared/dom.js';

interface LightTimerResponse {
  success: boolean;
  error?: string;
  supported: boolean;
  lightOn?: boolean;
  config: {
    dailyOff: { enabled: boolean; time: string };
    skipWhilePrinting: boolean;
    offAt: number | null;
  };
  now: number;
  localTime: string;
  remainingSeconds: number | null;
}

const REFRESH_MS = 15000;
const COUNTDOWN_MS = 1000;

let lastRefresh = 0;
let refreshing = false;
/** Host clock minus browser clock at the last fetch (ms), for the countdown. */
let clockOffset = 0;
let offAt: number | null = null;
let countdownTimer: number | null = null;
/** Ignore server values for the inputs the user just touched. */
let editingUntil = 0;

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${two(minutes)}:${two(seconds)}` : `${minutes}:${two(seconds)}`;
}

function render(data: LightTimerResponse): void {
  const root = $('light-timer-content');
  if (!root) return;

  const unsupported = $('light-timer-unsupported');
  const body = $('light-timer-body');
  unsupported?.classList.toggle('hidden', data.supported);
  body?.classList.toggle('hidden', !data.supported);
  if (!data.supported) return;

  const lightState = $('light-timer-state');
  if (lightState) {
    lightState.textContent = data.lightOn === undefined ? '--' : data.lightOn ? 'on' : 'off';
    lightState.className = `light-timer-state ${data.lightOn ? 'on' : ''}`;
  }

  clockOffset = data.now - Date.now();
  offAt = data.config.offAt;

  if (Date.now() >= editingUntil) {
    const enabled = $('light-timer-daily-enabled') as HTMLInputElement | null;
    const time = $('light-timer-daily-time') as HTMLInputElement | null;
    const skip = $('light-timer-skip') as HTMLInputElement | null;
    if (enabled) enabled.checked = data.config.dailyOff.enabled;
    if (time && document.activeElement !== time) time.value = data.config.dailyOff.time;
    if (skip) skip.checked = data.config.skipWhilePrinting;
  }

  const clock = $('light-timer-clock');
  if (clock) clock.textContent = `Host time ${data.localTime}`;
  renderCountdown();
}

function renderCountdown(): void {
  const row = $('light-timer-countdown');
  const text = $('light-timer-countdown-text');
  if (!row || !text) return;

  if (offAt === null) {
    row.classList.add('hidden');
    if (countdownTimer !== null) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
    return;
  }
  row.classList.remove('hidden');
  const remaining = (offAt - (Date.now() + clockOffset)) / 1000;
  text.textContent =
    remaining > 0
      ? `Light turns off in ${formatCountdown(remaining)}`
      : 'Switching the light off...';
  if (countdownTimer === null) {
    countdownTimer = window.setInterval(renderCountdown, COUNTDOWN_MS);
  }
}

async function call(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<LightTimerResponse | null> {
  if (state.authRequired && !state.authToken) return null;
  try {
    const result = await apiRequestWithMetadata<LightTimerResponse>(path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!result.data.success) {
      showToast(result.data.error || 'Light timer request failed', 'error');
      return null;
    }
    return result.data;
  } catch (error) {
    console.error('Light timer request failed:', error);
    showToast('Light timer request failed', 'error');
    return null;
  }
}

export async function refreshLightTimer(): Promise<void> {
  if (refreshing || !$('light-timer-content')) return;
  refreshing = true;
  lastRefresh = Date.now();
  try {
    const data = await call('/api/light-timer', 'GET');
    if (data) render(data);
  } finally {
    refreshing = false;
  }
}

async function update(path: string, body: unknown, message?: string): Promise<void> {
  editingUntil = Date.now() + 1500;
  const data = await call(path, 'POST', body);
  editingUntil = 0;
  if (data) {
    render(data);
    if (message) showToast(message, 'success');
  } else {
    void refreshLightTimer();
  }
}

function handleStatus(_status: PrinterStatus): void {
  // Status updates arrive every few seconds; piggyback on them for a slow refresh.
  if (Date.now() - lastRefresh >= REFRESH_MS) void refreshLightTimer();
}

export function setupLightTimer(): void {
  onStatusUpdate(handleStatus);

  // The grid re-creates panel elements when the layout changes, so listen at the
  // document level instead of binding to elements that may be replaced.
  document.addEventListener('change', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.id?.startsWith('light-timer-')) return;
    if (target.id === 'light-timer-daily-enabled') {
      void update(
        '/api/light-timer',
        { dailyOff: { enabled: (target as HTMLInputElement).checked } },
        (target as HTMLInputElement).checked ? 'Daily auto-off on' : 'Daily auto-off off'
      );
    } else if (target.id === 'light-timer-daily-time') {
      const value = (target as HTMLInputElement).value;
      if (/^\d{2}:\d{2}$/.test(value))
        void update('/api/light-timer', { dailyOff: { time: value } }, `Auto-off time ${value}`);
    } else if (target.id === 'light-timer-skip') {
      void update('/api/light-timer', { skipWhilePrinting: (target as HTMLInputElement).checked });
    }
  });

  document.addEventListener('click', (event) => {
    const element = event.target as HTMLElement | null;
    const quick = element?.closest('[data-off-in]') as HTMLElement | null;
    if (quick) {
      const minutes = Number(quick.dataset.offIn);
      if (Number.isInteger(minutes)) {
        void update(
          '/api/light-timer/off-in',
          { minutes },
          `Light turns off in ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`}`
        );
      }
      return;
    }
    if (element?.closest('#light-timer-cancel')) {
      void update('/api/light-timer/cancel', {}, 'Timer cancelled');
    }
  });
}
