/**
 * @fileoverview Per-job filament usage derived from the printer's lifetime filament counter.
 *
 * Some firmware (Creator 5 1.9.x) reports 0 for every estimated length/weight field,
 * so the job's filament usage is not available from the status response. The lifetime
 * counter (`cumulativeFilament`, metres) does advance during a print, so the length used
 * by the current job is the counter now minus the counter at job start. Weight is
 * estimated from that length, 1.75 mm filament and the density of the loaded material.
 *
 * The tracker only reports a job it has followed from the start (or from persisted
 * state after an app restart); joining a print half-way returns null rather than an
 * under-count.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Cross-section of 1.75 mm filament in mm², which equals cm³ per metre. */
const FILAMENT_CM3_PER_METRE = Math.PI * (1.75 / 2) ** 2;
const DEFAULT_DENSITY = 1.24;
/** Density in g/cm³ by material name prefix (longest match wins). */
const MATERIAL_DENSITIES: ReadonlyArray<readonly [string, number]> = [
  ['PETG', 1.27],
  ['PCTG', 1.23],
  ['PET', 1.27],
  ['PLA', 1.24],
  ['ABS', 1.04],
  ['ASA', 1.07],
  ['TPU', 1.21],
  ['TPE', 1.2],
  ['PA', 1.14],
  ['NYLON', 1.14],
  ['PC', 1.2],
  ['PP', 0.9],
  ['HIPS', 1.04],
  ['PVA', 1.23],
];

/** A job counts as "seen from the start" when first observed within this many seconds. */
const START_WINDOW_SECONDS = 180;
/** Tolerance when comparing print durations between samples. */
const DURATION_TOLERANCE_SECONDS = 60;

export function gramsPerMetre(materialName?: string | null): number {
  const name = (materialName ?? '').trim().toUpperCase();
  let density = DEFAULT_DENSITY;
  let matched = 0;
  for (const [prefix, value] of MATERIAL_DENSITIES) {
    if (name.startsWith(prefix) && prefix.length > matched) {
      density = value;
      matched = prefix.length;
    }
  }
  return FILAMENT_CM3_PER_METRE * density;
}

export interface FilamentUsageSample {
  /** Job file name as reported by the printer. */
  readonly job: string;
  /** Seconds the job has been printing, as reported by the printer. */
  readonly printDurationSeconds: number;
  /** Lifetime filament counter in metres. */
  readonly cumulativeFilamentMetres: number;
  /** Material in the active toolhead/slot, used for the weight estimate. */
  readonly materialName?: string | null;
}

export interface FilamentUsage {
  readonly lengthMetres: number;
  readonly weightGrams: number;
}

interface TrackerState {
  job: string;
  /** False when the job was first seen mid-print: nothing is reported for it. */
  tracked: boolean;
  baselineMetres: number;
  lastMetres: number;
  lastDurationSeconds: number;
  weightGrams: number;
}

export interface FilamentUsageStore {
  load(): unknown;
  save(state: unknown): void;
}

/** JSON file store; all errors are swallowed (tracking then simply restarts). */
export function createFileUsageStore(filePath: string): FilamentUsageStore {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        return null;
      }
    },
    save(state) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(state));
      } catch {
        // best effort
      }
    },
  };
}

function isTrackerState(value: unknown): value is TrackerState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.job === 'string' &&
    typeof v.tracked === 'boolean' &&
    [v.baselineMetres, v.lastMetres, v.lastDurationSeconds, v.weightGrams].every(
      (n) => typeof n === 'number' && Number.isFinite(n)
    )
  );
}

export class FilamentUsageTracker {
  private state: TrackerState | null = null;
  private loaded = false;

  constructor(private readonly store?: FilamentUsageStore) {}

  /**
   * Feed one status sample taken while a job is printing or paused.
   * @returns usage so far for this job, or null if the job was not followed from its start.
   */
  public update(sample: FilamentUsageSample): FilamentUsage | null {
    if (
      !sample.job ||
      !Number.isFinite(sample.cumulativeFilamentMetres) ||
      sample.cumulativeFilamentMetres <= 0
    ) {
      return null;
    }
    if (!this.loaded) {
      this.loaded = true;
      const stored = this.store?.load();
      this.state = isTrackerState(stored) ? stored : null;
    }

    const duration = Math.max(0, sample.printDurationSeconds || 0);
    const metres = sample.cumulativeFilamentMetres;
    const previous = this.state;
    const sameJob =
      previous !== null &&
      previous.job === sample.job &&
      duration + DURATION_TOLERANCE_SECONDS >= previous.lastDurationSeconds &&
      metres + 0.01 >= previous.lastMetres;

    if (!sameJob || previous === null) {
      this.state = {
        job: sample.job,
        tracked: duration <= START_WINDOW_SECONDS,
        baselineMetres: metres,
        lastMetres: metres,
        lastDurationSeconds: duration,
        weightGrams: 0,
      };
      this.store?.save(this.state);
      return this.result();
    }

    const delta = Math.max(0, metres - previous.lastMetres);
    previous.lastDurationSeconds = Math.max(previous.lastDurationSeconds, duration);
    if (delta > 0) {
      previous.lastMetres = metres;
      previous.weightGrams += delta * gramsPerMetre(sample.materialName);
      this.store?.save(previous);
    }
    return this.result();
  }

  private result(): FilamentUsage | null {
    if (!this.state || !this.state.tracked) {
      return null;
    }
    return {
      lengthMetres: Math.max(0, this.state.lastMetres - this.state.baselineMetres),
      weightGrams: this.state.weightGrams,
    };
  }
}
