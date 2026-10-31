/**
 * @fileoverview Tests for the library auto-sync queue: ordering, idle-only sending,
 * first-run baseline, restart safety, retries and the printer cleanup policy.
 */
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  type AutoSyncPrinter,
  AutoSyncService,
  type AutoSyncSettings,
  backoffMs,
  MAX_ATTEMPTS,
  MIN_CLEANUP_AGE_MS,
  pickCleanupCandidates,
  type SyncRecord,
} from './AutoSyncService';
import { FileLibraryService } from './FileLibraryService';

const HOUR = 60 * 60 * 1000;

describe('AutoSyncService', () => {
  let root: string;
  let dir: string;
  let library: FileLibraryService;
  let stateFile: string;
  let clock: number;
  let ready: boolean;
  let confirmed: boolean;
  let connected: boolean;
  let onPrinter: string[] | undefined;
  let sendResult: { success: boolean; error?: string };
  let currentJob: string | undefined;
  let canDelete: boolean;
  let settings: AutoSyncSettings;
  let sent: string[];
  let deleted: string[];
  let printer: AutoSyncPrinter;

  const put = async (name: string, content = 'G28\n') => {
    await fsp.writeFile(path.join(dir, name), content);
    clock += 1000;
    const when = new Date(clock);
    await fsp.utimes(path.join(dir, name), when, when);
  };
  const make = () =>
    new AutoSyncService(
      stateFile,
      library,
      printer,
      () => settings,
      () => clock
    );
  const records = async (): Promise<SyncRecord[]> =>
    (JSON.parse(await fsp.readFile(stateFile, 'utf8')) as { files: SyncRecord[] }).files;
  const stateOf = async (name: string) => (await records()).find((r) => r.name === name)?.state;

  /** A started service: baseline taken for what is in the library now. */
  const started = async (...baselineFiles: string[]) => {
    for (const name of baselineFiles) await put(name);
    const service = make();
    await service.tick();
    return service;
  };

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'ffui-sync-'));
    dir = path.join(root, 'library');
    library = new FileLibraryService(dir, { minFreeBytes: 0 });
    await fsp.mkdir(dir);
    stateFile = path.join(root, 'library-sync.json');
    clock = Date.parse('2026-10-01T10:00:00Z');
    ready = true;
    confirmed = true;
    connected = true;
    onPrinter = [];
    sendResult = { success: true };
    currentJob = undefined;
    canDelete = true;
    settings = { enabled: true, cleanup: { enabled: false, dryRun: false, keepNewest: 2 } };
    sent = [];
    deleted = [];
    printer = {
      activeContext: () => (connected ? 'ctx-1' : undefined),
      isReady: () => ready,
      confirmReady: async () => confirmed,
      listFiles: async () => onPrinter,
      send: jest.fn(async (_ctx: string, name: string) => {
        sent.push(name);
        return sendResult;
      }),
      currentJobFile: () => currentJob,
      canDelete: () => canDelete,
      deleteFile: jest.fn(async (_ctx: string, name: string) => {
        deleted.push(name);
        return { success: true };
      }),
    };
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  describe('first run', () => {
    it('does not queue existing files: synced when on the printer, else not synced', async () => {
      onPrinter = ['on.gcode'];
      await started('on.gcode', 'off.gcode');
      expect(sent).toEqual([]);
      expect(await stateOf('on.gcode')).toBe('synced');
      expect(await stateOf('off.gcode')).toBe('unsynced');
    });

    it('waits for the printer to be ready before checking its file list', async () => {
      ready = false;
      onPrinter = ['on.gcode'];
      const service = await started('on.gcode');
      expect(await stateOf('on.gcode')).toBe('unsynced');
      ready = true;
      await service.tick();
      expect(await stateOf('on.gcode')).toBe('synced');
      expect(sent).toEqual([]);
    });

    it('keeps baseline files "synced" without a sync time, so cleanup never touches them', async () => {
      onPrinter = ['on.gcode'];
      await started('on.gcode');
      const [record] = await records();
      expect(record.syncedAt).toBeUndefined();
    });

    it('queues files that arrive after the baseline', async () => {
      const service = await started('old.gcode');
      await put('new.gcode');
      await service.tick();
      expect(sent).toEqual(['new.gcode']);
      expect(await stateOf('new.gcode')).toBe('synced');
      expect(await stateOf('old.gcode')).toBe('unsynced');
    });
  });

  describe('queue', () => {
    it('sends one file per tick, oldest queued first', async () => {
      const service = await started();
      ready = false;
      await put('c.gcode');
      await service.tick();
      await put('a.gcode');
      await service.tick();
      ready = true;
      await service.tick();
      expect(sent).toEqual(['c.gcode']);
      await service.tick();
      expect(sent).toEqual(['c.gcode', 'a.gcode']);
    });

    it('sends nothing while the printer is not ready, and nothing is asked of it', async () => {
      const service = await started();
      ready = false;
      await put('a.gcode');
      await service.tick();
      expect(sent).toEqual([]);
      expect(await stateOf('a.gcode')).toBe('queued');
    });

    it('does not send when the fresh status check says the printer is busy', async () => {
      const service = await started();
      confirmed = false;
      await put('a.gcode');
      await service.tick();
      expect(sent).toEqual([]);
      expect(await stateOf('a.gcode')).toBe('queued');
      expect((await records())[0].attempts).toBe(0);
      confirmed = true;
      await service.tick();
      expect(sent).toEqual(['a.gcode']);
    });

    it('keeps files queued while no printer is connected', async () => {
      const service = await started();
      connected = false;
      await put('a.gcode');
      await service.tick();
      expect(sent).toEqual([]);
      connected = true;
      await service.tick();
      expect(sent).toEqual(['a.gcode']);
    });

    it('queues an overwritten file again', async () => {
      const service = await started();
      await put('a.gcode', 'v1');
      await service.tick();
      expect(await stateOf('a.gcode')).toBe('synced');
      await put('a.gcode', 'version two');
      ready = false;
      await service.tick();
      expect(await stateOf('a.gcode')).toBe('queued');
      ready = true;
      await service.tick();
      expect(sent).toEqual(['a.gcode', 'a.gcode']);
    });

    it('stays queued when the file is replaced while it is being sent', async () => {
      const service = await started();
      await put('a.gcode', 'v1');
      (printer.send as jest.Mock<AutoSyncPrinter['send']>).mockImplementationOnce(async () => {
        await put('a.gcode', 'version two');
        return { success: true };
      });
      await service.tick();
      expect(await stateOf('a.gcode')).toBe('synced'); // reconciled on the next pass
      await service.tick();
      expect(sent).toEqual(['a.gcode']);
    });

    it('drops records of deleted files that were never synced', async () => {
      const service = await started();
      ready = false;
      await put('a.gcode');
      await service.tick();
      await fsp.rm(path.join(dir, 'a.gcode'));
      await service.tick();
      expect(await records()).toEqual([]);
    });

    it('does nothing when switched off, and shows new files as not synced', async () => {
      settings.enabled = false;
      const service = await started();
      await put('a.gcode');
      await service.tick();
      expect(sent).toEqual([]);
      expect(await stateOf('a.gcode')).toBe('unsynced');
    });
  });

  describe('restart safety', () => {
    it('resends a file whose send did not complete', async () => {
      const service = await started();
      ready = false;
      await put('a.gcode');
      await service.tick(); // queued and saved
      ready = true;
      (printer.send as jest.Mock<AutoSyncPrinter['send']>).mockImplementationOnce(
        () => new Promise(() => undefined) // the process dies in the middle of the upload
      );
      void service.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await stateOf('a.gcode')).toBe('queued');

      const restarted = make();
      await restarted.tick();
      expect(printer.send).toHaveBeenCalledTimes(2);
      expect(sent).toEqual(['a.gcode']);
      expect(await stateOf('a.gcode')).toBe('synced');
    });

    it('does not take a new baseline when the state file exists', async () => {
      const service = await started();
      await put('a.gcode');
      ready = false;
      await service.tick();
      await make().tick();
      expect(await stateOf('a.gcode')).toBe('queued');
    });

    it('writes the state file without leaving temporary files', async () => {
      await started('a.gcode');
      expect((await fsp.readdir(root)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });
  });

  describe('failures', () => {
    it('retries with a growing delay and gives up after the last attempt', async () => {
      const service = await started();
      await put('a.gcode');
      sendResult = { success: false, error: 'printer said no' };
      await service.tick();
      expect(await stateOf('a.gcode')).toBe('queued');
      await service.tick(); // too early
      expect(sent).toHaveLength(1);

      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        clock += backoffMs(attempt);
        await service.tick();
      }
      expect(sent).toHaveLength(MAX_ATTEMPTS);
      const record = (await records())[0];
      expect(record.state).toBe('failed');
      expect(record.attempts).toBe(MAX_ATTEMPTS);
      expect(record.lastError).toBe('printer said no');

      clock += 24 * HOUR;
      await service.tick();
      expect(sent).toHaveLength(MAX_ATTEMPTS);
    });

    it('treats a thrown error like a rejected upload', async () => {
      const service = await started();
      await put('a.gcode');
      (printer.send as jest.Mock<AutoSyncPrinter['send']>).mockRejectedValueOnce(
        new Error('socket hang up')
      );
      await service.tick();
      const record = (await records())[0];
      expect(record.attempts).toBe(1);
      expect(record.lastError).toBe('socket hang up');
    });

    it('requeue puts a failed file back in the queue', async () => {
      const service = await started();
      await put('a.gcode');
      sendResult = { success: false, error: 'no' };
      await service.tick();
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        clock += backoffMs(attempt);
        await service.tick();
      }
      expect(await stateOf('a.gcode')).toBe('failed');
      sendResult = { success: true };
      await service.requeue('a.gcode');
      expect(await stateOf('a.gcode')).toBe('queued');
      await service.tick();
      expect(await stateOf('a.gcode')).toBe('synced');
    });

    it('requeue is refused when auto-sync is off', async () => {
      const service = await started('a.gcode');
      settings.enabled = false;
      await expect(service.requeue('a.gcode')).rejects.toThrow('switched off');
    });
  });

  describe('describe and markSynced', () => {
    it('reports queued for a file that was just uploaded, before the next tick', async () => {
      const service = await started();
      await put('a.gcode');
      const files = await library.list();
      expect((await service.describe(files)).get('a.gcode')?.syncState).toBe('queued');
    });

    it('marks a manually sent file as synced', async () => {
      const service = await started('a.gcode');
      await service.markSynced('a.gcode');
      expect(await stateOf('a.gcode')).toBe('synced');
    });
  });

  describe('cleanup', () => {
    const syncedAt = (hoursAgo: number) => new Date(clock - hoursAgo * HOUR).toISOString();
    const record = (
      name: string,
      hoursAgo: number,
      state: SyncRecord['state'] = 'synced'
    ): SyncRecord => ({
      name,
      size: 1,
      modified: 'x',
      state,
      queuedAt: syncedAt(hoursAgo),
      syncedAt: state === 'synced' ? syncedAt(hoursAgo) : undefined,
      attempts: 0,
    });

    describe('pickCleanupCandidates', () => {
      const pick = (recs: SyncRecord[], keepNewest: number, protectedNames: string[] = []) =>
        pickCleanupCandidates(recs, {
          keepNewest,
          now: clock,
          protectedNames: new Set(protectedNames),
        }).map((r) => r.name);

      it('keeps the newest N and lists the rest oldest first', () => {
        const recs = [record('d', 100), record('a', 400), record('c', 200), record('b', 300)];
        expect(pick(recs, 2)).toEqual(['a', 'b']);
      });

      it('never lists anything younger than 24 hours', () => {
        const recs = [record('new1', 1), record('new2', 2), record('new3', 23), record('old', 25)];
        expect(pick(recs, 1)).toEqual(['old']);
        expect(MIN_CLEANUP_AGE_MS).toBe(24 * HOUR);
      });

      it('skips protected names but still counts them as newest', () => {
        const recs = [record('a', 500), record('b', 400), record('c', 300)];
        expect(pick(recs, 1, ['a'])).toEqual(['b']);
      });

      it('ignores files that are not synced by this service', () => {
        const baseline = { ...record('base', 900), syncedAt: undefined };
        const recs = [
          baseline,
          record('q', 900, 'queued'),
          record('f', 900, 'failed'),
          record('a', 800),
        ];
        expect(pick(recs, 1)).toEqual([]);
      });

      it('always keeps at least one file', () => {
        expect(pick([record('a', 100), record('b', 200)], 0)).toEqual(['b']);
      });
    });

    const withSyncedFiles = async (count: number) => {
      const service = await started();
      for (let i = 0; i < count; i++) {
        await put(`f${i}.gcode`);
        await service.tick();
        clock += 2 * HOUR;
      }
      sent.length = 0;
      clock += 30 * HOUR;
      return service;
    };

    it('does nothing when cleanup is off', async () => {
      const service = await withSyncedFiles(4);
      await service.tick();
      expect(deleted).toEqual([]);
    });

    it('deletes the oldest synced file beyond the newest N, one per tick', async () => {
      settings.cleanup = { enabled: true, dryRun: false, keepNewest: 2 };
      const service = await withSyncedFiles(4);
      await service.tick();
      expect(deleted).toEqual(['f0.gcode']);
      await service.tick();
      expect(deleted).toEqual(['f0.gcode', 'f1.gcode']);
      await service.tick();
      expect(deleted).toHaveLength(2);
      // the library copies stay and can be sent again by hand
      expect(await stateOf('f0.gcode')).toBe('unsynced');
      expect(await stateOf('f3.gcode')).toBe('synced');
      expect(sent).toEqual([]);
    });

    it('dry run only logs', async () => {
      settings.cleanup = { enabled: true, dryRun: true, keepNewest: 2 };
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const service = await withSyncedFiles(4);
      await service.tick();
      await service.tick();
      const messages = log.mock.calls.map((call) => String(call[0]));
      log.mockRestore();
      expect(deleted).toEqual([]);
      expect(messages.filter((m) => m.includes('would delete f0.gcode'))).toHaveLength(1);
      expect(messages.some((m) => m.includes('would delete f1.gcode'))).toBe(true);
      expect(await stateOf('f0.gcode')).toBe('synced');
    });

    it('spares the file that is printing and the last printed one', async () => {
      settings.cleanup = { enabled: true, dryRun: false, keepNewest: 1 };
      const service = await withSyncedFiles(3);
      currentJob = 'f0.gcode';
      await service.tick();
      currentJob = undefined; // printed, now cleared on the printer
      await service.tick();
      expect(deleted).toEqual(['f1.gcode']);
    });

    it('only acts when the printer is ready', async () => {
      settings.cleanup = { enabled: true, dryRun: false, keepNewest: 1 };
      const service = await withSyncedFiles(3);
      ready = false;
      await service.tick();
      expect(deleted).toEqual([]);
    });

    it('does nothing on a printer that cannot delete files', async () => {
      settings.cleanup = { enabled: true, dryRun: false, keepNewest: 1 };
      canDelete = false;
      const service = await withSyncedFiles(3);
      await service.tick();
      expect(deleted).toEqual([]);
      expect(await stateOf('f0.gcode')).toBe('synced');
    });

    it('does not retry a failed delete on every tick', async () => {
      settings.cleanup = { enabled: true, dryRun: false, keepNewest: 1 };
      const service = await withSyncedFiles(3);
      (printer.deleteFile as jest.Mock<AutoSyncPrinter['deleteFile']>).mockResolvedValue({
        success: false,
        error: 'busy',
      });
      await service.tick();
      await service.tick();
      expect(printer.deleteFile).toHaveBeenCalledTimes(1);
      expect(await stateOf('f0.gcode')).toBe('synced');
    });

    it('forgets deleted files that also left the library', async () => {
      settings.cleanup = { enabled: true, dryRun: false, keepNewest: 1 };
      const service = await withSyncedFiles(3);
      await fsp.rm(path.join(dir, 'f0.gcode'));
      await service.tick();
      expect(deleted).toEqual(['f0.gcode']);
      expect((await records()).map((r) => r.name)).not.toContain('f0.gcode');
    });
  });
});
