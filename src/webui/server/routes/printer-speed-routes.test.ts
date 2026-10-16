/**
 * @fileoverview Tests for the print speed override: the exact printerCtl_cmd payload
 * (partial update, so Z offset and fans are never touched) and the route guards.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import { Creator5Backend } from '../../../printer-backends/Creator5Backend';
import { registerPrinterControlRoutes } from './printer-control-routes';
import { startTestServer, type TestServerHandle } from './test-server';

type SendControl = (command: string, args: object) => Promise<boolean>;

function createCreator5Backend(sendControlCommand: jest.Mock<SendControl>): Creator5Backend {
  const backend = Object.create(Creator5Backend.prototype) as Creator5Backend;
  (backend as unknown as { fiveMClient: unknown }).fiveMClient = {
    control: { sendControlCommand },
  };
  return backend;
}

describe('Creator5Backend.setPrintSpeed', () => {
  let send: jest.Mock<SendControl>;
  let backend: Creator5Backend;

  beforeEach(() => {
    send = jest.fn<SendControl>(async () => true);
    backend = createCreator5Backend(send);
  });

  it('sends only the speed; Z offset and both fans are marked "leave unchanged" (-200)', async () => {
    const result = await backend.setPrintSpeed(140);
    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('printerCtl_cmd', {
      zAxisCompensation: -200,
      speed: 140,
      chamberFan: -200,
      coolingFan: -200,
    });
  });

  it('accepts the range limits and rejects everything else without sending', async () => {
    expect((await backend.setPrintSpeed(50)).success).toBe(true);
    expect((await backend.setPrintSpeed(200)).success).toBe(true);
    send.mockClear();
    for (const bad of [49, 201, 0, -200, 100.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await backend.setPrintSpeed(bad)).success).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('reports a rejected command and a thrown error as failures', async () => {
    send.mockResolvedValueOnce(false);
    expect(await backend.setPrintSpeed(120)).toMatchObject({ success: false });
    send.mockRejectedValueOnce(new Error('socket closed'));
    expect(await backend.setPrintSpeed(120)).toMatchObject({
      success: false,
      error: 'socket closed',
    });
  });
});

describe('POST /printer/control/speed', () => {
  let server: TestServerHandle;
  let send: jest.Mock<SendControl>;
  let printerState: string | undefined;
  let backend: unknown;

  beforeEach(async () => {
    send = jest.fn<SendControl>(async () => true);
    backend = createCreator5Backend(send);
    printerState = 'printing';
    const deps = {
      backendManager: {
        isBackendReady: jest.fn(() => true),
        getBackendForContext: jest.fn(() => backend),
        getPrinterStatus: jest.fn(async () => ({ success: true, status: { printerState } })),
      },
      contextManager: {
        getActiveContextId: jest.fn(() => 'ctx-1'),
        getContext: jest.fn(() => ({ id: 'ctx-1' })),
      },
    };
    server = await startTestServer((app: express.Application) => {
      const router = express.Router();
      // biome-ignore lint/suspicious/noExplicitAny: partial test doubles
      registerPrinterControlRoutes(router, deps as any);
      app.use('/api', router);
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const post = (body: unknown) =>
    fetch(`${server.baseUrl}/api/printer/control/speed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sets the speed of a printing or paused job', async () => {
    for (const state of ['printing', 'Printing', 'paused']) {
      printerState = state;
      const res = await post({ speed: 160 });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        success: true,
        message: 'Print speed set to 160 %',
      });
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][1]).toEqual({
      zAxisCompensation: -200,
      speed: 160,
      chamberFan: -200,
      coolingFan: -200,
    });
  });

  it('refuses outside a running job without touching the printer', async () => {
    for (const state of ['ready', 'completed', 'busy', 'heating', 'error', undefined]) {
      printerState = state;
      expect((await post({ speed: 100 })).status).toBe(409);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('validates the value', async () => {
    for (const body of [
      {},
      { speed: '120' },
      { speed: 49 },
      { speed: 201 },
      { speed: 99.5 },
      { speed: null },
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('is limited to the Creator 5 series and reports printer failures', async () => {
    backend = {};
    expect((await post({ speed: 100 })).status).toBe(400);
    backend = createCreator5Backend(send);
    send.mockResolvedValueOnce(false);
    expect((await post({ speed: 100 })).status).toBe(502);
  });
});
