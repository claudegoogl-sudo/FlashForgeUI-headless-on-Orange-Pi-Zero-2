/**
 * @fileoverview Route tests for the WebUI file manager (library CRUD over HTTP
 * and the busy-printer guard on "send to printer").
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import { FileLibraryService } from '../../../services/FileLibraryService';
import { registerFileLibraryRoutes } from './file-library-routes';
import { startTestServer, type TestServerHandle } from './test-server';

jest.mock('@parallel-7/slicer-meta', () => ({
  parseSlicerFile: jest.fn(async () => ({
    slicer: { slicerName: 'OrcaSlicer', slicerVersion: '2.3.0', printEta: '1h 2m' },
    file: {
      thumbnail: 'iVBORw0KGgo=',
      filamentUsedG: 12.5,
      filamentUsedMM: 4000,
      filamentType: 'PLA',
    },
    threeMf: null,
  })),
}));

describe('file-library-routes', () => {
  let dir: string;
  let server: TestServerHandle;
  let printerState: string | undefined;
  let hasMaterialStation: boolean;
  const startJob = jest.fn<(...args: unknown[]) => Promise<unknown>>();

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-routes-'));
    printerState = 'Ready';
    hasMaterialStation = true;
    startJob.mockReset().mockResolvedValue({ success: true, fileName: 'a.gcode', started: false });
    const library = new FileLibraryService(dir, { minFreeBytes: 0 });
    const deps = {
      backendManager: {
        isBackendReady: jest.fn().mockReturnValue(true),
        isFeatureAvailable: jest.fn(() => hasMaterialStation),
        getPrinterStatus: jest.fn(async () => ({ success: true, status: { printerState } })),
        startJob,
      },
      contextManager: {
        getActiveContextId: jest.fn().mockReturnValue('ctx-1'),
        getContext: jest.fn().mockReturnValue({ id: 'ctx-1' }),
      },
    };
    server = await startTestServer((app: express.Application) => {
      const router = express.Router();
      registerFileLibraryRoutes(router, deps as any, library);
      app.use('/api', router);
    });
  });

  afterEach(async () => {
    await server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function upload(name: string, body: string, query = '') {
    return fetch(`${server.baseUrl}/api/files/library/${encodeURIComponent(name)}${query}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
  }

  it('uploads, lists, downloads, renames and deletes', async () => {
    expect((await upload('part one.gcode', 'G28\nG1 X1\n')).status).toBe(201);
    expect((await upload('part one.gcode', 'again')).status).toBe(409);
    expect((await upload('part one.gcode', 'again', '?overwrite=1')).status).toBe(201);

    const list = (await (await fetch(`${server.baseUrl}/api/files/library`)).json()) as {
      files: { name: string }[];
    };
    expect(list.files.map((f: { name: string }) => f.name)).toEqual(['part one.gcode']);

    const download = await fetch(`${server.baseUrl}/api/files/library/part%20one.gcode/download`);
    expect(await download.text()).toBe('again');

    const renamed = await fetch(`${server.baseUrl}/api/files/library/part%20one.gcode/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newName: 'part-two.gcode' }),
    });
    expect(renamed.status).toBe(200);

    const removed = await fetch(`${server.baseUrl}/api/files/library/part-two.gcode`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('rejects bad names and traversal attempts', async () => {
    expect((await upload('notes.txt', 'x')).status).toBe(400);
    expect((await upload('..%2F..%2Fescape.gcode', 'x')).status).toBe(400);
    expect((await upload('.hidden.gcode', 'x')).status).toBe(400);
    expect(await fsp.readdir(dir)).toEqual([]);
  });

  it('returns metadata with a data-URL thumbnail', async () => {
    await upload('a.gcode', 'G28\n');
    const res = (await (
      await fetch(`${server.baseUrl}/api/files/library/a.gcode/meta`)
    ).json()) as { meta: unknown };
    expect(res.meta).toMatchObject({
      thumbnail: 'data:image/png;base64,iVBORw0KGgo=',
      printEta: '1h 2m',
      filamentWeightGrams: 12.5,
      filamentType: 'PLA',
      slicer: 'OrcaSlicer 2.3.0',
    });
  });

  it('sends to the printer only when idle, upload-only by default', async () => {
    await upload('a.gcode', 'G28\n');
    const send = () =>
      fetch(`${server.baseUrl}/api/files/library/a.gcode/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

    for (const state of [
      'printing',
      'Printing',
      'paused',
      'pausing',
      'heating',
      'calibrate_doing',
      'busy',
      'error',
      'weird',
    ]) {
      printerState = state;
      expect((await send()).status).toBe(409);
    }
    expect(startJob).not.toHaveBeenCalled();

    printerState = undefined;
    expect((await send()).status).toBe(503);
    expect(startJob).not.toHaveBeenCalled();

    printerState = 'completed';
    const ok = await send();
    expect(ok.status).toBe(200);
    expect(startJob).toHaveBeenCalledWith('ctx-1', {
      operation: 'start',
      fileName: 'a.gcode',
      filePath: path.join(dir, 'a.gcode'),
      startNow: false,
      leveling: false,
    });
  });

  it('accepts the idle states in either case', async () => {
    await upload('a.gcode', 'G28\n');
    for (const state of [
      'ready',
      'Ready',
      'READY',
      'idle',
      'completed',
      'Completed',
      'cancel',
      'Cancelled',
    ]) {
      printerState = state;
      const res = await fetch(`${server.baseUrl}/api/files/library/a.gcode/send`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
    }
    expect(startJob).toHaveBeenCalledTimes(8);
  });

  it('reports printer upload failures as 502', async () => {
    await upload('a.gcode', 'G28\n');
    startJob.mockResolvedValue({ success: false, error: 'Failed to upload and start job' });
    const res = await fetch(`${server.baseUrl}/api/files/library/a.gcode/send`, { method: 'POST' });
    expect(res.status).toBe(502);
  });

  it('404s for unknown files', async () => {
    expect((await fetch(`${server.baseUrl}/api/files/library/nope.gcode/meta`)).status).toBe(404);
    expect(
      (await fetch(`${server.baseUrl}/api/files/library/nope.gcode`, { method: 'DELETE' })).status
    ).toBe(404);
  });

  it('stages a library 3MF for the upload dialog and refuses other files on material-station printers', async () => {
    await upload('multi.3mf', 'PK-not-really-a-zip');
    await upload('single.gcode', 'G28\n');
    const stage = (name: string) =>
      fetch(`${server.baseUrl}/api/files/library/${name}/stage`, { method: 'POST' });

    const ok = await stage('multi.3mf');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      uploadId: string;
      fileName: string;
      requiresMaterialMatching: boolean;
    };
    expect(body).toMatchObject({
      success: true,
      fileName: 'multi.3mf',
      requiresMaterialMatching: true,
    });
    expect(typeof body.uploadId).toBe('string');

    expect((await stage('single.gcode')).status).toBe(400);
    hasMaterialStation = false;
    const plain = await stage('single.gcode');
    expect(plain.status).toBe(200);
    expect(
      ((await plain.json()) as { requiresMaterialMatching: boolean }).requiresMaterialMatching
    ).toBe(false);
    expect((await stage('missing.3mf')).status).toBe(404);
    // the library copy is untouched
    expect((await fsp.readdir(dir)).sort()).toEqual(['multi.3mf', 'single.gcode']);
  });
});
