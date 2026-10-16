/**
 * @fileoverview Tests for the light timer: daily auto-off, one-shot timers,
 * restart behaviour, skipping while printing and retries.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  isValidTime,
  type LightTimerActions,
  LightTimerService,
  MAX_OFF_IN_MINUTES,
  nextOccurrence,
} from './LightTimerService';

const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 9, day, hour, minute, 0).getTime();

describe('LightTimerService', () => {
  let dir: string;
  let file: string;
  let clock: number;
  let lightOn: boolean | undefined;
  let printing: boolean;
  let turnOffResult: boolean;
  let actions: LightTimerActions & { turnOff: jest.Mock<(id: string) => Promise<boolean>> };

  const make = () => new LightTimerService(file, actions, () => clock);

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-light-'));
    file = path.join(dir, 'light-timer.json');
    clock = at(16, 21, 0);
    lightOn = true;
    printing = false;
    turnOffResult = true;
    actions = {
      contexts: () => ['ctx-1'],
      isLightOn: async () => lightOn,
      isPrinting: async () => printing,
      turnOff: jest.fn(async () => {
        if (turnOffResult) lightOn = false;
        return turnOffResult;
      }),
    };
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('turns the light off once at the set time, then again the next day', async () => {
    const service = make();
    await service.setDaily({ enabled: true, time: '22:00' });
    await service.tick(); // 21:00, too early
    expect(actions.turnOff).not.toHaveBeenCalled();

    clock = at(16, 22, 0);
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(1);

    lightOn = true; // switched on again at 22:03
    clock = at(16, 22, 3);
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(1); // today is used up

    lightOn = true;
    clock = at(17, 22, 1);
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the light is already off, and does not fire later that day', async () => {
    const service = make();
    await service.setDaily({ enabled: true, time: '22:00' });
    lightOn = false;
    clock = at(16, 22, 0);
    await service.tick();
    lightOn = true; // turned on deliberately at 22:10
    clock = at(16, 22, 10);
    await service.tick();
    expect(actions.turnOff).not.toHaveBeenCalled();
  });

  it('does not fire retroactively after downtime or when enabled after the time', async () => {
    const service = make();
    clock = at(16, 22, 30);
    await service.setDaily({ enabled: true, time: '22:00' }); // enabled at 22:30
    await service.tick();
    expect(actions.turnOff).not.toHaveBeenCalled();

    // a host that was down: first tick at 23:30 for a 23:00 schedule
    clock = at(17, 10, 0);
    await service.setDaily({ time: '23:00', enabled: true });
    clock = at(17, 23, 30);
    await service.tick();
    expect(actions.turnOff).not.toHaveBeenCalled();
    clock = at(18, 23, 0);
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(1);
  });

  it('can skip the daily auto-off while printing', async () => {
    const service = make();
    await service.setDaily({ enabled: true, time: '22:00', skipWhilePrinting: true });
    printing = true;
    for (const minute of [0, 1, 6]) {
      clock = at(16, 22, minute);
      await service.tick();
    }
    expect(actions.turnOff).not.toHaveBeenCalled();
    printing = false;
    clock = at(16, 22, 8); // the day was used up at 22:05
    await service.tick();
    expect(actions.turnOff).not.toHaveBeenCalled();

    await service.setDaily({ skipWhilePrinting: false });
    clock = at(17, 22, 0);
    printing = true;
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(1);
  });

  it('runs a one-shot timer, never skips for printing, and clears it', async () => {
    const service = make();
    const offAt = await service.offIn(30);
    expect(offAt).toBe(at(16, 21, 30));
    printing = true;
    clock = at(16, 21, 29);
    await service.tick();
    expect(actions.turnOff).not.toHaveBeenCalled();
    clock = at(16, 21, 30);
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(1);
    expect((await service.getState()).config.offAt).toBeNull();
  });

  it('keeps timers and settings across a restart, and acts late on an overdue one-shot', async () => {
    const first = make();
    await first.setDaily({ enabled: true, time: '22:15', skipWhilePrinting: true });
    await first.offIn(60);

    clock = at(17, 3, 0); // the Pi was off for hours
    const second = make();
    const state = await second.getState();
    expect(state.config.dailyOff).toEqual({ enabled: true, time: '22:15' });
    expect(state.config.skipWhilePrinting).toBe(true);
    expect(state.config.offAt).toBe(at(16, 22, 0));
    await second.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(1);
    expect((await make().getState()).config.offAt).toBeNull();
  });

  it('retries a failed command and gives up after the retry window', async () => {
    const service = make();
    await service.offIn(1);
    turnOffResult = false;
    clock = at(16, 21, 1);
    await service.tick();
    clock = at(16, 21, 3);
    await service.tick();
    expect(actions.turnOff).toHaveBeenCalledTimes(2);
    expect((await service.getState()).config.offAt).not.toBeNull();

    turnOffResult = true; // printer reachable again
    clock = at(16, 21, 4);
    await service.tick();
    expect((await service.getState()).config.offAt).toBeNull();
    expect(lightOn).toBe(false);

    await service.offIn(1);
    turnOffResult = false;
    lightOn = true;
    clock = at(16, 21, 5);
    await service.tick();
    clock = at(16, 21, 11);
    await service.tick();
    expect((await service.getState()).config.offAt).toBeNull(); // gave up
  });

  it('works with several printers and tolerates unknown light state', async () => {
    const states: Record<string, boolean | undefined> = { a: true, b: undefined, c: false };
    const multi: LightTimerActions & { turnOff: jest.Mock<(id: string) => Promise<boolean>> } = {
      contexts: () => ['a', 'b', 'c'],
      isLightOn: async (id) => states[id],
      isPrinting: async () => false,
      turnOff: jest.fn(async () => true),
    };
    const service = new LightTimerService(file, multi, () => clock);
    await service.offIn(1);
    clock = at(16, 21, 1);
    await service.tick();
    expect(multi.turnOff.mock.calls.map((call) => call[0])).toEqual(['a', 'b']); // c is already off
  });

  it('validates input and survives a corrupt state file', async () => {
    const service = make();
    await expect(service.setDaily({ time: '25:00' })).rejects.toThrow();
    await expect(service.setDaily({ time: '9:5' })).rejects.toThrow();
    for (const bad of [0, -5, 1.5, MAX_OFF_IN_MINUTES + 1, Number.NaN]) {
      await expect(service.offIn(bad)).rejects.toThrow();
    }
    await fsp.writeFile(file, '{ not json');
    expect((await make().getState()).config).toMatchObject({
      offAt: null,
      dailyOff: { enabled: false, time: '22:00' },
    });
    await fsp.writeFile(
      file,
      JSON.stringify({ dailyOff: { enabled: 'yes', time: '99:99' }, offAt: 'soon' })
    );
    expect((await make().getState()).config).toMatchObject({
      offAt: null,
      dailyOff: { enabled: false, time: '22:00' },
    });
  });

  it('reports the next daily time and the host clock', async () => {
    const service = make();
    await service.setDaily({ enabled: true, time: '22:00' });
    const state = await service.getState();
    expect(state.nextDailyAt).toBe(at(16, 22, 0));
    expect(state.localTime).toBe('21:00');
    clock = at(16, 22, 0);
    expect(nextOccurrence('22:00', clock)).toBe(at(17, 22, 0));
    expect(isValidTime('07:30')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
  });
});
