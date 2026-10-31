/**
 * @fileoverview WebUI job library routes: host-side job library plus "send to printer".
 *
 * Library files live on the machine running FlashForgeUI (see FileLibraryService).
 * - GET    /files/library                 list files, each with syncState (queued | synced | failed
 *                                         | unsynced), syncedAt and lastError from the auto-sync queue
 * - PUT    /files/library/:name           upload (raw request body, ?overwrite=1 to replace)
 * - GET    /files/library/:name/download  download
 * - GET    /files/library/:name/meta      slicer metadata + thumbnail (cached per mtime)
 * - POST   /files/library/:name/rename    { newName, overwrite? }
 * - DELETE /files/library/:name           delete
 * - POST   /files/library/:name/send      upload to the printer ({ startNow?, leveling? });
 *                                         refused while the printer is busy
 * - POST   /files/library/:name/requeue  queue the file for auto-sync again (failed / not synced)
 * - POST   /files/library/:name/stage     stage for the Upload Job dialog (same response as
 *                                         POST /jobs/upload/stage), so a library file can be
 *                                         started with material matching
 */

import { parseSlicerFile } from '@parallel-7/slicer-meta';
import type { Response, Router } from 'express';
import { type AutoSyncService, getAutoSyncService } from '../../../services/AutoSyncService';
import {
  FileLibraryError,
  type FileLibraryService,
  getFileLibraryService,
} from '../../../services/FileLibraryService';
import { toAppError } from '../../../utils/error.utils';
import type { JobUploadStageResponse } from '../../types/web-api.types';
import type { AuthenticatedRequest } from '../auth-middleware';
import { discardStagedUpload, stageExistingFile } from '../upload-staging';
import { normalizeMetadata } from './job-upload-routes';
import { type RouteDependencies, resolveContext, sendErrorResponse } from './route-helpers';

/**
 * Printer states (case-insensitive; backends report raw firmware values such as
 * "printing" or polling values such as "Printing") in which a file may be sent.
 * Allowlist on purpose: any other or unknown state is refused.
 */
export const PRINTER_IDLE_STATES = new Set(['ready', 'idle', 'completed', 'cancel', 'cancelled']);

export function isPrinterIdle(printerState: string | undefined): boolean {
  return printerState !== undefined && PRINTER_IDLE_STATES.has(printerState.trim().toLowerCase());
}

export interface LibraryFileMeta {
  readonly thumbnail: string | null; // data URL
  readonly printEta: string | null;
  readonly filamentWeightGrams: number | null;
  readonly filamentLengthMm: number | null;
  readonly filamentType: string | null;
  readonly slicer: string | null;
  readonly printerModel: string | null;
  readonly toolCount: number | null;
}

const metaCache = new Map<string, { modified: string; meta: LibraryFileMeta }>();

function toDataUrl(image: string | null | undefined): string | null {
  if (!image) return null;
  const trimmed = image.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

async function readMeta(filePath: string): Promise<LibraryFileMeta> {
  const parsed = await parseSlicerFile(filePath);
  const file = parsed.file ?? null;
  const slicer = parsed.slicer ?? null;
  const threeMf = parsed.threeMf ?? null;
  const filaments = threeMf?.filaments ?? file?.filaments ?? [];
  return {
    thumbnail: toDataUrl(threeMf?.plateImage ?? file?.thumbnail ?? null),
    printEta: slicer?.printEta || null,
    filamentWeightGrams: positiveOrNull(file?.filamentUsedG),
    filamentLengthMm: positiveOrNull(file?.filamentUsedMM),
    filamentType:
      file?.filamentType && file.filamentType.toLowerCase() !== 'unknown'
        ? file.filamentType
        : null,
    slicer: slicer?.slicerName ? `${slicer.slicerName} ${slicer.slicerVersion ?? ''}`.trim() : null,
    printerModel: threeMf?.printerModelId || file?.printerModel || null,
    toolCount: filaments.length > 0 ? filaments.length : null,
  };
}

function handleError(res: Response, error: unknown): Response {
  if (error instanceof FileLibraryError) {
    return sendErrorResponse(res, error.statusCode, error.message);
  }
  return sendErrorResponse(res, 500, toAppError(error).message);
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 1;
}

export function registerFileLibraryRoutes(
  router: Router,
  deps: RouteDependencies,
  library: FileLibraryService = getFileLibraryService(),
  autoSync: AutoSyncService = getAutoSyncService()
): void {
  router.get('/files/library', async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const listed = await library.list();
      const sync = await autoSync.describe(listed);
      const files = listed.map((file) => ({ ...file, ...sync.get(file.name) }));
      return res.json({ success: true, files });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.put('/files/library/:name', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const lengthHeader = req.headers['content-length'];
      const declaredSize =
        lengthHeader !== undefined ? Number.parseInt(lengthHeader, 10) : undefined;
      const file = await library.save(req.params.name as string, req, {
        overwrite: parseBoolean(req.query.overwrite),
        declaredSize: Number.isFinite(declaredSize) ? declaredSize : undefined,
      });
      metaCache.delete(file.name);
      return res.status(201).json({ success: true, file });
    } catch (error) {
      // Drain the rest of the body so the client sees the error instead of a reset.
      req.resume();
      return handleError(res, error);
    }
  });

  router.get('/files/library/:name/download', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const file = await library.stat(req.params.name as string);
      return res.download(library.resolvePath(file.name), file.name, { dotfiles: 'deny' });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.get('/files/library/:name/meta', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const file = await library.stat(req.params.name as string);
      const cached = metaCache.get(file.name);
      if (cached && cached.modified === file.modified) {
        return res.json({ success: true, meta: cached.meta });
      }
      let meta: LibraryFileMeta;
      try {
        meta = await readMeta(library.resolvePath(file.name));
      } catch (error) {
        console.warn(
          `[FileRoutes] Metadata parse failed for ${file.name}:`,
          (error as Error).message
        );
        meta = {
          thumbnail: null,
          printEta: null,
          filamentWeightGrams: null,
          filamentLengthMm: null,
          filamentType: null,
          slicer: null,
          printerModel: null,
          toolCount: null,
        };
      }
      metaCache.set(file.name, { modified: file.modified, meta });
      return res.json({ success: true, meta });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/files/library/:name/rename', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const body = (req.body ?? {}) as { newName?: unknown; overwrite?: unknown };
      const oldName = req.params.name as string;
      const file = await library.rename(
        oldName,
        body.newName as string,
        parseBoolean(body.overwrite)
      );
      metaCache.delete(oldName);
      metaCache.delete(file.name);
      return res.json({ success: true, file });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.delete('/files/library/:name', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const name = req.params.name as string;
      await library.remove(name);
      metaCache.delete(name);
      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/files/library/:name/requeue', async (req: AuthenticatedRequest, res: Response) => {
    try {
      await autoSync.requeue(req.params.name as string);
      return res.json({ success: true });
    } catch (error) {
      return handleError(res, error);
    }
  });

  router.post('/files/library/:name/stage', async (req: AuthenticatedRequest, res: Response) => {
    let uploadId: string | null = null;
    try {
      const file = await library.stat(req.params.name as string);

      const contextResult = resolveContext(req, deps, { requireBackendReady: true });
      if (!contextResult.success) {
        return sendErrorResponse<JobUploadStageResponse>(
          res,
          contextResult.statusCode,
          contextResult.error
        );
      }

      // Same rule as POST /jobs/upload/stage: material-station printers start 3MF files only.
      const hasMaterialStation = deps.backendManager.isFeatureAvailable(
        contextResult.contextId,
        'material-station'
      );
      const is3MF = file.name.toLowerCase().endsWith('.3mf');
      if (hasMaterialStation && !is3MF) {
        return sendErrorResponse<JobUploadStageResponse>(
          res,
          400,
          'This printer starts 3MF files from here. Use "Send to printer" for other files.'
        );
      }

      const staged = await stageExistingFile(file.name, library.resolvePath(file.name));
      uploadId = staged.id;
      const parsed = await parseSlicerFile(staged.filePath);

      return res.json({
        success: true,
        uploadId: staged.id,
        fileName: staged.fileName,
        metadata: normalizeMetadata(parsed),
        requiresMaterialMatching: hasMaterialStation && is3MF,
      } satisfies JobUploadStageResponse);
    } catch (error) {
      if (uploadId) {
        await discardStagedUpload(uploadId);
      }
      return handleError(res, error);
    }
  });

  router.post('/files/library/:name/send', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const file = await library.stat(req.params.name as string);
      const body = (req.body ?? {}) as { startNow?: unknown; leveling?: unknown };
      const startNow = parseBoolean(body.startNow);
      const leveling = parseBoolean(body.leveling);

      const contextResult = resolveContext(req, deps, { requireBackendReady: true });
      if (!contextResult.success) {
        return sendErrorResponse(res, contextResult.statusCode, contextResult.error);
      }
      const { contextId } = contextResult;

      const statusResult = await deps.backendManager.getPrinterStatus(contextId);
      const printerState = statusResult.success ? statusResult.status?.printerState : undefined;
      if (!printerState) {
        return sendErrorResponse(res, 503, 'Printer state unknown; not sending');
      }
      if (!isPrinterIdle(printerState)) {
        return sendErrorResponse(
          res,
          409,
          `Printer is busy (${printerState}); send the file when it is idle`
        );
      }

      const result = await deps.backendManager.startJob(contextId, {
        operation: 'start',
        fileName: file.name,
        filePath: library.resolvePath(file.name),
        startNow,
        leveling,
      });

      if (!result.success) {
        return sendErrorResponse(res, 502, result.error || 'Printer rejected the upload');
      }
      await autoSync.markSynced(file.name).catch(() => undefined);
      return res.json({
        success: true,
        message: startNow ? `Sent and started: ${file.name}` : `Sent to printer: ${file.name}`,
        started: startNow,
      });
    } catch (error) {
      return handleError(res, error);
    }
  });
}
