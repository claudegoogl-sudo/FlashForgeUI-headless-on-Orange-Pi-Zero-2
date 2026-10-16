/**
 * @fileoverview Print speed override control (Creator 5 series).
 *
 * A slider in the Job Progress panel, like the speed setting on the printer's
 * touchscreen: 100 % = as sliced. The slider only shows the printer's value while
 * the user is not dragging and for a few seconds after a change is sent, so the
 * old value reported by the next status update does not snap it back.
 * Server side: POST /api/printer/control/speed (printer-control-routes.ts).
 */

import type { PrinterStatus } from '../app.js';
import { state } from '../core/AppState.js';
import { apiRequestWithMetadata, onStatusUpdate } from '../core/Transport.js';
import { $, showToast } from '../shared/dom.js';

const SPEED_MIN = 50;
const SPEED_MAX = 200;
const SPEED_DEFAULT = 100;
/** How long a just-sent value is kept on screen before the reported one takes over. */
const SETTLE_MS = 6000;

let dragging = false;
let settleUntil = 0;
let sending = false;

export function clampSpeed(value: number): number {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(value)));
}

function sliderValue(): number {
  const slider = $('speed-slider') as HTMLInputElement | null;
  return slider ? clampSpeed(Number(slider.value)) : SPEED_DEFAULT;
}

function showValue(text: string): void {
  const label = $('speed-value');
  if (label) label.textContent = text;
}

function applyStatus(status: PrinterStatus): void {
  const row = $('speed-row');
  if (!row) return;

  const supported = Boolean(state.printerFeatures?.hasMultiTool);
  row.classList.toggle('hidden', !supported);
  if (!supported) return;

  const printerState = (status.printerState || '').toLowerCase();
  const active = printerState === 'printing' || printerState === 'paused';
  const slider = $('speed-slider') as HTMLInputElement | null;
  const reset = $('speed-reset') as HTMLButtonElement | null;
  if (slider) slider.disabled = !active;
  if (reset) reset.disabled = !active;

  if (!active) {
    showValue('--');
    return;
  }
  if (dragging || Date.now() < settleUntil) return;

  const reported = status.printSpeed;
  if (reported === undefined || !Number.isFinite(reported)) {
    showValue('--');
    return;
  }
  if (slider) slider.value = String(clampSpeed(reported));
  showValue(`${Math.round(reported)} %`);
}

async function sendSpeed(speed: number): Promise<void> {
  if (state.authRequired && !state.authToken) {
    showToast('Not authenticated', 'error');
    return;
  }
  sending = true;
  settleUntil = Date.now() + SETTLE_MS;
  showValue(`${speed} %`);
  try {
    const result = await apiRequestWithMetadata<{
      success: boolean;
      message?: string;
      error?: string;
    }>('/api/printer/control/speed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed }),
    });
    if (result.data.success) {
      showToast(result.data.message || `Print speed set to ${speed} %`, 'success');
    } else {
      settleUntil = 0;
      showToast(result.data.error || 'Could not change the print speed', 'error');
    }
  } catch (error) {
    console.error('Print speed change failed:', error);
    settleUntil = 0;
    showToast('Could not change the print speed', 'error');
  } finally {
    sending = false;
  }
}

export function setupPrintSpeed(): void {
  onStatusUpdate(applyStatus);

  // The grid re-creates panel elements when the layout changes, so listen at the
  // document level instead of binding to elements that may be replaced.
  document.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id !== 'speed-slider') return;
    dragging = true;
    showValue(`${sliderValue()} %`);
  });

  document.addEventListener('change', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id !== 'speed-slider') return;
    dragging = false;
    if (!sending) void sendSpeed(sliderValue());
  });

  document.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest(
      '#speed-reset'
    ) as HTMLButtonElement | null;
    if (!button || button.disabled || sending) return;
    const slider = $('speed-slider') as HTMLInputElement | null;
    if (slider) slider.value = String(SPEED_DEFAULT);
    void sendSpeed(SPEED_DEFAULT);
  });
}
