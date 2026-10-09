/**
 * @fileoverview Tests for per-job filament usage derived from the lifetime counter.
 */
import { describe, expect, it } from '@jest/globals';
import {
  type FilamentUsageStore,
  FilamentUsageTracker,
  gramsPerMetre,
} from './FilamentUsageTracker';

function memoryStore(initial: unknown = null): FilamentUsageStore & { value: unknown } {
  const store = {
    value: initial,
    load: () => store.value,
    save: (state: unknown) => {
      store.value = JSON.parse(JSON.stringify(state));
    },
  };
  return store;
}

describe('gramsPerMetre', () => {
  it('uses material density for 1.75 mm filament', () => {
    expect(gramsPerMetre('PLA')).toBeCloseTo(2.98, 2);
    expect(gramsPerMetre('PETG-CF')).toBeCloseTo(3.05, 2);
    expect(gramsPerMetre('TPU-90A')).toBeCloseTo(2.91, 2);
    expect(gramsPerMetre('ABS')).toBeCloseTo(2.5, 2);
    expect(gramsPerMetre('pet')).toBeCloseTo(3.05, 2);
  });

  it('falls back to PLA density for unknown or missing names', () => {
    expect(gramsPerMetre('Mystery')).toBeCloseTo(gramsPerMetre('PLA'), 6);
    expect(gramsPerMetre(undefined)).toBeCloseTo(gramsPerMetre('PLA'), 6);
  });
});

describe('FilamentUsageTracker', () => {
  const sample = (
    printDurationSeconds: number,
    cumulativeFilamentMetres: number,
    job = 'a.gcode',
    materialName = 'PLA'
  ) => ({
    job,
    printDurationSeconds,
    cumulativeFilamentMetres,
    materialName,
  });

  it('measures length and weight from the start of a job', () => {
    const tracker = new FilamentUsageTracker();
    expect(tracker.update(sample(20, 1000))).toEqual({ lengthMetres: 0, weightGrams: 0 });
    const usage = tracker.update(sample(600, 1002.5));
    expect(usage?.lengthMetres).toBeCloseTo(2.5, 6);
    expect(usage?.weightGrams).toBeCloseTo(2.5 * gramsPerMetre('PLA'), 6);
  });

  it('weighs each stretch with the material active at the time', () => {
    const tracker = new FilamentUsageTracker();
    tracker.update(sample(10, 500, 'multi.3mf', 'PLA'));
    tracker.update(sample(300, 501, 'multi.3mf', 'PLA'));
    const usage = tracker.update(sample(600, 503, 'multi.3mf', 'TPU-90A'));
    expect(usage?.lengthMetres).toBeCloseTo(3, 6);
    expect(usage?.weightGrams).toBeCloseTo(1 * gramsPerMetre('PLA') + 2 * gramsPerMetre('TPU'), 6);
  });

  it('reports nothing for a job first seen mid-print', () => {
    const tracker = new FilamentUsageTracker();
    expect(tracker.update(sample(3600, 1000))).toBeNull();
    expect(tracker.update(sample(3700, 1001))).toBeNull();
  });

  it('starts over for a new job, including a reprint of the same file', () => {
    const tracker = new FilamentUsageTracker();
    tracker.update(sample(10, 1000));
    tracker.update(sample(900, 1004));
    expect(tracker.update(sample(15, 1004.2, 'b.gcode'))).toEqual({
      lengthMetres: 0,
      weightGrams: 0,
    });
    tracker.update(sample(800, 1006, 'b.gcode'));
    // same file again: duration jumps back
    expect(tracker.update(sample(12, 1006.1, 'b.gcode'))).toEqual({
      lengthMetres: 0,
      weightGrams: 0,
    });
  });

  it('keeps tracking across an app restart via the store', () => {
    const store = memoryStore();
    const first = new FilamentUsageTracker(store);
    first.update(sample(10, 1000));
    first.update(sample(900, 1003));

    const second = new FilamentUsageTracker(store);
    const usage = second.update(sample(1500, 1004));
    expect(usage?.lengthMetres).toBeCloseTo(4, 6);
    expect(usage?.weightGrams).toBeCloseTo(4 * gramsPerMetre('PLA'), 6);
  });

  it('survives pauses (duration stalls) and ignores bad samples or corrupt stores', () => {
    const tracker = new FilamentUsageTracker(memoryStore({ nonsense: true }));
    tracker.update(sample(10, 1000));
    tracker.update(sample(500, 1002));
    expect(tracker.update(sample(500, 1002))?.lengthMetres).toBeCloseTo(2, 6);
    expect(tracker.update(sample(480, 1002.5))?.lengthMetres).toBeCloseTo(2.5, 6);
    expect(tracker.update(sample(600, 0))).toBeNull();
    expect(tracker.update({ ...sample(600, 1003), job: '' })).toBeNull();
    expect(tracker.update(sample(620, 1003))?.lengthMetres).toBeCloseTo(3, 6);
  });
});
