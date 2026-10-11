/**
 * @fileoverview G-code indexing and per-layer toolpath extraction for the live G-code viewer.
 *
 * The viewer follows a print by file position: FlashForge firmware reports
 * `printProgress` as (bytes of the job file read) / (file size) - measured on a
 * Creator 5, firmware 1.9.5, where it matched the file offset of every tool change
 * to within about 0.01 %. So everything here is keyed by byte offset:
 *
 * - {@link GcodeViewService.getIndex} scans a job file once and records where each
 *   layer starts and ends, plus the machine state at each layer start.
 * - {@link GcodeViewService.getLayer} re-reads just one layer's byte range and
 *   returns its extrusion paths, every segment tagged with the offset of the
 *   G-code line that draws it.
 *
 * Job files come from the host-side job library or from the copy kept when a job is
 * started through Upload Job. A file that was sent to the printer by other means
 * cannot be fetched back over the printer's HTTP API, so it has no view unless a
 * file with the same name is in the library.
 *
 * Sliced 3MF files are supported by extracting the embedded plate G-code to a cache
 * file (streamed, not buffered).
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { getDataPath } from '../utils/setup';
import { getFileLibraryService, validateLibraryFileName } from './FileLibraryService';

/** Machine state needed to interpret moves from an arbitrary point in the file. */
export interface GcodeMachineState {
  x: number;
  y: number;
  z: number;
  e: number;
  absXY: boolean;
  absE: boolean;
  tool: number;
  /** True while the current feature is the prime/wipe tower (from ;TYPE: comments). */
  tower: boolean;
}

export interface GcodeLayerInfo {
  /** Height of the layer in mm. */
  readonly z: number;
  /** Byte offset of the first line of the layer. */
  readonly start: number;
  /** Byte offset just past the last line of the layer. */
  readonly end: number;
}

interface IndexedLayer extends GcodeLayerInfo {
  readonly state: GcodeMachineState;
}

export interface GcodeBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GcodeIndex {
  /** Size in bytes of the G-code that offsets refer to. */
  readonly size: number;
  readonly layers: readonly IndexedLayer[];
  /** XY bounds of all extrusion inside layers, or null when nothing is extruded. */
  readonly bounds: GcodeBounds | null;
  /** Same, without the prime/wipe tower; null when the file does not label features. */
  readonly modelBounds: GcodeBounds | null;
  /** Zero-based tool numbers used in the file, ascending. */
  readonly tools: readonly number[];
  /** Slicer filament colours by tool index (may be empty). */
  readonly colors: readonly string[];
}

/** One run of consecutive extruding moves with the same tool. */
export interface GcodePath {
  /** Zero-based tool number. */
  t: number;
  /** 1 when the path belongs to the prime/wipe tower. */
  w?: 1;
  /** Vertices as x0,y0,x1,y1,... in mm (2 decimals). */
  p: number[];
  /** Byte offset of the G-code line that draws each segment (vertices - 1 entries). */
  o: number[];
}

export interface GcodeLayerPaths {
  readonly z: number;
  readonly start: number;
  readonly end: number;
  readonly paths: GcodePath[];
}

const TOWER_TYPE_PATTERN = /^;TYPE:\s*(prime|wipe) tower/i;
const PARAM_PATTERN = /([XYZEIJ])\s*(-?(?:\d+\.?\d*|\.\d+))/gi;
const MAX_ARC_STEP_RADIANS = Math.PI / 18; // 10 degrees
const BYTE_NEWLINE = 0x0a;
const BYTE_SEMICOLON = 0x3b;
const BYTE_G = 0x47;
const BYTE_M = 0x4d;
const BYTE_T = 0x54;

export function initialMachineState(): GcodeMachineState {
  return { x: 0, y: 0, z: 0, e: 0, absXY: true, absE: true, tool: 0, tower: false };
}

export interface GcodeMove {
  readonly x0: number;
  readonly y0: number;
  /** End point, or the tessellated points of an arc (x,y pairs, last = end point). */
  readonly points: number[];
  readonly extruding: boolean;
  readonly z: number;
}

/**
 * Apply one G-code line to the machine state.
 * @returns the XY move the line performs, or null for anything else.
 */
export function applyGcodeLine(state: GcodeMachineState, rawLine: string): GcodeMove | null {
  const commentAt = rawLine.indexOf(';');
  const line = (commentAt >= 0 ? rawLine.slice(0, commentAt) : rawLine).trim();
  if (line.length < 2) return null;

  const first = line.charCodeAt(0) & ~0x20; // upper-case
  if (first === BYTE_T) {
    const tool = Number.parseInt(line.slice(1), 10);
    if (Number.isInteger(tool) && tool >= 0 && tool < 64 && /^T\d+$/i.test(line)) {
      state.tool = tool;
    }
    return null;
  }
  if (first !== BYTE_G && first !== BYTE_M) return null;

  const match = /^([GM])0*(\d+)(?![\d.])/i.exec(line);
  if (!match) return null;
  const code = Number.parseInt(match[2], 10);

  if (first === BYTE_M) {
    if (code === 82) state.absE = true;
    else if (code === 83) state.absE = false;
    return null;
  }

  // G90/G91 switch positioning only; the extruder mode is owned by M82/M83
  // (Klipper, and Marlin once M82/M83 has been used).
  if (code === 90) {
    state.absXY = true;
    return null;
  }
  if (code === 91) {
    state.absXY = false;
    return null;
  }
  if (code !== 0 && code !== 1 && code !== 2 && code !== 3 && code !== 92 && code !== 28) {
    return null;
  }

  let px: number | undefined;
  let py: number | undefined;
  let pz: number | undefined;
  let pe: number | undefined;
  let pi = 0;
  let pj = 0;
  PARAM_PATTERN.lastIndex = match[0].length;
  for (let m = PARAM_PATTERN.exec(line); m !== null; m = PARAM_PATTERN.exec(line)) {
    const value = Number.parseFloat(m[2]);
    switch (m[1].toUpperCase()) {
      case 'X':
        px = value;
        break;
      case 'Y':
        py = value;
        break;
      case 'Z':
        pz = value;
        break;
      case 'E':
        pe = value;
        break;
      case 'I':
        pi = value;
        break;
      case 'J':
        pj = value;
        break;
    }
  }

  if (code === 92) {
    if (px !== undefined) state.x = px;
    if (py !== undefined) state.y = py;
    if (pz !== undefined) state.z = pz;
    if (pe !== undefined) state.e = pe;
    return null;
  }
  if (code === 28) {
    // Homing: position is unknown to us; the next absolute move re-anchors it.
    return null;
  }

  const x0 = state.x;
  const y0 = state.y;
  const x1 = px === undefined ? x0 : state.absXY ? px : x0 + px;
  const y1 = py === undefined ? y0 : state.absXY ? py : y0 + py;
  if (pz !== undefined) state.z = state.absXY ? pz : state.z + pz;

  let extruded = 0;
  if (pe !== undefined) {
    extruded = state.absE ? pe - state.e : pe;
    state.e = state.absE ? pe : state.e + pe;
  }

  state.x = x1;
  state.y = y1;
  if (x1 === x0 && y1 === y0 && code < 2) return null;

  let points: number[];
  if (code === 2 || code === 3) {
    points = tessellateArc(x0, y0, x1, y1, pi, pj, code === 2);
  } else {
    points = [x1, y1];
  }
  return { x0, y0, points, extruding: extruded > 0, z: state.z };
}

function tessellateArc(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  i: number,
  j: number,
  clockwise: boolean
): number[] {
  const cx = x0 + i;
  const cy = y0 + j;
  const radius = Math.hypot(i, j);
  if (radius === 0) return [x1, y1];

  const startAngle = Math.atan2(y0 - cy, x0 - cx);
  let sweep = Math.atan2(y1 - cy, x1 - cx) - startAngle;
  if (clockwise && sweep >= 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep <= 0) sweep += 2 * Math.PI;

  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / MAX_ARC_STEP_RADIANS));
  const points: number[] = [];
  for (let step = 1; step < steps; step++) {
    const angle = startAngle + (sweep * step) / steps;
    points.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
  }
  points.push(x1, y1);
  return points;
}

/**
 * Call `onLine` for every line in [start, end) of a file, with the line's byte offset.
 * Only lines starting with G, M, T or ';' are decoded; everything else is skipped.
 */
export async function scanGcodeLines(
  filePath: string,
  start: number,
  end: number,
  onLine: (line: string, offset: number) => void
): Promise<void> {
  if (end <= start) return;
  const stream = createReadStream(filePath, { start, end: end - 1, highWaterMark: 256 * 1024 });
  let carry: Buffer | null = null;
  let carryOffset = start;
  let position = start;

  const emit = (buffer: Buffer, from: number, to: number, offset: number): void => {
    let begin = from;
    while (begin < to && (buffer[begin] === 0x20 || buffer[begin] === 0x09)) begin++;
    if (begin >= to) return;
    const first = buffer[begin] & ~0x20;
    if (
      first !== BYTE_G &&
      first !== BYTE_M &&
      first !== BYTE_T &&
      buffer[begin] !== BYTE_SEMICOLON
    )
      return;
    let stop = to;
    if (stop > begin && buffer[stop - 1] === 0x0d) stop--;
    onLine(buffer.toString('latin1', begin, stop), offset);
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let lineStart = 0;
    let newline = chunk.indexOf(BYTE_NEWLINE, 0);
    if (carry !== null) {
      if (newline < 0) {
        carry = Buffer.concat([carry, chunk]);
        position += chunk.length;
        continue;
      }
      const joined = Buffer.concat([carry, chunk.subarray(0, newline)]);
      emit(joined, 0, joined.length, carryOffset);
      carry = null;
      lineStart = newline + 1;
      newline = chunk.indexOf(BYTE_NEWLINE, lineStart);
    }
    while (newline >= 0) {
      emit(chunk, lineStart, newline, position + lineStart);
      lineStart = newline + 1;
      newline = chunk.indexOf(BYTE_NEWLINE, lineStart);
    }
    if (lineStart < chunk.length) {
      carry = Buffer.from(chunk.subarray(lineStart));
      carryOffset = position + lineStart;
    }
    position += chunk.length;
  }
  if (carry !== null) {
    emit(carry, 0, carry.length, carryOffset);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Scan a whole G-code file and build its layer index. */
export async function buildGcodeIndex(filePath: string): Promise<GcodeIndex> {
  const { size } = await fsp.stat(filePath);
  const state = initialMachineState();

  // Layers from slicer markers (;LAYER_CHANGE / ;LAYER:n) are preferred. Files without
  // markers fall back to "an extrusion happens at a new, higher Z".
  const marked: { start: number; z: number | null; state: GcodeMachineState }[] = [];
  const byHeight: { start: number; z: number; state: GcodeMachineState }[] = [];
  let highestExtrusionZ = Number.NEGATIVE_INFINITY;
  let pendingMarkerZ = false;

  const tools = new Set<number>();
  let colors: string[] = [];
  const emptyBounds = (): GcodeBounds => ({
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  });
  const boundsAll = emptyBounds();
  const boundsMarked = emptyBounds();
  const boundsModel = emptyBounds();
  let towerSeen = false;

  await scanGcodeLines(filePath, 0, size, (line, offset) => {
    if (line.charCodeAt(0) === BYTE_SEMICOLON) {
      if (line.startsWith(';TYPE:')) {
        state.tower = TOWER_TYPE_PATTERN.test(line);
      } else if (line.startsWith(';LAYER_CHANGE') || /^;\s?LAYER:\s*-?\d+/.test(line)) {
        marked.push({ start: offset, z: null, state: { ...state } });
        pendingMarkerZ = true;
      } else if (pendingMarkerZ && line.startsWith(';Z:')) {
        const z = Number.parseFloat(line.slice(3));
        if (Number.isFinite(z)) marked[marked.length - 1].z = z;
        pendingMarkerZ = false;
      } else if (colors.length === 0 && /^;\s*filament_colou?r\s*=/.test(line)) {
        colors = line
          .slice(line.indexOf('=') + 1)
          .split(';')
          .map((entry) => entry.trim())
          .filter((entry) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(entry))
          .map((entry) => entry.slice(0, 7).toUpperCase());
      }
      return;
    }

    const before = byHeight.length === 0 || state.z > highestExtrusionZ ? { ...state } : null;
    const move = applyGcodeLine(state, line);
    if (!move || !move.extruding) return;

    tools.add(state.tool);
    if (move.z > highestExtrusionZ + 1e-6) {
      highestExtrusionZ = move.z;
      byHeight.push({ start: offset, z: move.z, state: before ?? { ...state } });
    }
    const current = marked.length > 0 ? marked[marked.length - 1] : null;
    if (current && current.z === null) {
      current.z = move.z;
      pendingMarkerZ = false;
    }
    // Bounds: inside marked layers when the file has markers (so start-G-code purge
    // lines do not shrink the model in the view), otherwise all extrusion.
    const targets = marked.length > 0 ? [boundsAll, boundsMarked] : [boundsAll];
    if (state.tower) towerSeen = true;
    else if (marked.length > 0) targets.push(boundsModel); // not the start G-code purge
    for (const target of targets) {
      target.minX = Math.min(target.minX, move.x0);
      target.minY = Math.min(target.minY, move.y0);
      target.maxX = Math.max(target.maxX, move.x0);
      target.maxY = Math.max(target.maxY, move.y0);
      for (let k = 0; k < move.points.length; k += 2) {
        target.minX = Math.min(target.minX, move.points[k]);
        target.maxX = Math.max(target.maxX, move.points[k]);
        target.minY = Math.min(target.minY, move.points[k + 1]);
        target.maxY = Math.max(target.maxY, move.points[k + 1]);
      }
    }
  });

  const source = marked.length > 0 ? marked : byHeight;
  const chosenBounds =
    marked.length > 0 && Number.isFinite(boundsMarked.minX) ? boundsMarked : boundsAll;
  const layers: IndexedLayer[] = source.map((entry, position) => ({
    z: round2(entry.z ?? 0),
    start: entry.start,
    end: position + 1 < source.length ? source[position + 1].start : size,
    state: entry.state,
  }));

  return {
    size,
    layers,
    bounds: Number.isFinite(chosenBounds.minX) ? chosenBounds : null,
    modelBounds: towerSeen && Number.isFinite(boundsModel.minX) ? boundsModel : null,
    tools: Array.from(tools).sort((a, b) => a - b),
    colors,
  };
}

/** Extract the extrusion paths of one layer (1-based) from an indexed file. */
export async function readGcodeLayer(
  filePath: string,
  index: GcodeIndex,
  layerNumber: number
): Promise<GcodeLayerPaths> {
  const layer = index.layers[layerNumber - 1];
  if (!layer) {
    throw new Error(`Layer ${layerNumber} does not exist`);
  }

  const state: GcodeMachineState = { ...layer.state };
  const paths: GcodePath[] = [];
  let current: GcodePath | null = null;
  let lastX = Number.NaN;
  let lastY = Number.NaN;

  await scanGcodeLines(filePath, layer.start, layer.end, (line, offset) => {
    if (line.charCodeAt(0) === BYTE_SEMICOLON) {
      if (line.startsWith(';TYPE:')) state.tower = TOWER_TYPE_PATTERN.test(line);
      return;
    }
    const move = applyGcodeLine(state, line);
    if (!move || !move.extruding) {
      if (move) current = null; // a travel move breaks the path
      return;
    }
    if (
      current === null ||
      current.t !== state.tool ||
      (current.w === 1) !== state.tower ||
      lastX !== move.x0 ||
      lastY !== move.y0
    ) {
      current = { t: state.tool, p: [round2(move.x0), round2(move.y0)], o: [] };
      if (state.tower) current.w = 1;
      paths.push(current);
    }
    for (let k = 0; k < move.points.length; k += 2) {
      current.p.push(round2(move.points[k]), round2(move.points[k + 1]));
      current.o.push(offset);
    }
    lastX = move.points[move.points.length - 2];
    lastY = move.points[move.points.length - 1];
  });

  return { z: layer.z, start: layer.start, end: layer.end, paths };
}

// ---------------------------------------------------------------------------
// 3MF: extract the embedded plate G-code
// ---------------------------------------------------------------------------

const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const PLATE_GCODE_PATTERN = /^Metadata\/plate_\d+\.gcode$/;

/** Stream the first `Metadata/plate_N.gcode` entry of a sliced 3MF into `targetPath`. */
export async function extractPlateGcode(zipPath: string, targetPath: string): Promise<void> {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const { size } = await handle.stat();
    const tailLength = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === ZIP_EOCD_SIGNATURE) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('Not a zip archive');
    const entryCount = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset === 0xffffffff || directorySize === 0xffffffff) {
      throw new Error('Zip64 archives are not supported');
    }

    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryOffset);

    let cursor = 0;
    for (let entry = 0; entry < entryCount && cursor + 46 <= directory.length; entry++) {
      if (directory.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) break;
      const method = directory.readUInt16LE(cursor + 10);
      const compressedSize = directory.readUInt32LE(cursor + 20);
      const nameLength = directory.readUInt16LE(cursor + 28);
      const extraLength = directory.readUInt16LE(cursor + 30);
      const commentLength = directory.readUInt16LE(cursor + 32);
      const localOffset = directory.readUInt32LE(cursor + 42);
      const name = directory.toString('utf8', cursor + 46, cursor + 46 + nameLength);
      cursor += 46 + nameLength + extraLength + commentLength;

      if (!PLATE_GCODE_PATTERN.test(name)) continue;
      if (compressedSize === 0xffffffff) throw new Error('Zip64 archives are not supported');
      if (method !== 0 && method !== 8)
        throw new Error(`Unsupported zip compression method: ${method}`);

      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE) throw new Error('Corrupt zip entry');
      const dataStart = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

      const temporary = `${targetPath}.${process.pid}.part`;
      try {
        if (compressedSize === 0) {
          await fsp.writeFile(temporary, '');
        } else {
          const source = createReadStream(zipPath, {
            start: dataStart,
            end: dataStart + compressedSize - 1,
          });
          if (method === 8) {
            await pipeline(source, createInflateRaw(), createWriteStream(temporary));
          } else {
            await pipeline(source, createWriteStream(temporary));
          }
        }
        await fsp.rename(temporary, targetPath);
      } catch (error) {
        await fsp.rm(temporary, { force: true });
        throw error;
      }
      return;
    }
    throw new Error('Embedded G-code is missing.');
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Service: locate job files, cache indexes
// ---------------------------------------------------------------------------

const MAX_KEPT_JOB_FILES = 5;
const MAX_CACHED_INDEXES = 2;

export interface ResolvedJobGcode {
  /** Path of plain G-code that offsets refer to. */
  readonly gcodePath: string;
  readonly source: 'library' | 'job';
}

interface CachedIndex {
  readonly key: string;
  readonly index: Promise<GcodeIndex>;
}

export class GcodeViewService {
  private readonly indexes: CachedIndex[] = [];

  constructor(
    private readonly jobFilesDirectory: string,
    private readonly extractDirectory: string,
    private readonly libraryPathFor: (fileName: string) => Promise<string | null>
  ) {}

  /**
   * Keep a copy of a job file that is about to be sent to the printer, so the viewer
   * can show it while it prints. Best effort: failures are reported, never thrown.
   */
  public async rememberJobFile(fileName: string, sourcePath: string): Promise<void> {
    try {
      const safeName = validateLibraryFileName(fileName);
      await fsp.mkdir(this.jobFilesDirectory, { recursive: true });
      await fsp.copyFile(sourcePath, path.join(this.jobFilesDirectory, safeName));

      const entries = await fsp.readdir(this.jobFilesDirectory);
      const dated = await Promise.all(
        entries.map(async (entry) => {
          const stats = await fsp.stat(path.join(this.jobFilesDirectory, entry));
          return { entry, time: stats.mtimeMs };
        })
      );
      dated.sort((a, b) => b.time - a.time);
      await Promise.all(
        dated
          .slice(MAX_KEPT_JOB_FILES)
          .map(({ entry }) => fsp.rm(path.join(this.jobFilesDirectory, entry), { force: true }))
      );
    } catch (error) {
      console.warn(`[GcodeView] Could not keep job file ${fileName}:`, (error as Error).message);
    }
  }

  /** Find the G-code for a job by the file name the printer reports. */
  public async resolve(fileName: string): Promise<ResolvedJobGcode | null> {
    let safeName: string;
    try {
      safeName = validateLibraryFileName(fileName);
    } catch {
      return null;
    }

    let source: 'library' | 'job' = 'library';
    let filePath = await this.libraryPathFor(safeName);
    if (!filePath) {
      const candidate = path.join(this.jobFilesDirectory, safeName);
      const stats = await fsp.stat(candidate).catch(() => null);
      if (!stats?.isFile()) return null;
      filePath = candidate;
      source = 'job';
    }

    if (!safeName.toLowerCase().endsWith('.3mf')) {
      return { gcodePath: filePath, source };
    }

    // Sliced 3MF: extract the plate G-code once per file version.
    const stats = await fsp.stat(filePath);
    const hash = createHash('sha1')
      .update(`${filePath}|${stats.size}|${stats.mtimeMs}`)
      .digest('hex')
      .slice(0, 16);
    const extracted = path.join(this.extractDirectory, `${hash}.gcode`);
    if (!(await fsp.stat(extracted).catch(() => null))) {
      await fsp.mkdir(this.extractDirectory, { recursive: true });
      const stale = await fsp.readdir(this.extractDirectory);
      await Promise.all(
        stale.map((entry) => fsp.rm(path.join(this.extractDirectory, entry), { force: true }))
      );
      await extractPlateGcode(filePath, extracted);
    }
    return { gcodePath: extracted, source };
  }

  /** Layer index of a G-code file, cached per file version. */
  public async getIndex(gcodePath: string): Promise<GcodeIndex> {
    const stats = await fsp.stat(gcodePath);
    const key = `${gcodePath}|${stats.size}|${stats.mtimeMs}`;
    const cached = this.indexes.find((entry) => entry.key === key);
    if (cached) return cached.index;

    const index = buildGcodeIndex(gcodePath);
    this.indexes.unshift({ key, index });
    this.indexes.length = Math.min(this.indexes.length, MAX_CACHED_INDEXES);
    index.catch(() => {
      const position = this.indexes.findIndex((entry) => entry.key === key);
      if (position >= 0) this.indexes.splice(position, 1);
    });
    return index;
  }

  public async getLayer(gcodePath: string, layerNumber: number): Promise<GcodeLayerPaths> {
    const index = await this.getIndex(gcodePath);
    return readGcodeLayer(gcodePath, index, layerNumber);
  }
}

let instance: GcodeViewService | null = null;

export function getGcodeViewService(): GcodeViewService {
  if (!instance) {
    const dataPath = getDataPath();
    instance = new GcodeViewService(
      path.join(dataPath, 'job-files'),
      path.join(dataPath, 'runtime', 'gcode-view'),
      async (fileName) => {
        const library = getFileLibraryService();
        return (await library.exists(fileName)) ? library.resolvePath(fileName) : null;
      }
    );
  }
  return instance;
}
