/**
 * @fileoverview Live G-code viewer panel.
 *
 * Draws the layer that is being printed (plus the layer below as a ghost) on a
 * canvas and marks the nozzle position. The position comes from the print
 * progress: FlashForge firmware reports progress as the fraction of the job file
 * that has been read, so `progress x file size` is a byte offset, and every
 * segment the server returns carries the offset of the G-code line that draws it.
 * Between status updates the offset is advanced at the recently observed rate so
 * the marker moves instead of jumping.
 *
 * The G-code is only available for jobs the WebUI host has a copy of (job library
 * or Upload Job); otherwise the panel explains how to get one.
 * Server side: src/webui/server/routes/gcode-view-routes.ts.
 */

import type { PrinterStatus } from '../app.js';
import { state } from '../core/AppState.js';
import { apiRequestWithMetadata, onStatusUpdate } from '../core/Transport.js';
import { $ } from '../shared/dom.js';

interface LayerInfo {
  z: number;
  start: number;
  end: number;
}

interface ViewMeta {
  fileName: string;
  size: number;
  layers: LayerInfo[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  /** Bounds without the prime tower, when the file labels it. */
  modelBounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  tools: number[];
  colors: string[];
}

interface ViewPath {
  t: number;
  /** 1 = prime tower */
  w?: 1;
  p: number[];
  o: number[];
}

interface LayerPaths {
  z: number;
  start: number;
  end: number;
  paths: ViewPath[];
}

interface MetaResponse extends Partial<ViewMeta> {
  success: boolean;
  error?: string;
}

interface LayerResponse extends Partial<LayerPaths> {
  success: boolean;
  error?: string;
}

const FALLBACK_COLORS = ['#4C9BE8', '#F2A33A', '#5CC689', '#E0607E', '#B58AF2', '#58C7D0'];
const ACTIVE_STATES = new Set(['printing', 'paused', 'pausing', 'heating', 'busy']);
const MAX_CACHED_LAYERS = 24;
const MAX_LEAD_SECONDS = 4;
const REDRAW_INTERVAL_MS = 100;

let jobName: string | null = null;
let meta: ViewMeta | null = null;
let message = 'No active print.';
let live = true;
let scrubLayer = 1;
/** Fit the view to the model (prime tower may be off-canvas) or to everything. */
let fitModel = true;

let sampleOffset = 0;
let sampleTime = 0;
let bytesPerSecond = 0;
let printing = false;

const layerCache = new Map<number, LayerPaths>();
const layerRequests = new Set<number>();
let frameRequested = false;
let lastDraw = 0;
let observedCanvas: HTMLCanvasElement | null = null;
let resizeObserver: ResizeObserver | null = null;

/** Zero-based index of the layer containing a byte offset, or -1 before the first layer. */
export function layerIndexAt(layers: readonly LayerInfo[], offset: number): number {
  let low = 0;
  let high = layers.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (layers[mid].start <= offset) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Make very dark filament colours visible on a dark panel. */
export function displayColor(hex: string | undefined, toolIndex: number): string {
  const value = /^#[0-9a-fA-F]{6}$/.test(hex ?? '')
    ? (hex as string)
    : FALLBACK_COLORS[toolIndex % FALLBACK_COLORS.length];
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luminance >= 0.22) {
    return value;
  }
  const lift = (channel: number) => Math.round(channel + (255 - channel) * 0.42);
  return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
}

function resetJob(name: string | null): void {
  jobName = name;
  meta = null;
  layerCache.clear();
  layerRequests.clear();
  sampleOffset = 0;
  sampleTime = 0;
  bytesPerSecond = 0;
  live = true;
  message = name ? 'Loading G-code...' : 'No active print.';
}

async function loadMeta(name: string): Promise<void> {
  try {
    const result = await apiRequestWithMetadata<MetaResponse>(
      `/api/gcode-view/meta?file=${encodeURIComponent(name)}`
    );
    if (jobName !== name) return; // job changed while loading
    const data = result.data;
    if (!data.success || !data.layers || !data.size) {
      message = data.error || 'No G-code available for this job.';
      scheduleFrame();
      return;
    }
    if (data.layers.length === 0) {
      message = 'This file has no printable layers.';
      scheduleFrame();
      return;
    }
    meta = {
      fileName: name,
      size: data.size,
      layers: data.layers,
      bounds: data.bounds ?? null,
      modelBounds: data.modelBounds ?? null,
      tools: data.tools ?? [],
      colors: data.colors ?? [],
    };
    message = '';
    renderLegend();
    scheduleFrame();
  } catch (error) {
    console.error('G-code viewer: failed to load metadata', error);
    if (jobName === name) {
      message = 'Could not load the G-code for this job.';
      scheduleFrame();
    }
  }
}

function requestLayer(layerNumber: number): void {
  if (!meta || layerNumber < 1 || layerNumber > meta.layers.length) return;
  if (layerCache.has(layerNumber) || layerRequests.has(layerNumber)) return;
  const name = meta.fileName;
  layerRequests.add(layerNumber);
  void apiRequestWithMetadata<LayerResponse>(
    `/api/gcode-view/layer?file=${encodeURIComponent(name)}&layer=${layerNumber}`
  )
    .then((result) => {
      if (jobName !== name || !result.data.success || !result.data.paths) return;
      if (layerCache.size >= MAX_CACHED_LAYERS) {
        const oldest = layerCache.keys().next().value;
        if (oldest !== undefined) layerCache.delete(oldest);
      }
      layerCache.set(layerNumber, {
        z: result.data.z ?? 0,
        start: result.data.start ?? 0,
        end: result.data.end ?? 0,
        paths: result.data.paths,
      });
      scheduleFrame();
    })
    .catch((error) => console.error('G-code viewer: failed to load layer', error))
    .finally(() => layerRequests.delete(layerNumber));
}

function handleStatus(status: PrinterStatus): void {
  const name = status.jobName || null;
  const printerState = (status.printerState || '').toLowerCase();
  printing = Boolean(name) && ACTIVE_STATES.has(printerState);

  if (name !== jobName) {
    resetJob(name);
    if (name && state.isAuthenticated) {
      void loadMeta(name);
    }
  }

  if (meta && name) {
    // The WebSocket status carries progress as a percentage (0-100, fractional).
    const fraction = Math.min(
      1,
      Math.max(0, (Number.isFinite(status.progress) ? status.progress : 0) / 100)
    );
    const offset = printerState === 'completed' ? meta.size : fraction * meta.size;
    const now = performance.now();
    if (sampleTime > 0 && offset > sampleOffset && now > sampleTime) {
      const rate = ((offset - sampleOffset) * 1000) / (now - sampleTime);
      bytesPerSecond = bytesPerSecond > 0 ? bytesPerSecond * 0.5 + rate * 0.5 : rate;
    } else if (offset < sampleOffset) {
      bytesPerSecond = 0;
    }
    if (offset !== sampleOffset || sampleTime === 0) {
      sampleOffset = offset;
      sampleTime = now;
    }
  }
  scheduleFrame();
}

/** Offset to draw up to right now: last reported offset plus a short extrapolation. */
function currentOffset(): number {
  if (!meta) return 0;
  if (!printing || bytesPerSecond <= 0) return sampleOffset;
  const elapsed = Math.min(MAX_LEAD_SECONDS, (performance.now() - sampleTime) / 1000);
  return Math.min(meta.size, sampleOffset + bytesPerSecond * elapsed);
}

function scheduleFrame(): void {
  if (frameRequested) return;
  frameRequested = true;
  requestAnimationFrame(frame);
}

function frame(now: number): void {
  frameRequested = false;
  if (now - lastDraw < REDRAW_INTERVAL_MS) {
    // Too soon: try again next frame instead of dropping the redraw.
    scheduleFrame();
    return;
  }
  lastDraw = now;
  draw();
  // Keep animating only while the marker is expected to move.
  if (meta && live && printing && bytesPerSecond > 0 && $('gcode-view-canvas')) {
    scheduleFrame();
  }
}

function prepareCanvas(): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
} | null {
  const canvas = $('gcode-view-canvas') as HTMLCanvasElement | null;
  if (!canvas || canvas.offsetParent === null) return null;

  if (canvas !== observedCanvas) {
    resizeObserver?.disconnect();
    observedCanvas = canvas;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleFrame());
      resizeObserver.observe(canvas);
    }
  }

  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

function draw(): void {
  const overlay = $('gcode-view-message');
  if (overlay) {
    overlay.textContent = message;
    overlay.classList.toggle('hidden', message === '');
  }

  const legend = $('gcode-view-legend');
  if (meta && legend && legend.childElementCount === 0) renderLegend();

  const surface = prepareCanvas();
  const controls = $('gcode-view-controls');
  controls?.classList.toggle('hidden', !meta);
  if (!surface) return;
  if (!meta || !meta.bounds) {
    updateInfo(null, 0, null, false);
    return;
  }

  const offset = currentOffset();
  let layerNumber: number;
  if (live) {
    layerNumber = Math.max(1, layerIndexAt(meta.layers, offset) + 1);
    scrubLayer = layerNumber;
  } else {
    layerNumber = Math.min(meta.layers.length, Math.max(1, scrubLayer));
  }

  const slider = $('gcode-view-slider') as HTMLInputElement | null;
  if (slider) {
    if (Number(slider.max) !== meta.layers.length) slider.max = String(meta.layers.length);
    if (live && Number(slider.value) !== layerNumber) slider.value = String(layerNumber);
  }
  $('gcode-view-live')?.classList.toggle('active', live);

  requestLayer(layerNumber);
  requestLayer(layerNumber - 1);
  if (live && printing) requestLayer(layerNumber + 1);

  const { ctx, width, height } = surface;
  const bounds = fitModel && meta.modelBounds ? meta.modelBounds : meta.bounds;
  const fitButton = $('gcode-view-fit');
  if (fitButton) {
    fitButton.classList.toggle('hidden', !meta.modelBounds);
    fitButton.textContent = fitModel ? 'Fit: model' : 'Fit: all';
  }
  const margin = 14;
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min((width - 2 * margin) / spanX, (height - 2 * margin) / spanY);
  const originX = (width - spanX * scale) / 2 - bounds.minX * scale;
  const originY = (height + spanY * scale) / 2 + bounds.minY * scale; // Y axis points up on the bed
  const toX = (x: number) => originX + x * scale;
  const toY = (y: number) => originY - y * scale;
  const lineWidth = Math.max(1.1, Math.min(3.5, 0.42 * scale));

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const below = layerCache.get(layerNumber - 1);
  if (below) {
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = lineWidth;
    for (const path of below.paths) {
      ctx.strokeStyle = displayColor(meta.colors[path.t], path.t);
      ctx.beginPath();
      ctx.moveTo(toX(path.p[0]), toY(path.p[1]));
      for (let k = 2; k < path.p.length; k += 2) ctx.lineTo(toX(path.p[k]), toY(path.p[k + 1]));
      ctx.stroke();
    }
  }

  const layer = layerCache.get(layerNumber);
  let markerX = Number.NaN;
  let markerY = Number.NaN;
  let activeTool: number | null = null;
  let onTower = false;
  if (layer) {
    // In live mode segments are split at the current offset; when browsing, the
    // whole layer is shown as printed.
    const limit = live ? offset : Number.POSITIVE_INFINITY;
    for (const pass of ['pending', 'done'] as const) {
      ctx.globalAlpha = pass === 'done' ? 1 : 0.3;
      ctx.lineWidth = pass === 'done' ? lineWidth : Math.max(1, lineWidth * 0.7);
      for (const path of layer.paths) {
        let split = 0; // number of segments already printed
        while (split < path.o.length && path.o[split] <= limit) split++;
        const from = pass === 'done' ? 0 : split;
        const to = pass === 'done' ? split : path.o.length;
        if (to <= from) continue;
        ctx.strokeStyle = pass === 'done' ? displayColor(meta.colors[path.t], path.t) : '#8a8f98';
        ctx.beginPath();
        ctx.moveTo(toX(path.p[from * 2]), toY(path.p[from * 2 + 1]));
        for (let s = from; s < to; s++) ctx.lineTo(toX(path.p[s * 2 + 2]), toY(path.p[s * 2 + 3]));
        ctx.stroke();
        if (pass === 'done') {
          markerX = toX(path.p[split * 2]);
          markerY = toY(path.p[split * 2 + 1]);
          activeTool = path.t;
          onTower = path.w === 1;
        }
      }
    }
  }

  ctx.globalAlpha = 1;
  if (live && printing && Number.isFinite(markerX)) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.beginPath();
    ctx.arc(markerX, markerY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(markerX, markerY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  updateInfo(layerNumber, offset, activeTool, onTower);
}

function updateInfo(
  layerNumber: number | null,
  offset: number,
  activeTool: number | null,
  onTower: boolean
): void {
  const info = $('gcode-view-info');
  if (!info) return;
  if (!meta || layerNumber === null) {
    info.textContent = '';
    return;
  }
  const layer = meta.layers[layerNumber - 1];
  const parts = [`Layer ${layerNumber} / ${meta.layers.length}`, `Z ${layer.z.toFixed(2)} mm`];
  if (live) {
    if (activeTool !== null) parts.push(`T${activeTool + 1}`);
    if (onTower) parts.push('at the prime tower');
    parts.push(`${((offset / meta.size) * 100).toFixed(1)} % of file`);
  } else {
    parts.push('browsing');
  }
  info.textContent = parts.join(' · ');
}

function renderLegend(): void {
  const legend = $('gcode-view-legend');
  if (!legend || !meta) return;
  legend.textContent = '';
  for (const tool of meta.tools) {
    const item = document.createElement('span');
    item.className = 'gcode-view-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'gcode-view-swatch';
    swatch.style.backgroundColor = displayColor(meta.colors[tool], tool);
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(`T${tool + 1}`));
    legend.appendChild(item);
  }
}

export function setupGcodeViewer(): void {
  onStatusUpdate(handleStatus);

  // The grid re-creates panel elements when the layout changes, so listen at the
  // document level instead of binding to elements that may be replaced.
  document.addEventListener('input', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id !== 'gcode-view-slider') return;
    live = false;
    scrubLayer = Number((target as HTMLInputElement).value) || 1;
    lastDraw = 0;
    scheduleFrame();
  });

  document.addEventListener('click', (event) => {
    const element = event.target as HTMLElement | null;
    if (element?.closest('#gcode-view-fit')) {
      fitModel = !fitModel;
      lastDraw = 0;
      scheduleFrame();
      return;
    }
    const target = element?.closest('#gcode-view-live');
    if (!target) return;
    live = true;
    lastDraw = 0;
    renderLegend();
    scheduleFrame();
  });

  window.addEventListener('resize', () => scheduleFrame());
}
