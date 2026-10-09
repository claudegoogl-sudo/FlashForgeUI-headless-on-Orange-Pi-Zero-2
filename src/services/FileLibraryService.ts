/**
 * @fileoverview Server-side job file library for the WebUI file manager.
 *
 * Stores uploaded G-code/3MF files in a flat directory on the host running
 * FlashForgeWebUI, so files can be listed, renamed,
 * downloaded, deleted and sent to the printer later. The printer's own HTTP
 * API only exposes the 10 most recent files and has no delete call, so this
 * library is the place where files are actually managed.
 *
 * All names are validated as plain file names (no path parts) with a job file
 * extension; every path is resolved inside the library directory. Uploads are
 * streamed to a temporary file and renamed into place only when complete.
 */

import { randomBytes } from 'node:crypto';
import { createWriteStream, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDataPath } from '../utils/setup';

export const LIBRARY_EXTENSIONS = ['.gcode', '.gx', '.3mf'] as const;
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1 GiB
export const DEFAULT_MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024; // keep 2 GiB free on the host
const MAX_NAME_BYTES = 180;
const TEMP_PREFIX = '.upload-';

export interface LibraryFile {
  readonly name: string;
  readonly size: number;
  readonly modified: string; // ISO timestamp
}

export class FileLibraryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'FileLibraryError';
  }
}

/**
 * Validate a user-supplied file name and return it trimmed.
 * Throws FileLibraryError(400) for anything that is not a plain job file name.
 */
export function validateLibraryFileName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new FileLibraryError('File name is required', 400);
  }
  const name = raw.trim();
  if (!name || name === '.' || name === '..') {
    throw new FileLibraryError('File name is required', 400);
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[/\\\u0000-\u001f\u007f]/.test(name) || name.startsWith('.')) {
    throw new FileLibraryError('File name must be a plain name without path parts', 400);
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new FileLibraryError(`File name is longer than ${MAX_NAME_BYTES} bytes`, 400);
  }
  const ext = path.extname(name).toLowerCase();
  if (!(LIBRARY_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new FileLibraryError(`Only ${LIBRARY_EXTENSIONS.join(', ')} files are allowed`, 400);
  }
  return name;
}

export interface FileLibraryOptions {
  readonly maxFileBytes?: number;
  readonly minFreeBytes?: number;
}

export class FileLibraryService {
  private readonly maxFileBytes: number;
  private readonly minFreeBytes: number;

  constructor(
    readonly directory: string,
    options: FileLibraryOptions = {}
  ) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.minFreeBytes = options.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  }

  /** Absolute path of a validated library file (the file may not exist). */
  public resolvePath(name: string): string {
    const safeName = validateLibraryFileName(name);
    const resolved = path.resolve(this.directory, safeName);
    if (path.dirname(resolved) !== path.resolve(this.directory)) {
      throw new FileLibraryError('File name must be a plain name without path parts', 400);
    }
    return resolved;
  }

  public async list(): Promise<LibraryFile[]> {
    await this.ensureDirectory();
    const entries = await fsp.readdir(this.directory, { withFileTypes: true });
    const files: LibraryFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith('.')) {
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!(LIBRARY_EXTENSIONS as readonly string[]).includes(ext)) {
        continue;
      }
      const stats = await fsp.stat(path.join(this.directory, entry.name));
      files.push({ name: entry.name, size: stats.size, modified: stats.mtime.toISOString() });
    }
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return files;
  }

  public async stat(name: string): Promise<LibraryFile> {
    const filePath = this.resolvePath(name);
    try {
      const stats = await fsp.stat(filePath);
      if (!stats.isFile()) {
        throw new FileLibraryError('File not found', 404);
      }
      return {
        name: path.basename(filePath),
        size: stats.size,
        modified: stats.mtime.toISOString(),
      };
    } catch (error) {
      if (error instanceof FileLibraryError) throw error;
      throw new FileLibraryError('File not found', 404);
    }
  }

  public async exists(name: string): Promise<boolean> {
    try {
      await this.stat(name);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stream an upload into the library.
   * @param declaredSize Content-Length if the client sent one (checked up front).
   */
  public async save(
    name: string,
    source: Readable,
    options: { overwrite?: boolean; declaredSize?: number } = {}
  ): Promise<LibraryFile> {
    const target = this.resolvePath(name);
    await this.ensureDirectory();

    if (!options.overwrite && (await this.exists(name))) {
      throw new FileLibraryError('A file with this name already exists', 409);
    }
    if (options.declaredSize !== undefined) {
      if (options.declaredSize > this.maxFileBytes) {
        throw new FileLibraryError(`File is larger than ${formatBytes(this.maxFileBytes)}`, 413);
      }
      await this.assertFreeSpace(options.declaredSize);
    }

    const tempPath = path.join(
      this.directory,
      `${TEMP_PREFIX}${randomBytes(6).toString('hex')}.part`
    );
    let received = 0;
    const maxBytes = this.maxFileBytes;
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        source.destroy(new FileLibraryError(`File is larger than ${formatBytes(maxBytes)}`, 413));
      }
    });

    try {
      await pipeline(source, createWriteStream(tempPath, { flags: 'wx' }));
      if (received === 0) {
        throw new FileLibraryError('Uploaded file is empty', 400);
      }
      if (!options.overwrite && (await this.exists(name))) {
        throw new FileLibraryError('A file with this name already exists', 409);
      }
      await fsp.rename(tempPath, target);
    } catch (error) {
      await fsp.rm(tempPath, { force: true });
      if (error instanceof FileLibraryError) throw error;
      throw new FileLibraryError(`Upload failed: ${(error as Error).message}`, 500);
    }

    return this.stat(name);
  }

  public async remove(name: string): Promise<void> {
    await this.stat(name);
    await fsp.rm(this.resolvePath(name));
  }

  public async rename(from: string, to: string, overwrite = false): Promise<LibraryFile> {
    const source = this.resolvePath(from);
    const target = this.resolvePath(to);
    await this.stat(from);
    if (source === target) {
      return this.stat(to);
    }
    // Case-only renames on case-insensitive filesystems report the target as existing.
    const caseOnly = source.toLowerCase() === target.toLowerCase();
    if (!overwrite && !caseOnly && (await this.exists(to))) {
      throw new FileLibraryError('A file with the new name already exists', 409);
    }
    await fsp.rename(source, target);
    return this.stat(to);
  }

  /** Remove leftovers of interrupted uploads. */
  public async cleanupTempFiles(): Promise<void> {
    try {
      const entries = await fsp.readdir(this.directory);
      await Promise.all(
        entries
          .filter((entry) => entry.startsWith(TEMP_PREFIX))
          .map((entry) => fsp.rm(path.join(this.directory, entry), { force: true }))
      );
    } catch {
      // directory does not exist yet
    }
  }

  private async ensureDirectory(): Promise<void> {
    await fsp.mkdir(this.directory, { recursive: true });
  }

  private async assertFreeSpace(incomingBytes: number): Promise<void> {
    try {
      const stats = await fsp.statfs(this.directory);
      const free = stats.bavail * stats.bsize;
      if (free - incomingBytes < this.minFreeBytes) {
        throw new FileLibraryError('Not enough free disk space on the host', 507);
      }
    } catch (error) {
      if (error instanceof FileLibraryError) throw error;
      // statfs unsupported: skip the check
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

let instance: FileLibraryService | null = null;

/** Library in <data dir>/library, or FFUI_LIBRARY_DIR if set. */
export function getFileLibraryService(): FileLibraryService {
  if (!instance) {
    const override = process.env.FFUI_LIBRARY_DIR?.trim();
    const directory = override ? path.resolve(override) : path.join(getDataPath(), 'library');
    instance = new FileLibraryService(directory);
    void instance.cleanupTempFiles();
  }
  return instance;
}
