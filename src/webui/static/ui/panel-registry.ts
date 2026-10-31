/**
 * @fileoverview Panel templates and view slots for the WebUI.
 *
 * Every panel is created once (its element is cached, so feature modules that look
 * elements up by ID keep working) and mounted into the slot of the view it belongs to.
 * The views themselves (Print, Heat, Move, Files, Light) are in index.html; see
 * features/layout-theme.ts for mounting and ui/views for switching.
 */

export interface WebUIPanelTemplate {
  id: string;
  /** Name of the `data-slot` container in index.html that hosts the panel. */
  slot: string;
  html: string;
}

const PANELS: WebUIPanelTemplate[] = [
  {
    id: 'printer-state',
    slot: 'status',
    html: `
      <div class="panel panel-state" id="printer-state-panel" data-state="unknown">
        <h2 class="visually-hidden">Printer</h2>
        <p class="state-main"><span class="state-dot" aria-hidden="true"></span><span id="printer-status">Unknown</span></p>
        <dl class="state-life">
          <div><dt>Lifetime print time</dt><dd id="lifetime-print-time">--</dd></div>
          <div><dt>Lifetime filament</dt><dd id="lifetime-filament">--</dd></div>
        </dl>
      </div>
    `,
  },
  {
    id: 'camera',
    slot: 'stage',
    html: `
      <div class="panel panel-camera" id="camera-panel">
        <h2 class="visually-hidden">Camera</h2>
        <div class="panel-content camera-panel-content" id="camera-container">
          <div id="camera-placeholder" class="no-camera">Camera Unavailable</div>
          <div id="camera-fps-overlay" class="camera-fps-overlay hidden">-- FPS</div>
        </div>
      </div>
    `,
  },
  {
    id: 'gcode-viewer',
    slot: 'stage',
    html: `
      <div class="panel panel-gcode" id="gcode-view-panel">
        <h2 class="visually-hidden">Layer view</h2>
        <div class="panel-content gcode-view-content">
          <div class="gcode-view-stage">
            <canvas id="gcode-view-canvas"></canvas>
            <div id="gcode-view-message" class="gcode-view-message">No active print.</div>
          </div>
          <div id="gcode-view-controls" class="gcode-view-controls hidden">
            <button id="gcode-view-live" class="gcode-view-live active" type="button" title="Follow the print">Live</button>
            <input id="gcode-view-slider" class="gcode-view-slider" type="range" min="1" max="1" value="1" aria-label="Layer">
            <button id="gcode-view-fit" class="gcode-view-live hidden" type="button" title="Switch between fitting the model and everything including the prime tower">Fit: model</button>
            <span id="gcode-view-legend" class="gcode-view-legend"></span>
          </div>
          <div id="gcode-view-info" class="gcode-view-info"></div>
        </div>
      </div>
    `,
  },
  {
    id: 'tool-strip',
    slot: 'print-rail',
    html: `
      <div class="panel panel-tools" id="tool-strip-panel">
        <h2 class="visually-hidden">Tool temperatures</h2>
        <div class="tool-strip" id="tool-strip"></div>
      </div>
    `,
  },
  {
    id: 'job-progress',
    slot: 'print-rail',
    html: `
      <div class="panel panel-job" id="job-progress-panel">
        <h2 class="visually-hidden">Job</h2>
        <p class="job-name"><span class="visually-hidden">Current job: </span><span id="current-job">No active job</span></p>
        <div class="progress-top">
          <span id="progress-percentage" class="progress-number">0%</span>
          <p class="progress-meta">
            <span>Layer <b id="layer-info">-- / --</b></span>
            <b id="time-remaining">--</b>
          </p>
        </div>
        <div id="progress-bar" class="bar" role="progressbar" aria-label="Job progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
        <dl class="job-facts">
          <div><dt>Elapsed</dt><dd id="elapsed-time">--:--</dd></div>
          <div><dt>Weight</dt><dd id="job-weight">--</dd></div>
          <div><dt>Length</dt><dd id="job-length">--</dd></div>
        </dl>
        <div class="speed-row hidden" id="speed-row">
          <label for="speed-slider" class="speed-label">Speed</label>
          <input id="speed-slider" class="speed-slider" type="range" min="50" max="200" step="5" value="100" disabled>
          <span id="speed-value" class="speed-value">--</span>
          <button id="speed-reset" class="speed-reset" type="button" title="Back to the speed as sliced (100 %)" disabled>Reset</button>
        </div>
        <p id="controls-hint" class="ctl-hint"></p>
        <div class="acts">
          <button id="btn-pause" class="control-btn" type="button">Pause</button>
          <button id="btn-resume" class="control-btn" type="button" hidden>Resume</button>
          <button id="btn-clear-status" class="control-btn" type="button" hidden>Clear status</button>
          <button id="btn-cancel" class="control-btn danger" type="button">Cancel print</button>
        </div>
      </div>
    `,
  },
  {
    id: 'model-preview',
    slot: 'print-rail',
    html: `
      <div class="panel panel-preview" id="model-preview-panel">
        <h2 class="visually-hidden">Model preview</h2>
        <div class="panel-content" id="model-preview">
          <div class="no-preview">No preview available</div>
        </div>
      </div>
    `,
  },
  {
    id: 'move-pad',
    slot: 'move-rail',
    html: `
      <div class="panel panel-move" id="move-panel">
        <h2 class="panel-header">Move</h2>
        <p class="move-note" id="move-note">Move controls are not available on the Creator 5. Its firmware has no move command over the network, so the pad stays disabled. Use the touchscreen on the printer.</p>
        <div class="jog">
          <div class="jog-xy" role="group" aria-label="Move X and Y">
            <span></span><button class="control-btn jog-btn" type="button" data-jog="y+" aria-label="Move Y plus" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 6l-6 8h12z"/></svg></button><span></span>
            <button class="control-btn jog-btn" type="button" data-jog="x-" aria-label="Move X minus" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M6 12l8-6v12z"/></svg></button><button id="btn-home-axes" class="control-btn" type="button">Home</button><button class="control-btn jog-btn" type="button" data-jog="x+" aria-label="Move X plus" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M18 12l-8-6v12z"/></svg></button>
            <span></span><button class="control-btn jog-btn" type="button" data-jog="y-" aria-label="Move Y minus" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 18l6-8H6z"/></svg></button><span></span>
          </div>
          <div class="jog-z" role="group" aria-label="Move Z"><button class="control-btn jog-btn" type="button" data-jog="z+" aria-label="Move Z up" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 6l-6 8h12z"/></svg></button><button class="control-btn jog-btn" type="button" data-jog="z-" aria-label="Move Z down" disabled><svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><path d="M12 18l6-8H6z"/></svg></button></div>
        </div>
        <div class="jog-steps" role="group" aria-label="Step size">
          <button class="control-btn" type="button" disabled>0.1 mm</button>
          <button class="control-btn" type="button" disabled aria-pressed="true">1 mm</button>
          <button class="control-btn" type="button" disabled>10 mm</button>
          <button class="control-btn" type="button" disabled>50 mm</button>
        </div>
      </div>
    `,
  },
  {
    id: 'creator5-temperature',
    slot: 'heat-a',
    html: `
      <div class="panel" id="creator5-temp-panel">
        <h2 class="panel-header">Temperature</h2>
        <div class="panel-content">
          <div class="c5-temps-unavailable hidden" id="c5-temps-unavailable">
            Per-tool temperature control is not available for this printer.
          </div>
          <div class="c5-temps-body" id="c5-temps-body">
            <p class="heater-lock hidden" id="c5-heater-lock">Heaters are locked while the printer is printing or busy.</p>
            <div class="c5-tool-grid" id="c5-tool-grid"></div>
            <div class="temp-row" id="c5-bed-row">
              <span class="temp-label">Bed</span>
              <span class="temp-reading" id="c5-bed-temp">--°C / --°C</span>
              <div class="temp-buttons">
                <button class="temp-btn" type="button" data-c5-action="set" data-heater="bed" aria-label="Set bed temperature">Set</button>
                <button class="temp-btn" type="button" data-c5-action="off" data-heater="bed" aria-label="Turn bed heater off">Off</button>
              </div>
            </div>
            <div class="temp-row hidden" id="c5-chamber-row">
              <span class="temp-label">Chamber</span>
              <span class="temp-reading" id="c5-chamber-temp">--°C / --°C</span>
              <div class="temp-buttons">
                <button class="temp-btn" type="button" data-c5-action="set" data-heater="chamber" aria-label="Set chamber temperature">Set</button>
                <button class="temp-btn" type="button" data-c5-action="off" data-heater="chamber" aria-label="Turn chamber heater off">Off</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `,
  },
  {
    id: 'temp-control',
    slot: 'heat-a',
    html: `
      <div class="panel" id="temp-control-panel">
        <h2 class="panel-header">Temperature</h2>
        <div class="panel-content">
          <div class="temp-row">
            <span class="temp-label">Bed</span>
            <span class="temp-reading" id="bed-temp">--°C / --°C</span>
            <div class="temp-buttons">
              <button id="btn-bed-set" class="temp-btn" type="button">Set</button>
              <button id="btn-bed-off" class="temp-btn" type="button">Off</button>
            </div>
          </div>
          <div class="temp-row">
            <span class="temp-label">Extruder</span>
            <span class="temp-reading" id="extruder-temp">--°C / --°C</span>
            <div class="temp-buttons">
              <button id="btn-extruder-set" class="temp-btn" type="button">Set</button>
              <button id="btn-extruder-off" class="temp-btn" type="button">Off</button>
            </div>
          </div>
        </div>
      </div>
    `,
  },
  {
    id: 'ifs-station',
    slot: 'heat-b',
    html: `
      <div class="panel ifs-card" id="ifs-station-panel">
        <h2 class="panel-header">Material station</h2>
        <div class="panel-content">
          <div class="ifs-card-state ifs-card-unavailable hidden">
            <div class="ifs-card-message">Material station not available on this printer</div>
          </div>
          <div class="ifs-card-state ifs-card-disconnected hidden">
            <div class="ifs-card-message">Material station disconnected</div>
          </div>
          <div class="ifs-card-state ifs-card-active hidden">
            <div class="ifs-card-slots">
              <button type="button" class="ifs-card-slot" data-slot="1">
                <span class="ifs-card-swatch"></span>
                <span class="ifs-card-slot-info">
                  <span class="ifs-card-slot-label">Slot 1</span>
                  <span class="ifs-card-slot-material">Empty</span>
                </span>
              </button>
              <button type="button" class="ifs-card-slot" data-slot="2">
                <span class="ifs-card-swatch"></span>
                <span class="ifs-card-slot-info">
                  <span class="ifs-card-slot-label">Slot 2</span>
                  <span class="ifs-card-slot-material">Empty</span>
                </span>
              </button>
              <button type="button" class="ifs-card-slot" data-slot="3">
                <span class="ifs-card-swatch"></span>
                <span class="ifs-card-slot-info">
                  <span class="ifs-card-slot-label">Slot 3</span>
                  <span class="ifs-card-slot-material">Empty</span>
                </span>
              </button>
              <button type="button" class="ifs-card-slot" data-slot="4">
                <span class="ifs-card-swatch"></span>
                <span class="ifs-card-slot-info">
                  <span class="ifs-card-slot-label">Slot 4</span>
                  <span class="ifs-card-slot-material">Empty</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `,
  },
  {
    id: 'filtration-tvoc',
    slot: 'heat-b',
    html: `
      <div class="panel" id="filtration-panel">
        <h2 class="panel-header">Filtration and TVOC</h2>
        <div class="panel-content">
          <div class="filtration-section" id="filtration-section">
            <div class="status-title">Filtration: <span id="filtration-status">Off</span></div>
            <div class="filtration-buttons">
              <button id="btn-external-filtration" class="filtration-btn">External</button>
              <button id="btn-internal-filtration" class="filtration-btn">Internal</button>
              <button id="btn-no-filtration" class="filtration-btn">Off</button>
            </div>
          </div>
          <div class="tvoc-info hidden" id="tvoc-info">
            <div class="status-title">TVOC Level: <span id="tvoc-status">--</span></div>
          </div>
        </div>
      </div>
    `,
  },
  {
    id: 'spoolman-tracker',
    slot: 'heat-b',
    html: `
      <div class="panel" id="spoolman-panel">
        <h2 class="panel-header">Spoolman</h2>
        <div class="panel-content">
          <div id="spoolman-disabled" class="spoolman-state hidden">
            <div class="spoolman-message" id="spoolman-disabled-message">Spoolman integration is disabled</div>
          </div>
          <div id="spoolman-station" class="spoolman-state hidden">
            <div class="spoolman-message" id="spoolman-station-note">Choose a spool for each tool when you match materials for an upload.</div>
            <div class="spool-stats" id="spoolman-station-job"></div>
            <div class="spool-meta" id="spoolman-station-summary"></div>
          </div>
          <div id="spoolman-no-spool" class="spoolman-state hidden">
            <div class="spoolman-message">No spool selected</div>
            <button id="btn-select-spool" class="control-btn">Select Spool</button>
          </div>
          <div id="spoolman-active" class="spoolman-state hidden">
            <div class="spool-info">
              <div class="spool-color-indicator" id="spool-color"></div>
              <div class="spool-details">
                <div class="spool-name" id="spool-name">--</div>
                <div class="spool-meta" id="spool-meta">--</div>
              </div>
            </div>
            <div class="spool-stats">
              <div class="stat-row">
                <span>Remaining:</span>
                <span id="spool-remaining">--</span>
              </div>
            </div>
            <button id="btn-change-spool" class="temp-btn">Change</button>
          </div>
        </div>
      </div>
    `,
  },
  {
    id: 'files-actions',
    slot: 'files-top',
    html: `
      <div class="panel panel-files-actions" id="files-actions-panel">
        <h2 class="visually-hidden">Job actions</h2>
        <div class="fa-row">
          <button id="btn-upload-job" class="control-btn" type="button">Upload job</button>
          <button id="btn-start-recent" class="control-btn" type="button">Recent files</button>
          <button id="btn-start-local" class="control-btn" type="button">Local files</button>
          <button id="btn-refresh" class="control-btn" type="button">Refresh status</button>
        </div>
      </div>
    `,
  },
  {
    id: 'light-timer',
    slot: 'light-a',
    html: `
      <div class="panel" id="light-timer-panel">
        <h2 class="panel-header">Light and timer</h2>
        <div class="panel-content" id="light-timer-content">
          <div class="light-switch" role="group" aria-label="Light">
            <button id="btn-led-on" class="control-btn" type="button" aria-pressed="false">On</button>
            <button id="btn-led-off" class="control-btn" type="button" aria-pressed="false">Off</button>
          </div>
          <div id="light-timer-unsupported" class="light-timer-note hidden">This printer has no controllable light.</div>
          <div id="light-timer-body">
            <div class="light-timer-row">
              <span>Light is <span id="light-timer-state" class="light-timer-state">--</span></span>
              <span id="light-timer-clock" class="light-timer-clock"></span>
            </div>
            <div class="light-timer-row">
              <label class="light-timer-check"><input type="checkbox" id="light-timer-daily-enabled"> Turn off daily at</label>
              <input type="time" id="light-timer-daily-time" class="light-timer-time" value="22:00" aria-label="Daily turn-off time">
            </div>
            <label class="light-timer-check light-timer-sub"><input type="checkbox" id="light-timer-skip"> Not on days when a print is running</label>
            <div class="light-timer-quick" role="group" aria-label="Turn off after">
              <span>Turn off in</span>
              <button type="button" class="light-timer-btn" data-off-in="30">30 min</button>
              <button type="button" class="light-timer-btn" data-off-in="60">1 h</button>
              <button type="button" class="light-timer-btn" data-off-in="120">2 h</button>
              <button type="button" class="light-timer-btn" data-off-in="240">4 h</button>
            </div>
            <div id="light-timer-countdown" class="light-timer-countdown hidden">
              <span id="light-timer-countdown-text"></span>
              <button type="button" id="light-timer-cancel" class="light-timer-btn">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    `,
  },
];

const panelsById = new Map(PANELS.map((panel) => [panel.id, panel]));
const instanceCache = new Map<string, HTMLElement>();

export function getAllComponentIds(): string[] {
  return PANELS.map((panel) => panel.id);
}

export function getPanelSlot(componentId: string): string | undefined {
  return panelsById.get(componentId)?.slot;
}

export function createComponentElement(componentId: string): HTMLElement {
  const cached = instanceCache.get(componentId);
  if (cached) {
    return cached;
  }

  const panel = panelsById.get(componentId);
  if (!panel) {
    throw new Error(`Unknown component: ${componentId}`);
  }

  const wrapper = document.createElement('template');
  wrapper.innerHTML = panel.html.trim();
  const element = wrapper.content.firstElementChild as HTMLElement | null;
  if (!element) {
    throw new Error(`Template missing root element for ${componentId}`);
  }

  element.dataset.componentId = componentId;
  instanceCache.set(componentId, element);
  return element;
}

export const componentRegistry = {
  getAllIds: getAllComponentIds,
  getSlot: getPanelSlot,
  createElement: createComponentElement,
};
