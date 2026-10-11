/**
 * @fileoverview Tests for G-code indexing, per-layer path extraction, 3MF plate
 * extraction and job file lookup used by the live G-code viewer.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  applyGcodeLine,
  buildGcodeIndex,
  extractPlateGcode,
  GcodeViewService,
  initialMachineState,
  readGcodeLayer,
  scanGcodeLines,
} from './GcodeViewService';

// Shaped like OrcaSlicer output for a tool changer: relative extrusion, layer
// markers, a purge line in the start G-code, tool changes inside layers.
const SAMPLE = [
  '; HEADER_BLOCK_START',
  '; filament_colour = #F82D29;#1B1B1B;#FFFFFF;#7BD9F0',
  'M83 ; relative extrusion',
  'G90',
  'G28',
  'G1 X5 Y5 Z0.3 F6000',
  'G1 X200 Y5 E12 F1200 ; purge line in start gcode',
  ';LAYER_CHANGE',
  ';Z:0.25',
  'T0',
  'G1 X100 Y100 F9000',
  'G1 X110 Y100 E0.5',
  'G1 X110 Y110 E0.5',
  'G1 E-0.8 F2400 ; retract',
  'G1 X120 Y120 ; travel',
  'G1 E0.8 ; unretract',
  'G1 X130 Y120 E0.5',
  'T3',
  'G1 X100 Y130',
  'G1 X105 Y130 E0.3',
  ';LAYER_CHANGE',
  ';Z:0.45',
  'G1 Z0.45',
  'G1 X100 Y100',
  'G2 X110 Y110 I10 J0 E1.2 ; clockwise quarter arc',
  '; filament used [g] = 1.0',
  '',
].join('\n');

describe('applyGcodeLine', () => {
  it('handles absolute and relative extrusion', () => {
    const state = initialMachineState();
    expect(applyGcodeLine(state, 'G1 X10 Y0 E1.0')?.extruding).toBe(true);
    expect(applyGcodeLine(state, 'G1 X20 Y0 E1.0')?.extruding).toBe(false); // absolute E unchanged
    applyGcodeLine(state, 'M83');
    expect(applyGcodeLine(state, 'G1 X30 Y0 E0.2')?.extruding).toBe(true);
    expect(applyGcodeLine(state, 'G1 X40 Y0 E-0.5')?.extruding).toBe(false);
    applyGcodeLine(state, 'G92 E0');
    expect(state.e).toBe(0);
    // G90/G91 do not change the extruder mode
    applyGcodeLine(state, 'G90');
    expect(applyGcodeLine(state, 'G1 X50 Y0 E0.2')?.extruding).toBe(true);
    expect(applyGcodeLine(state, 'G1 X60 Y0 E0.2')?.extruding).toBe(true);
  });

  it('tracks tools, relative moves and ignores unrelated commands', () => {
    const state = initialMachineState();
    applyGcodeLine(state, 'T2');
    expect(state.tool).toBe(2);
    expect(applyGcodeLine(state, 'M104 S230 T3 ; preheat')).toBeNull();
    expect(state.tool).toBe(2);
    applyGcodeLine(state, 'G1 X10 Y10');
    applyGcodeLine(state, 'G91');
    const move = applyGcodeLine(state, 'G1 X5 Y-2');
    expect(move?.points).toEqual([15, 8]);
    expect(applyGcodeLine(state, 'G1 E-1')).toBeNull();
    expect(applyGcodeLine(state, 'SET_PRESSURE_ADVANCE ADVANCE=0.025')).toBeNull();
    expect(applyGcodeLine(state, 'G10 P1')).toBeNull();
  });

  it('tessellates arcs and ends exactly on the target', () => {
    const state = initialMachineState();
    applyGcodeLine(state, 'M83');
    applyGcodeLine(state, 'G1 X100 Y100');
    const move = applyGcodeLine(state, 'G3 X110 Y110 I10 J0 E1');
    expect(move?.extruding).toBe(true);
    const points = move?.points ?? [];
    expect(points.length).toBeGreaterThan(4);
    expect(points.slice(-2)).toEqual([110, 110]);
    for (let k = 0; k < points.length; k += 2) {
      expect(Math.hypot(points[k] - 110, points[k + 1] - 100)).toBeCloseTo(10, 6);
    }
  });
});

describe('index and layers', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-gcode-'));
    file = path.join(dir, 'sample.gcode');
    await fsp.writeFile(file, SAMPLE);
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('reports exact byte offsets for every scanned line, across chunk boundaries', async () => {
    const big = `${'G1 X1 Y1\r\n'.repeat(60000)}T1\nG1 X2 Y2`;
    const bigFile = path.join(dir, 'big.gcode');
    await fsp.writeFile(bigFile, big);
    const tail: [string, number][] = [];
    let count = 0;
    await scanGcodeLines(bigFile, 0, big.length, (line, offset) => {
      count++;
      if (count > 60000) tail.push([line, offset]);
      if (big.slice(offset, offset + line.length) !== line)
        throw new Error(`offset mismatch at ${offset}`);
    });
    expect(count).toBe(60002);
    expect(tail).toEqual([
      ['T1', 60000 * 10],
      ['G1 X2 Y2', 60000 * 10 + 3],
    ]);
  });

  it('indexes layers by marker with byte ranges, tools, colours and bounds', async () => {
    const index = await buildGcodeIndex(file);
    expect(index.size).toBe(Buffer.byteLength(SAMPLE));
    expect(index.layers.map((layer) => layer.z)).toEqual([0.25, 0.45]);
    expect(index.layers[0].start).toBe(SAMPLE.indexOf(';LAYER_CHANGE'));
    expect(index.layers[0].end).toBe(SAMPLE.lastIndexOf(';LAYER_CHANGE'));
    expect(index.layers[1].end).toBe(index.size);
    expect(index.tools).toEqual([0, 3]);
    expect(index.colors).toEqual(['#F82D29', '#1B1B1B', '#FFFFFF', '#7BD9F0']);
    // the purge line (X5..200, Y5) from the start G-code is not part of the bounds
    expect(index.bounds).toEqual({ minX: 100, minY: 100, maxX: 130, maxY: 130 });
    expect(index.modelBounds).toBeNull(); // no ;TYPE: labels in this file
  });

  it('extracts paths per layer, tagged with the offset of the drawing line', async () => {
    const index = await buildGcodeIndex(file);
    const first = await readGcodeLayer(file, index, 1);
    expect(first.paths.map((p) => p.t)).toEqual([0, 0, 3]);
    expect(first.paths[0].p).toEqual([100, 100, 110, 100, 110, 110]);
    expect(first.paths[0].o).toEqual([
      SAMPLE.indexOf('G1 X110 Y100 E0.5'),
      SAMPLE.indexOf('G1 X110 Y110 E0.5'),
    ]);
    expect(first.paths[1].p).toEqual([120, 120, 130, 120]);
    expect(first.paths[2].p).toEqual([100, 130, 105, 130]);

    // layer 2 starts from the saved machine state (relative E, position, tool 3)
    const second = await readGcodeLayer(file, index, 2);
    expect(second.paths).toHaveLength(1);
    expect(second.paths[0].t).toBe(3);
    expect(second.paths[0].p.slice(0, 2)).toEqual([100, 100]);
    expect(second.paths[0].p.slice(-2)).toEqual([110, 110]);
    expect(new Set(second.paths[0].o)).toEqual(new Set([SAMPLE.indexOf('G2 X110')]));
    await expect(readGcodeLayer(file, index, 3)).rejects.toThrow();
  });

  it('separates the prime tower from the model', async () => {
    const lines = [
      'M83',
      ';TYPE:Custom',
      'G1 X250 Y2',
      'G1 X256 Y0 E5 ; purge in the start G-code',
      ';LAYER_CHANGE',
      ';Z:0.2',
      ';TYPE:Outer wall',
      'G1 X100 Y100',
      'G1 X120 Y100 E1',
      ';TYPE:Prime tower',
      'G1 X10 Y240',
      'G1 X40 Y240 E1',
      ';LAYER_CHANGE',
      ';Z:0.4',
      'G1 X40 Y250 E1',
      ';TYPE:Inner wall',
      'G1 X100 Y120',
      'G1 X120 Y120 E1',
      '',
    ];
    const towerFile = path.join(dir, 'tower.gcode');
    await fsp.writeFile(towerFile, lines.join(String.fromCharCode(10)));
    const index = await buildGcodeIndex(towerFile);
    expect(index.bounds).toEqual({ minX: 10, minY: 100, maxX: 120, maxY: 250 });
    expect(index.modelBounds).toEqual({ minX: 100, minY: 100, maxX: 120, maxY: 120 });
    const first = await readGcodeLayer(towerFile, index, 1);
    expect(first.paths.map((p) => p.w ?? 0)).toEqual([0, 1]);
    // the tower flag carries over the layer boundary until the next ;TYPE:
    const second = await readGcodeLayer(towerFile, index, 2);
    expect(second.paths.map((p) => p.w ?? 0)).toEqual([1, 0]);
  });

  it('falls back to Z changes when the file has no layer markers', async () => {
    const plain = [
      'M83',
      'G1 X0 Y0 Z0.2',
      'G1 X10 Y0 E1',
      'G1 X10 Y10 E1',
      'G1 Z0.4',
      'G1 X0 Y10 E1',
      '',
    ].join('\n');
    const plainFile = path.join(dir, 'plain.gcode');
    await fsp.writeFile(plainFile, plain);
    const index = await buildGcodeIndex(plainFile);
    expect(index.layers.map((layer) => layer.z)).toEqual([0.2, 0.4]);
    expect((await readGcodeLayer(plainFile, index, 2)).paths[0].p).toEqual([10, 10, 0, 10]);
  });
});

function zipWith(entries: { name: string; data: Buffer; deflate: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe('3MF and job lookup', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-gview-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('extracts the plate G-code from a sliced 3MF (deflated and stored)', async () => {
    for (const deflate of [true, false]) {
      const archive = path.join(dir, `job-${deflate}.3mf`);
      await fsp.writeFile(
        archive,
        zipWith([
          { name: 'Metadata/slice_info.config', data: Buffer.from('<config/>'), deflate: true },
          { name: 'Metadata/plate_1.gcode', data: Buffer.from(SAMPLE), deflate },
        ])
      );
      const out = path.join(dir, `out-${deflate}.gcode`);
      await extractPlateGcode(archive, out);
      expect(await fsp.readFile(out, 'utf8')).toBe(SAMPLE);
    }
    const noGcode = path.join(dir, 'project.3mf');
    await fsp.writeFile(
      noGcode,
      zipWith([{ name: '3D/3dmodel.model', data: Buffer.from('<model/>'), deflate: true }])
    );
    await expect(extractPlateGcode(noGcode, path.join(dir, 'x.gcode'))).rejects.toThrow(
      'Embedded G-code is missing.'
    );
  });

  it('resolves jobs from the library first, then from kept job files, and serves 3MF via extraction', async () => {
    const libraryDir = path.join(dir, 'library');
    await fsp.mkdir(libraryDir);
    const service = new GcodeViewService(
      path.join(dir, 'job-files'),
      path.join(dir, 'extract'),
      async (name) => {
        const candidate = path.join(libraryDir, name);
        return (await fsp.stat(candidate).catch(() => null)) ? candidate : null;
      }
    );

    expect(await service.resolve('missing.gcode')).toBeNull();
    expect(await service.resolve('../etc/passwd')).toBeNull();

    const staged = path.join(dir, 'staged.gcode');
    await fsp.writeFile(staged, SAMPLE);
    await service.rememberJobFile('cube.gcode', staged);
    expect(await service.resolve('cube.gcode')).toMatchObject({ source: 'job' });

    await fsp.writeFile(path.join(libraryDir, 'cube.gcode'), SAMPLE);
    const fromLibrary = await service.resolve('cube.gcode');
    expect(fromLibrary).toMatchObject({
      source: 'library',
      gcodePath: path.join(libraryDir, 'cube.gcode'),
    });

    await fsp.writeFile(
      path.join(libraryDir, 'multi.gcode.3mf'),
      zipWith([{ name: 'Metadata/plate_1.gcode', data: Buffer.from(SAMPLE), deflate: true }])
    );
    const from3mf = await service.resolve('multi.gcode.3mf');
    const gcodePath = from3mf?.gcodePath ?? '';
    expect(gcodePath.endsWith('.gcode')).toBe(true);
    const index = await service.getIndex(gcodePath);
    expect(index.layers).toHaveLength(2);
    expect((await service.getLayer(gcodePath, 1)).paths).toHaveLength(3);
    // cached: a second request for the same file version reuses the index
    expect(await service.getIndex(gcodePath)).toBe(index);
  });

  it('keeps only the newest job files', async () => {
    const service = new GcodeViewService(
      path.join(dir, 'job-files'),
      path.join(dir, 'extract'),
      async () => null
    );
    const staged = path.join(dir, 'staged.gcode');
    await fsp.writeFile(staged, SAMPLE);
    for (let i = 0; i < 8; i++) {
      const target = path.join(dir, 'job-files', `job${i}.gcode`);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, SAMPLE);
      await fsp.utimes(target, new Date(), new Date(Date.now() - (8 - i) * 60000));
    }
    await service.rememberJobFile('newest.gcode', staged);
    const kept = (await fsp.readdir(path.join(dir, 'job-files'))).sort();
    expect(kept).toHaveLength(5);
    expect(kept).toContain('newest.gcode');
    expect(kept).toContain('job7.gcode');
    expect(kept).not.toContain('job0.gcode');
  });
});
