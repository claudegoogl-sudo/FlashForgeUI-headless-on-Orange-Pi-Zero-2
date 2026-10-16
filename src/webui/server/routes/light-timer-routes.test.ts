/**
 * @fileoverview Route tests for the light timer: state reporting, validation and
 * the one-shot countdown.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import { type LightTimerActions, LightTimerService } from '../../../services/LightTimerService';
import { registerLightTimerRoutes } from './light-timer-routes';
import { startTestServer, type TestServerHandle } from './test-server';

interface TimerResponse {
  success: boolean;
  error?: string;
  supported: boolean;
  lightOn?: boolean;
  remainingSeconds: number | null;
  config: {
    dailyOff: { enabled: boolean; time: string };
    skipWhilePrinting: boolean;
    offAt: number | null;
  };
}

describe('light-timer-routes', () => {
  let dir: string;
  let server: TestServerHandle;
  let contexts: string[];
  let lightOn: boolean | undefined;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-lightroutes-'));
    contexts = ['ctx-1'];
    lightOn = true;
    const actions: LightTimerActions = {
      contexts: () => contexts,
      isLightOn: async () => lightOn,
      isPrinting: async () => false,
      turnOff: async () => true,
    };
    const service = new LightTimerService(path.join(dir, 'light-timer.json'), actions);
    server = await startTestServer((app: express.Application) => {
      const router = express.Router();
      registerLightTimerRoutes(router, service, actions);
      app.use('/api', router);
    });
  });

  afterEach(async () => {
    await server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const get = async () =>
    (await (await fetch(`${server.baseUrl}/api/light-timer`)).json()) as TimerResponse;
  const post = (url: string, body: unknown) =>
    fetch(`${server.baseUrl}/api/light-timer${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('reports defaults, light state and support', async () => {
    expect(await get()).toMatchObject({
      success: true,
      supported: true,
      lightOn: true,
      remainingSeconds: null,
      config: {
        dailyOff: { enabled: false, time: '22:00' },
        skipWhilePrinting: false,
        offAt: null,
      },
    });
    lightOn = false;
    expect((await get()).lightOn).toBe(false);
    lightOn = undefined;
    expect((await get()).lightOn).toBeUndefined();
    contexts = [];
    expect((await get()).supported).toBe(false);
  });

  it('saves the daily settings and rejects bad input', async () => {
    const ok = await post('', {
      dailyOff: { enabled: true, time: '23:15' },
      skipWhilePrinting: true,
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as TimerResponse).config).toMatchObject({
      dailyOff: { enabled: true, time: '23:15' },
      skipWhilePrinting: true,
    });
    for (const bad of [
      { dailyOff: { time: '25:00' } },
      { dailyOff: { time: 2200 } },
      { dailyOff: { enabled: 'yes' } },
      { skipWhilePrinting: 1 },
    ]) {
      expect((await post('', bad)).status).toBe(400);
    }
    expect((await get()).config.dailyOff).toEqual({ enabled: true, time: '23:15' });
  });

  it('starts, reports and cancels a one-shot timer', async () => {
    const res = await post('/off-in', { minutes: 30 });
    expect(res.status).toBe(200);
    const started = (await res.json()) as TimerResponse;
    expect(started.config.offAt).not.toBeNull();
    expect(started.remainingSeconds).toBeGreaterThan(1790);
    expect(started.remainingSeconds).toBeLessThanOrEqual(1800);

    for (const bad of [{}, { minutes: 0 }, { minutes: 1.5 }, { minutes: '30' }, { minutes: 721 }]) {
      expect((await post('/off-in', bad)).status).toBe(400);
    }
    expect((await get()).config.offAt).toBe(started.config.offAt);

    const cancelled = (await (await post('/cancel', {})).json()) as TimerResponse;
    expect(cancelled.config.offAt).toBeNull();
    expect(cancelled.remainingSeconds).toBeNull();
  });
});
