/**
 * @fileoverview Tests for the host-side job file library (name validation,
 * streamed saves, size limits, rename/delete and temp-file cleanup).
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  FileLibraryError,
  FileLibraryService,
  validateLibraryFileName,
} from './FileLibraryService';

function streamOf(content: string | Buffer): Readable {
  return Readable.from([Buffer.isBuffer(content) ? content : Buffer.from(content)]);
}

describe('validateLibraryFileName', () => {
  it.each([
    'part.gcode',
    'Part 2.GX',
    'multi color (v3).3mf',
    'Ölwanne.gcode',
  ])('accepts %s', (name) => {
    expect(validateLibraryFileName(`  ${name} `)).toBe(name);
  });

  it.each([
    '',
    '.',
    '..',
    '../etc/passwd.gcode',
    'a/b.gcode',
    'a\\b.gcode',
    '.hidden.gcode',
    'evil\u0000.gcode',
    'notes.txt',
    'noext',
    `${'x'.repeat(200)}.gcode`,
  ])('rejects %j', (name) => {
    expect(() => validateLibraryFileName(name)).toThrow(FileLibraryError);
  });

  it('rejects non-strings', () => {
    expect(() => validateLibraryFileName(undefined)).toThrow(FileLibraryError);
  });
});

describe('FileLibraryService', () => {
  let dir: string;
  let library: FileLibraryService;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-lib-'));
    library = new FileLibraryService(path.join(dir, 'library'), {
      maxFileBytes: 1024,
      minFreeBytes: 0,
    });
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('saves, lists, stats and removes a file', async () => {
    const saved = await library.save('a.gcode', streamOf('G28\n'));
    expect(saved).toMatchObject({ name: 'a.gcode', size: 4 });
    expect((await library.list()).map((f) => f.name)).toEqual(['a.gcode']);
    await library.remove('a.gcode');
    expect(await library.list()).toEqual([]);
  });

  it('refuses to overwrite unless asked', async () => {
    await library.save('a.gcode', streamOf('one'));
    await expect(library.save('a.gcode', streamOf('two'))).rejects.toMatchObject({
      statusCode: 409,
    });
    await library.save('a.gcode', streamOf('three'), { overwrite: true });
    expect((await library.stat('a.gcode')).size).toBe(5);
  });

  it('rejects oversized uploads by header and by stream, leaving no temp files', async () => {
    await expect(
      library.save('big.gcode', streamOf('x'), { declaredSize: 4096 })
    ).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(library.save('big.gcode', streamOf(Buffer.alloc(2048)))).rejects.toMatchObject({
      statusCode: 413,
    });
    expect(await fsp.readdir(library.directory)).toEqual([]);
  });

  it('rejects empty uploads', async () => {
    await expect(library.save('empty.gcode', Readable.from([]))).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await fsp.readdir(library.directory)).toEqual([]);
  });

  it('renames, including refusing to clobber', async () => {
    await library.save('a.gcode', streamOf('a'));
    await library.save('b.gcode', streamOf('b'));
    await expect(library.rename('a.gcode', 'b.gcode')).rejects.toMatchObject({ statusCode: 409 });
    await library.rename('a.gcode', 'c.3mf');
    expect((await library.list()).map((f) => f.name).sort()).toEqual(['b.gcode', 'c.3mf']);
    await library.rename('c.3mf', 'b.gcode', true);
    expect((await library.list()).map((f) => f.name)).toEqual(['b.gcode']);
  });

  it('reports 404 for missing files and ignores foreign files in listings', async () => {
    await expect(library.stat('missing.gcode')).rejects.toMatchObject({ statusCode: 404 });
    await expect(library.remove('missing.gcode')).rejects.toMatchObject({ statusCode: 404 });
    await fsp.mkdir(library.directory, { recursive: true });
    await fsp.writeFile(path.join(library.directory, 'readme.txt'), 'x');
    await fsp.writeFile(path.join(library.directory, '.upload-abc.part'), 'x');
    expect(await library.list()).toEqual([]);
    await library.cleanupTempFiles();
    expect(await fsp.readdir(library.directory)).toEqual(['readme.txt']);
  });

  it('never resolves outside the library directory', () => {
    expect(() => library.resolvePath('../x.gcode')).toThrow(FileLibraryError);
    expect(path.dirname(library.resolvePath('x.gcode'))).toBe(path.resolve(library.directory));
  });
});
