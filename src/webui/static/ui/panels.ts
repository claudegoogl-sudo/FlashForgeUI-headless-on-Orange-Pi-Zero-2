/**
 * @fileoverview UI panel rendering helpers for the WebUI client.
 *
 * Contains pure rendering logic for the header connection indicator, printer
 * status cards, statistics panels, and Spoolman tracker. These functions are
 * stateless aside from reading from the shared AppState container and can be
 * safely reused by WebSocket handlers, layout refresh hooks, or manual refresh
 * actions.
 */

import type { DeductionSummary, PrinterStatus, SpoolmanStationTracking } from '../app.js';
import { state } from '../core/AppState.js';
import { getStationSlot } from '../features/ifs-station.js';
import { isSpoolmanAvailableForCurrentContext } from '../features/layout-theme.js';
import { $, hideElement, setTextContent, showElement } from '../shared/dom.js';
import { tweenNumber } from '../shared/motion.js';
import {
  formatElapsedSeconds,
  formatLifetimeFilament,
  formatLifetimePrintTime,
  formatTime,
} from '../shared/formatting.js';

let hasBeenConnected = false;

export function updateConnectionStatus(connected: boolean): void {
  hasBeenConnected = hasBeenConnected || connected;
  const indicator = $('connection-indicator');
  const text = $('connection-text');

  if (indicator) {
    if (connected) {
      indicator.classList.add('connected');
    } else {
      indicator.classList.remove('connected');
    }
  }

  if (text) {
    text.textContent = connected ? 'Connected' : 'Disconnected';
  }

  indicator?.closest('.connection-status')?.setAttribute('data-connected', String(connected));
  const stale = hasBeenConnected && !connected;
  $('connection-banner')?.classList.toggle('hidden', !stale);
  $('main-content')?.toggleAttribute('data-stale', stale);
  if (stale) {
    // The next status update after reconnecting re-enables what the printer state allows.
    document
      .querySelectorAll<HTMLButtonElement>(
        '.acts button, .fa-row button, .light-switch button, .temp-btn, .filtration-btn'
      )
      .forEach((button) => {
        button.disabled = true;
        button.title = 'Not connected to the WebUI server';
      });
  }
}

$('connection-reload')?.addEventListener('click', () => window.location.reload());

export function updatePrinterStatus(status: PrinterStatus | null): void {
  if (!status) {
    updatePrinterStateCard(null);
    setTextContent('bed-temp', '--°C / --°C');
    setTextContent('extruder-temp', '--°C / --°C');
    setTextContent('current-job', 'No data');
    setProgress(0);
    updateModelPreview(null);
    updateCreator5TemperatureCard(null);
    updateToolStrip(null);
    return;
  }

  state.printerStatus = status;
  updatePrinterStateCard(status);

  const bedTemp = Number.isNaN(status.bedTemperature) ? 0 : Math.round(status.bedTemperature);
  const bedTarget = Number.isNaN(status.bedTargetTemperature)
    ? 0
    : Math.round(status.bedTargetTemperature);
  const extruderTemp = Number.isNaN(status.nozzleTemperature)
    ? 0
    : Math.round(status.nozzleTemperature);
  const extruderTarget = Number.isNaN(status.nozzleTargetTemperature)
    ? 0
    : Math.round(status.nozzleTargetTemperature);

  setTextContent('bed-temp', `${bedTemp}°C / ${bedTarget}°C`);
  setTextContent('extruder-temp', `${extruderTemp}°C / ${extruderTarget}°C`);

  if (status.jobName) {
    setTextContent('current-job', status.jobName);

    const progress = Number.isNaN(status.progress) ? 0 : status.progress;
    const progressPercent = progress <= 1 ? Math.round(progress * 100) : Math.round(progress);
    setProgress(progressPercent);

    if (
      status.currentLayer !== undefined &&
      status.totalLayers !== undefined &&
      !Number.isNaN(status.currentLayer) &&
      !Number.isNaN(status.totalLayers)
    ) {
      setTextContent('layer-info', `${status.currentLayer} / ${status.totalLayers}`);
    } else {
      setTextContent('layer-info', '-- / --');
    }

    if (status.elapsedTimeSeconds !== undefined && !Number.isNaN(status.elapsedTimeSeconds)) {
      setTextContent('elapsed-time', formatElapsedSeconds(status.elapsedTimeSeconds));
    } else if (status.timeElapsed !== undefined && !Number.isNaN(status.timeElapsed)) {
      setTextContent('elapsed-time', formatTime(status.timeElapsed));
    } else {
      setTextContent('elapsed-time', '--:--');
    }

    // The library sets completionTime to null while the print is not advancing,
    // so the time left is only shown while the job really counts down.
    setTextContent('time-remaining', formatTimeLeft(status));

    if (status.estimatedWeight !== undefined && !Number.isNaN(status.estimatedWeight)) {
      setTextContent('job-weight', `${Math.round(status.estimatedWeight)}g`);
    } else {
      setTextContent('job-weight', '--');
    }

    if (status.estimatedLength !== undefined && !Number.isNaN(status.estimatedLength)) {
      setTextContent('job-length', `${status.estimatedLength.toFixed(1)}m`);
    } else {
      setTextContent('job-length', '--');
    }

    updateModelPreview(status.thumbnailData);
  } else {
    setTextContent('current-job', 'No active job');
    setProgress(0);
    setTextContent('layer-info', '-- / --');
    setTextContent('elapsed-time', '--:--');
    setTextContent('time-remaining', '--');
    setTextContent('job-weight', '--');
    setTextContent('job-length', '--');
    updateModelPreview(null);
  }

  updateButtonStates(status.printerState || 'Unknown');
  updateFiltrationStatus(status.filtrationMode);
  updateCreator5TemperatureCard(status);
  updateToolStrip(status);
  updateTvocDisplay(status);
}

/** Dark or light text colour, whichever reads better on a filament colour field. */
function readableOn(hex: string): string {
  const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
  if (Number.isNaN(value)) {
    return '#12171b';
  }
  const channel = (shift: number) => {
    const v = ((value >> shift) & 0xff) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  // contrast with white is 1.05 / (L + 0.05); with the dark text (L about 0.008) it is (L + 0.05) / 0.058
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.058 ? '#ffffff' : '#12171b';
}

/** Show the job percent (eased) and fill the dimension-line bar. */
function setProgress(percent: number): void {
  const label = $('progress-percentage');
  if (label) {
    tweenNumber(label, percent, (value) => `${Math.round(value)}%`);
  }
  const bar = $('progress-bar');
  if (bar) {
    bar.style.setProperty('--pn', String(Math.min(100, Math.max(0, percent)) / 100));
    bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  }
}

/** "53 min left" or "1 h 05 min left"; "--" while the print is not advancing. */
function formatTimeLeft(status: PrinterStatus): string {
  const minutes = status.timeRemaining;
  if (!status.completionTime || minutes === undefined || Number.isNaN(minutes) || minutes <= 0) {
    return '--';
  }
  const rounded = Math.round(minutes);
  if (rounded < 60) {
    return `${rounded} min left`;
  }
  return `${Math.floor(rounded / 60)} h ${String(rounded % 60).padStart(2, '0')} min left`;
}

const TOOL_MAX_C = 300;
const BED_MAX_C = 120;
const CHAMBER_MAX_C = 80;

/** Rounded reading, 0 for NaN. */
function roundTemp(value: number): number {
  return Number.isNaN(value) ? 0 : Math.round(value);
}

/**
 * Render one heater reading: the current temperature large, the target beside it,
 * and a dimension line (filled to the current value, tick at the target).
 */
function renderReading(
  element: HTMLElement | null,
  current: number,
  target: number,
  max: number
): void {
  if (!element) {
    return;
  }
  const c = roundTemp(current);
  const t = roundTemp(target);

  let now = element.querySelector<HTMLElement>('.temp-now');
  let goal = element.querySelector<HTMLElement>('.temp-goal');
  if (!now || !goal) {
    element.textContent = '';
    now = document.createElement('span');
    now.className = 'temp-now';
    const unit = document.createElement('span');
    unit.className = 'temp-unit';
    unit.textContent = '°C';
    goal = document.createElement('span');
    goal.className = 'temp-goal';
    element.append(now, unit, goal);
  }

  tweenNumber(now, c);
  goal.textContent = t > 0 ? `target ${t}°C` : 'off';
  element.setAttribute('aria-label', t > 0 ? `${c} °C, target ${t} °C` : `${c} °C, heater off`);

  const clamp = (value: number) => Math.min(100, Math.max(0, (value / max) * 100));
  element.style.setProperty('--now', `${clamp(c)}%`);
  element.style.setProperty('--goal', `${clamp(t)}%`);
  element.classList.toggle('has-goal', t > 0);
}

/** Give a tool tile the filament colour of its material-station slot. */
function applyToolColor(
  tile: HTMLElement | null,
  materialEl: HTMLElement | null,
  toolNumber: number
): void {
  const slot = getStationSlot(toolNumber);
  if (tile) {
    if (slot) {
      tile.style.setProperty('--tool-color', slot.color);
      tile.style.setProperty('--on-tool', readableOn(slot.color));
    } else {
      tile.style.removeProperty('--tool-color');
      tile.style.removeProperty('--on-tool');
    }
    tile.classList.toggle('has-filament', Boolean(slot));
  }
  if (materialEl) {
    materialEl.textContent = slot?.material ?? '';
  }
}

/** Read-only tool temperatures for the Print screen. */
export function updateToolStrip(status: PrinterStatus | null): void {
  const strip = $('tool-strip');
  if (!strip) {
    return;
  }
  const toolTemps = status?.toolTemps ?? [];
  $('tool-strip-panel')?.classList.toggle('hidden', toolTemps.length === 0);

  if (strip.querySelectorAll('.strip-tile').length !== toolTemps.length) {
    strip.innerHTML = toolTemps
      .map(
        (_, i) => `
      <div class="tool-tile strip-tile" data-strip-tile="${i}">
        <div class="tool-head"><span class="tool-name">T${i + 1}</span><span class="tool-material" data-strip-material="${i}"></span></div>
        <div class="temp-reading" data-strip-reading="${i}" role="group"></div>
      </div>`
      )
      .join('');
  }
  toolTemps.forEach((tool, i) => {
    renderReading(
      strip.querySelector<HTMLElement>(`[data-strip-reading="${i}"]`),
      tool.current,
      tool.target,
      TOOL_MAX_C
    );
    applyToolColor(
      strip.querySelector<HTMLElement>(`[data-strip-tile="${i}"]`),
      strip.querySelector<HTMLElement>(`[data-strip-material="${i}"]`),
      i + 1
    );
  });
}

/** Whether heater Set/Off controls should be disabled for the given printer state. */
function isHeaterControlDisabled(printerState: string): boolean {
  const isPrintingActive =
    printerState === 'Printing' ||
    printerState === 'Paused' ||
    printerState === 'Calibrating' ||
    printerState === 'Heating' ||
    printerState === 'Pausing';
  const isBusy = printerState === 'Busy' || printerState === 'Error';
  return isPrintingActive || isBusy;
}

/**
 * Render the Creator 5 multi-tool temperature card (per-tool heaters + bed +
 * chamber). Self-gates: shows an "unavailable" message when the printer does not
 * report per-tool temperatures. No-ops when the card is not mounted (non-C5).
 */
export function updateCreator5TemperatureCard(status: PrinterStatus | null): void {
  const panel = document.querySelector<HTMLElement>('[data-component-id="creator5-temperature"]');
  if (!panel) {
    return;
  }

  const unavailable = $('c5-temps-unavailable');
  const body = $('c5-temps-body');
  const toolGrid = $('c5-tool-grid');
  const chamberRow = $('c5-chamber-row');

  const toolTemps = status?.toolTemps ?? [];
  const available = Boolean(status) && toolTemps.length > 0;

  unavailable?.classList.toggle('hidden', available);
  body?.classList.toggle('hidden', !available);

  if (!available || !status) {
    return;
  }

  // Rebuild the per-tool rows only when the tool count changes.
  if (toolGrid) {
    const existingTiles = toolGrid.querySelectorAll('.tool-tile').length;
    if (existingTiles !== toolTemps.length) {
      toolGrid.innerHTML = toolTemps
        .map(
          (_, i) => `
        <div class="tool-tile" data-tool-tile="${i}">
          <div class="tool-head">
            <span class="tool-name">T${i + 1}</span>
            <span class="tool-material" data-tool-material="${i}"></span>
          </div>
          <div class="c5-tool-reading temp-reading" data-tool-reading="${i}" role="group"></div>
          <div class="temp-buttons">
            <button class="temp-btn" type="button" data-c5-action="set" data-heater="tool" data-tool="${i}" aria-label="Set T${i + 1} temperature">Set</button>
            <button class="temp-btn" type="button" data-c5-action="off" data-heater="tool" data-tool="${i}" aria-label="Turn T${i + 1} heater off">Off</button>
          </div>
        </div>`
        )
        .join('');
    }
    toolTemps.forEach((tool, i) => {
      renderReading(
        toolGrid.querySelector<HTMLElement>(`[data-tool-reading="${i}"]`),
        tool.current,
        tool.target,
        TOOL_MAX_C
      );

      // Tool N prints from material station slot N: show that slot's filament.
      applyToolColor(
        toolGrid.querySelector<HTMLElement>(`[data-tool-tile="${i}"]`),
        toolGrid.querySelector<HTMLElement>(`[data-tool-material="${i}"]`),
        i + 1
      );
    });
  }

  renderReading($('c5-bed-temp'), status.bedTemperature, status.bedTargetTemperature, BED_MAX_C);

  // The Creator 5 reports about -100 °C when it has no chamber sensor; show the row only
  // for a plausible reading.
  const chamber = status.chamberTemperature;
  const hasChamber =
    Boolean(status.hasChamberControl) &&
    chamber !== undefined &&
    !Number.isNaN(chamber) &&
    chamber >= 0;
  chamberRow?.classList.toggle('hidden', !hasChamber);
  if (hasChamber) {
    renderReading(
      $('c5-chamber-temp'),
      chamber,
      status.chamberTargetTemperature ?? 0,
      CHAMBER_MAX_C
    );
  }

  const disabled = isHeaterControlDisabled(status.printerState || 'Unknown');
  body?.classList.toggle('heaters-locked', disabled);
  $('c5-heater-lock')?.classList.toggle('hidden', !disabled);
  panel.querySelectorAll<HTMLButtonElement>('button[data-c5-action]').forEach((btn) => {
    btn.disabled = disabled;
    btn.title = disabled ? 'Heaters are locked while the printer is printing or busy' : '';
  });
}

/**
 * Populate the read-only TVOC air-quality reading and gate the filtration
 * controls. Every printer that mounts this card (filtration-capable printers and
 * the Creator 5 Pro) shows both its filtration mode/controls and its TVOC level.
 * The Creator 5 Pro reports TVOC but cannot switch filtration modes, so its
 * control buttons are shown but disabled.
 */
export function updateTvocDisplay(status: PrinterStatus | null): void {
  const tvocInfo = $('tvoc-info');
  const filtrationSection = $('filtration-section');
  if (!tvocInfo && !filtrationSection) {
    return;
  }

  // The card itself is only mounted for filtration-capable printers or the
  // Creator 5 Pro (see layout-theme component gating), so whenever it exists we
  // show both the filtration controls and the TVOC readout together.
  filtrationSection?.classList.remove('hidden');
  tvocInfo?.classList.remove('hidden');

  const tvoc = status?.tvocLevel;
  setTextContent(
    'tvoc-status',
    tvoc !== undefined && !Number.isNaN(tvoc) ? `${Math.round(tvoc)}` : '--'
  );

  // The Creator 5 Pro exposes a TVOC sensor but no filtration-mode control.
  const isCreator5Pro = Boolean(state.printerFeatures?.isCreator5Pro);
  for (const id of ['btn-external-filtration', 'btn-internal-filtration', 'btn-no-filtration']) {
    const btn = $(id) as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = isCreator5Pro;
    }
  }
}

export function updateFiltrationStatus(mode?: 'external' | 'internal' | 'none'): void {
  if (!mode) {
    return;
  }

  const filtrationStatusEl = $('filtration-status');
  if (filtrationStatusEl) {
    const modeLabels: Record<typeof mode, string> = {
      external: 'External',
      internal: 'Internal',
      none: 'Off',
    };
    filtrationStatusEl.textContent = modeLabels[mode] || 'Off';
  }

  const externalBtn = $('btn-external-filtration') as HTMLButtonElement | null;
  const internalBtn = $('btn-internal-filtration') as HTMLButtonElement | null;
  const offBtn = $('btn-no-filtration') as HTMLButtonElement | null;

  externalBtn?.classList.remove('active');
  internalBtn?.classList.remove('active');
  offBtn?.classList.remove('active');

  switch (mode) {
    case 'external':
      externalBtn?.classList.add('active');
      break;
    case 'internal':
      internalBtn?.classList.add('active');
      break;
    case 'none':
      offBtn?.classList.add('active');
      break;
  }
}

export function updateModelPreview(thumbnailData?: string | null): void {
  const previewContainer = document.querySelector<HTMLElement>(
    '[data-component-id="model-preview"] .panel-content'
  );
  if (!previewContainer) {
    return;
  }

  if (thumbnailData) {
    previewContainer.innerHTML = '';

    const img = document.createElement('img');
    const imageUrl = thumbnailData.startsWith('data:image/')
      ? thumbnailData
      : `data:image/png;base64,${thumbnailData}`;

    img.src = imageUrl;
    img.alt = 'Model preview';
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.display = 'block';

    img.onerror = () => {
      console.error('Failed to load model preview. Image URL length:', imageUrl.length);
      previewContainer.innerHTML = '<div class="no-preview">Preview load failed</div>';
    };

    previewContainer.appendChild(img);
    return;
  }

  previewContainer.innerHTML = '<div class="no-preview">No preview available</div>';
}

export function updateSpoolmanPanelState(): void {
  const disabled = $('spoolman-disabled');
  const noSpool = $('spoolman-no-spool');
  const active = $('spoolman-active');
  const station = $('spoolman-station');

  if (!disabled || !noSpool || !active) {
    return;
  }

  // Material-station contexts: per-job tracking view instead of the
  // single active-spool view.
  if (station && state.spoolmanConfig?.station) {
    hideElement('spoolman-disabled');
    hideElement('spoolman-no-spool');
    hideElement('spoolman-active');
    showElement('spoolman-station');
    renderStationTracking(state.spoolmanConfig.station);
    return;
  }
  hideElement('spoolman-station');

  if (!isSpoolmanAvailableForCurrentContext()) {
    showElement('spoolman-disabled');
    hideElement('spoolman-no-spool');
    hideElement('spoolman-active');

    const disabledMessage = $('spoolman-disabled-message');
    if (disabledMessage) {
      const reason =
        state.spoolmanConfig?.disabledReason ||
        (state.spoolmanConfig?.enabled
          ? 'Spoolman is not available for this printer'
          : 'Spoolman integration is disabled');
      disabledMessage.textContent = reason;
    }
    return;
  }

  if (!state.activeSpool) {
    hideElement('spoolman-disabled');
    showElement('spoolman-no-spool');
    hideElement('spoolman-active');
    return;
  }

  hideElement('spoolman-disabled');
  hideElement('spoolman-no-spool');
  showElement('spoolman-active');

  const colorIndicator = $('spool-color');
  const spoolName = $('spool-name');
  const spoolMeta = $('spool-meta');
  const spoolRemaining = $('spool-remaining');

  if (colorIndicator) {
    colorIndicator.style.backgroundColor = state.activeSpool.colorHex;
  }

  if (spoolName) {
    spoolName.textContent = state.activeSpool.name;
  }

  if (spoolMeta) {
    const parts = [];
    if (state.activeSpool.vendor) {
      parts.push(state.activeSpool.vendor);
    }
    if (state.activeSpool.material) {
      parts.push(state.activeSpool.material);
    }
    spoolMeta.textContent = parts.join(' • ') || '--';
  }

  if (spoolRemaining) {
    const remaining =
      state.spoolmanConfig?.updateMode === 'weight'
        ? `${state.activeSpool.remainingWeight.toFixed(0)}g`
        : `${(state.activeSpool.remainingLength / 1000).toFixed(1)}m`;
    spoolRemaining.textContent = remaining;
  }
}

/**
 * Render the per-job tracking view for material-station contexts: the
 * explanation, the job tracked now with its spool per tool, and the last
 * deduction summary.
 */
function renderStationTracking(station: SpoolmanStationTracking): void {
  const note = $('spoolman-station-note');
  if (note) {
    note.textContent = station.note;
  }

  const jobView = $('spoolman-station-job');
  if (jobView) {
    jobView.textContent = '';
    const job = station.activeJob;
    if (!job) {
      jobView.appendChild(createStatRow('Tracked print:', 'None'));
    } else {
      const progress = job.started
        ? job.lastProgress !== null
          ? `${Math.round(job.lastProgress)}%`
          : 'printing'
        : 'waiting to start';
      jobView.appendChild(createStatRow('Tracked print:', `${job.fileName} (${progress})`));
      for (const tool of job.tools) {
        const estimate = tool.usedG !== null ? ` · ${tool.usedG.toFixed(1)} g` : '';
        jobView.appendChild(
          createStatRow(
            `Tool ${tool.toolId + 1} (slot ${tool.slotId}):`,
            `Spool #${tool.spoolId}${estimate}`
          )
        );
      }
    }
  }

  const summary = $('spoolman-station-summary');
  if (summary) {
    summary.textContent = describeDeduction(station.lastDeduction);
  }
}

function createStatRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const labelEl = document.createElement('span');
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

function describeDeduction(deduction: DeductionSummary | null): string {
  if (!deduction) {
    return 'No deduction recorded this session.';
  }
  const ending: Record<DeductionSummary['terminal'], string> = {
    completed: 'completed',
    cancelled: 'was cancelled',
    error: 'stopped with an error',
    interrupted: 'ended while the app was not watching',
  };
  const approximate = deduction.approximate ? ' (approximate)' : '';
  const charged = deduction.tools
    .filter((tool) => tool.status === 'deducted' && tool.amount !== null)
    .map((tool) => `#${tool.spoolId} ${tool.amount}${tool.mode === 'weight' ? ' g' : ' mm'}`)
    .join(', ');
  return (
    `${deduction.fileName} ${ending[deduction.terminal]} at ${Math.round(deduction.progress)}%${approximate}: ` +
    `${deduction.deductedCount} spool(s) charged` +
    (charged ? ` (${charged})` : '') +
    (deduction.skippedCount > 0 ? `, ${deduction.skippedCount} skipped` : '')
  );
}

/** One line that says why some controls are unavailable right now. */
function describeControlsState(printerState: string, ready: boolean, busy: boolean): string {
  if (printerState === 'Paused' || printerState === 'Pausing') {
    return 'The job is paused. Resume it or cancel it.';
  }
  if (printerState === 'Error') {
    return 'The printer reports an error. Fix it on the printer, then select Clear status.';
  }
  if (busy) {
    return 'The printer is busy.';
  }
  if (ready && printerState !== 'Ready') {
    return 'The last job is finished. Clear the plate on the printer before the next job.';
  }
  return '';
}

function updateButtonStates(printerState: string): void {
  const isPrintingActive =
    printerState === 'Printing' ||
    printerState === 'Paused' ||
    printerState === 'Calibrating' ||
    printerState === 'Heating' ||
    printerState === 'Pausing';

  const isReadyForNewJob =
    printerState === 'Ready' || printerState === 'Completed' || printerState === 'Cancelled';

  const canControlJob =
    printerState === 'Printing' ||
    printerState === 'Paused' ||
    printerState === 'Heating' ||
    printerState === 'Calibrating';

  const isBusy = printerState === 'Busy' || printerState === 'Error';

  const pauseBtn = $('btn-pause') as HTMLButtonElement | null;
  const resumeBtn = $('btn-resume') as HTMLButtonElement | null;
  const cancelBtn = $('btn-cancel') as HTMLButtonElement | null;

  // One job button at a time: Resume replaces Pause while the print is paused.
  if (pauseBtn) {
    pauseBtn.hidden = printerState === 'Paused';
    pauseBtn.disabled = printerState !== 'Printing';
    pauseBtn.title = pauseBtn.disabled ? 'Available while a job is printing' : '';
  }
  if (resumeBtn) {
    resumeBtn.hidden = printerState !== 'Paused';
    resumeBtn.disabled = printerState !== 'Paused';
  }
  if (cancelBtn) {
    cancelBtn.disabled = !canControlJob;
    cancelBtn.title = cancelBtn.disabled ? 'No job to cancel' : '';
  }

  const recentBtn = $('btn-start-recent') as HTMLButtonElement | null;
  const localBtn = $('btn-start-local') as HTMLButtonElement | null;
  const homeAxesBtn = $('btn-home-axes') as HTMLButtonElement | null;

  // Creator 5 series: the printer lists only file names (no tool data), so a file
  // already on the printer cannot go through material matching. It can still be
  // started as sliced (tool N prints from slot N); job-control confirms that first.
  const isCreator5Series = Boolean(state.printerFeatures?.hasMultiTool);
  const RESIDENT_JOB_HINT =
    'Starts as sliced: tool N prints from slot N. Use Upload job or Library to match materials.';
  if (recentBtn) {
    recentBtn.disabled = !isReadyForNewJob;
    recentBtn.title = isCreator5Series ? RESIDENT_JOB_HINT : '';
  }
  if (localBtn) {
    localBtn.disabled = !isReadyForNewJob;
    localBtn.title = isCreator5Series ? RESIDENT_JOB_HINT : '';
  }
  // Uploading a fresh file works on every model, Creator 5 series included -
  // the 3mf is parsed here, so material mappings are available on upload even
  // where the resident-job lists are not.
  const uploadJobBtn = $('btn-upload-job') as HTMLButtonElement | null;
  if (uploadJobBtn) {
    uploadJobBtn.disabled = !isReadyForNewJob;
  }
  // Home Axes (~G28) is a raw G-code command. HTTP-only printers (Creator 5
  // series) expose no TCP/G-code passthrough, so disable the button while printing
  // OR when the active printer explicitly reports G-code commands unavailable.
  const gcodeUnavailable = state.printerFeatures?.gcodeCommands?.available === false;
  if (homeAxesBtn) homeAxesBtn.disabled = isPrintingActive || gcodeUnavailable;
  const clearStatusBtn = $('btn-clear-status') as HTMLButtonElement | null;
  if (clearStatusBtn) {
    clearStatusBtn.disabled = isPrintingActive;
    clearStatusBtn.title = isPrintingActive ? 'Not available during a job' : '';
  }
  if (homeAxesBtn) {
    homeAxesBtn.title = isPrintingActive
      ? 'Not available during a job'
      : gcodeUnavailable
        ? 'The Creator 5 firmware has no home command over the network'
        : '';
  }
  if (uploadJobBtn) {
    uploadJobBtn.title = uploadJobBtn.disabled
      ? 'Available when the printer is ready for a new job'
      : '';
  }

  const hint = $('controls-hint');
  if (hint) {
    hint.textContent = describeControlsState(printerState, isReadyForNewJob, isBusy);
    hint.dataset.tone = printerState === 'Error' ? 'danger' : '';
  }
  // Clear status is only offered when there is something to clear.
  if (clearStatusBtn) {
    clearStatusBtn.hidden = !(
      printerState === 'Error' ||
      printerState === 'Completed' ||
      printerState === 'Cancelled'
    );
  }

  const bedSetBtn = $('btn-bed-set') as HTMLButtonElement | null;
  const bedOffBtn = $('btn-bed-off') as HTMLButtonElement | null;
  const extruderSetBtn = $('btn-extruder-set') as HTMLButtonElement | null;
  const extruderOffBtn = $('btn-extruder-off') as HTMLButtonElement | null;

  const tempButtonsDisabled = isPrintingActive || isBusy;
  if (bedSetBtn) bedSetBtn.disabled = tempButtonsDisabled;
  if (bedOffBtn) bedOffBtn.disabled = tempButtonsDisabled;
  if (extruderSetBtn) extruderSetBtn.disabled = tempButtonsDisabled;
  if (extruderOffBtn) extruderOffBtn.disabled = tempButtonsDisabled;
}

function updatePrinterStateCard(status: PrinterStatus | null): void {
  if (status?.printerState) {
    setTextContent('printer-status', status.printerState);
  } else {
    setTextContent('printer-status', 'Unknown');
  }
  $('printer-state-panel')?.setAttribute(
    'data-state',
    (status?.printerState || 'unknown').toLowerCase()
  );

  if (status?.cumulativePrintTime !== undefined) {
    const formattedTime = formatLifetimePrintTime(status.cumulativePrintTime);
    setTextContent('lifetime-print-time', formattedTime);
  } else {
    setTextContent('lifetime-print-time', '--');
  }

  if (status?.cumulativeFilament !== undefined) {
    const formattedFilament = formatLifetimeFilament(status.cumulativeFilament);
    setTextContent('lifetime-filament', formattedFilament);
  } else {
    setTextContent('lifetime-filament', '--');
  }
}

// Tool tiles take their colour from the material station; redraw them when it reports.
document.addEventListener('station-updated', () => {
  updateCreator5TemperatureCard(state.printerStatus ?? null);
});
