/**
 * @fileoverview WebUI job library: files stored on the FlashForgeWebUI host.
 *
 * Lets the user upload G-code/3MF files from any device (with progress), see
 * thumbnails and slicer metadata, rename, download and delete them, and use them:
 * "Print..." stages the stored file for the Upload Job dialog (metadata, material
 * matching, start), "Send to printer" uploads it without starting.
 * Server side: src/webui/server/routes/file-library-routes.ts.
 */

import type { JobUploadStageResponse } from '../app.js';
import { state } from '../core/AppState.js';
import { apiRequest, apiRequestWithMetadata, buildAuthHeaders } from '../core/Transport.js';
import { $, hideElement, showElement, showToast } from '../shared/dom.js';
import { loadFileList } from '../ui/dialogs.js';
import { previewGcodeFile } from './gcode-viewer.js';
import { openJobUploadWithStaged } from './job-upload.js';

interface LibraryFile {
  name: string;
  size: number;
  modified: string;
}

interface LibraryFileMeta {
  thumbnail: string | null;
  printEta: string | null;
  filamentWeightGrams: number | null;
  filamentLengthMm: number | null;
  filamentType: string | null;
  slicer: string | null;
  printerModel: string | null;
  toolCount: number | null;
}

interface ApiResult {
  success: boolean;
  error?: string;
  message?: string;
}

const ACCEPTED_EXTENSIONS = ['.gcode', '.gx', '.3mf'];
const metaCache = new Map<string, LibraryFileMeta>();
let uploading = false;

function libraryUrl(name: string, suffix = ''): string {
  return `/api/files/library/${encodeURIComponent(name)}${suffix}`;
}

function isAuthenticated(): boolean {
  if (state.authRequired && !state.authToken) {
    showToast('Not authenticated', 'error');
    return false;
  }
  return true;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatModified(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

export function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function openFileLibrary(): Promise<void> {
  if (!isAuthenticated()) return;
  showElement('file-library-modal');
  await refreshLibrary();
}

function closeFileLibrary(): void {
  hideElement('file-library-modal');
}

async function refreshLibrary(): Promise<void> {
  const list = $('lib-list');
  if (!list) return;

  try {
    const result = await apiRequest<ApiResult & { files?: LibraryFile[] }>('/api/files/library');
    if (!result.success || !result.files) {
      showToast(result.error || 'Failed to load files', 'error');
      return;
    }
    renderLibrary(list, result.files);
  } catch (error) {
    console.error('Failed to load library:', error);
    showToast('Failed to load files', 'error');
  }
}

function makeButton(
  label: string,
  action: string,
  name: string,
  extraClass = ''
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `lib-action ${extraClass}`.trim();
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.name = name;
  return button;
}

function renderLibrary(list: HTMLElement, files: LibraryFile[]): void {
  list.innerHTML = '';
  const summary = $('lib-summary');
  if (summary) {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    summary.textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'}, ${formatFileSize(total)}`
      : '';
  }

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'lib-empty';
    empty.textContent = 'No files yet. Add .gcode, .gx or .3mf files to keep them here.';
    list.appendChild(empty);
    return;
  }

  for (const file of files) {
    const item = document.createElement('div');
    item.className = 'lib-item';
    item.dataset.name = file.name;

    const thumb = document.createElement('div');
    thumb.className = 'lib-thumb';
    item.appendChild(thumb);

    const body = document.createElement('div');
    body.className = 'lib-body';

    const name = document.createElement('div');
    name.className = 'lib-name';
    name.textContent = file.name;
    name.title = file.name;
    body.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'lib-meta';
    meta.textContent = `${formatFileSize(file.size)} · ${formatModified(file.modified)}`;
    body.appendChild(meta);

    const details = document.createElement('div');
    details.className = 'lib-meta lib-details';
    body.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'lib-actions';
    actions.appendChild(makeButton('Print...', 'print', file.name, 'lib-primary'));
    actions.appendChild(makeButton('Send to printer', 'send', file.name));
    actions.appendChild(makeButton('View', 'view', file.name));
    actions.appendChild(makeButton('Download', 'download', file.name));
    actions.appendChild(makeButton('Rename', 'rename', file.name));
    actions.appendChild(makeButton('Delete', 'delete', file.name, 'lib-danger'));
    body.appendChild(actions);

    item.appendChild(body);
    list.appendChild(item);

    void loadMeta(file, thumb, details);
  }
}

async function loadMeta(
  file: LibraryFile,
  thumb: HTMLElement,
  details: HTMLElement
): Promise<void> {
  const cacheKey = `${file.name}|${file.modified}`;
  let meta = metaCache.get(cacheKey);
  if (!meta) {
    try {
      const result = await apiRequest<ApiResult & { meta?: LibraryFileMeta }>(
        libraryUrl(file.name, '/meta')
      );
      if (!result.success || !result.meta) return;
      meta = result.meta;
      metaCache.set(cacheKey, meta);
    } catch {
      return;
    }
  }

  if (meta.thumbnail) {
    const img = document.createElement('img');
    img.src = meta.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    thumb.appendChild(img);
  }

  const parts: string[] = [];
  if (meta.printEta) parts.push(meta.printEta);
  if (meta.filamentWeightGrams) parts.push(`${meta.filamentWeightGrams.toFixed(1)} g`);
  if (meta.filamentType) parts.push(meta.filamentType);
  if (meta.toolCount && meta.toolCount > 1) parts.push(`${meta.toolCount} tools`);
  if (meta.slicer) parts.push(meta.slicer);
  details.textContent = parts.join(' · ');
}

function setProgress(text: string | null, fraction?: number): void {
  const wrap = $('lib-progress');
  const bar = $('lib-progress-bar');
  const label = $('lib-progress-label');
  if (!wrap || !bar || !label) return;
  if (text === null) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  label.textContent = text;
  bar.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

function uploadOne(
  file: File,
  overwrite: boolean,
  onProgress: (fraction: number) => void
): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${libraryUrl(file.name)}${overwrite ? '?overwrite=1' : ''}`);
    const headers = buildAuthHeaders({ 'Content-Type': 'application/octet-stream' });
    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.status);
        return;
      }
      let message = `Upload failed (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText) as ApiResult;
        if (body.error) message = body.error;
      } catch {
        // keep generic message
      }
      reject(Object.assign(new Error(message), { status: xhr.status }));
    };
    xhr.onerror = () =>
      reject(Object.assign(new Error('Network error during upload'), { status: 0 }));
    xhr.send(file);
  });
}

async function uploadFiles(files: FileList | File[]): Promise<void> {
  if (!isAuthenticated() || uploading) return;
  const queue = Array.from(files);
  const rejected = queue.filter((file) => !hasAcceptedExtension(file.name));
  if (rejected.length > 0) {
    showToast(`Skipped (not .gcode/.gx/.3mf): ${rejected.map((f) => f.name).join(', ')}`, 'error');
  }
  const accepted = queue.filter((file) => hasAcceptedExtension(file.name));
  if (accepted.length === 0) return;

  uploading = true;
  let done = 0;
  try {
    for (const [index, file] of accepted.entries()) {
      const prefix = accepted.length > 1 ? `(${index + 1}/${accepted.length}) ` : '';
      const progress = (fraction: number) =>
        setProgress(`${prefix}Uploading ${file.name}: ${Math.round(fraction * 100)}%`, fraction);
      progress(0);
      try {
        await uploadOne(file, false, progress);
        done++;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 409 && window.confirm(`${file.name} already exists. Replace it?`)) {
          try {
            await uploadOne(file, true, progress);
            done++;
          } catch (retryError) {
            showToast((retryError as Error).message, 'error');
          }
        } else if (status !== 409) {
          showToast(`${file.name}: ${(error as Error).message}`, 'error');
        }
      }
    }
  } finally {
    uploading = false;
    setProgress(null);
  }

  if (done > 0) {
    showToast(`Uploaded ${done} file${done === 1 ? '' : 's'}`, 'success');
  }
  await refreshLibrary();
}

async function downloadFile(name: string): Promise<void> {
  try {
    setProgress(`Downloading ${name}...`, 0);
    const response = await fetch(libraryUrl(name, '/download'), { headers: buildAuthHeaders() });
    if (!response.ok) {
      showToast(`Download failed (${response.status})`, 'error');
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    console.error('Download failed:', error);
    showToast('Download failed', 'error');
  } finally {
    setProgress(null);
  }
}

async function postJson(
  url: string,
  body: unknown,
  method = 'POST'
): Promise<{ status: number; data: ApiResult }> {
  const result = await apiRequestWithMetadata<ApiResult>(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: result.status, data: result.data };
}

async function renameFile(name: string): Promise<void> {
  const input = window.prompt('New file name', name);
  if (input === null) return;
  const newName = input.trim();
  if (!newName || newName === name) return;
  if (!hasAcceptedExtension(newName)) {
    showToast('The name must end in .gcode, .gx or .3mf', 'error');
    return;
  }

  let { status, data } = await postJson(libraryUrl(name, '/rename'), { newName });
  if (status === 409 && window.confirm(`${newName} already exists. Replace it?`)) {
    ({ data } = await postJson(libraryUrl(name, '/rename'), { newName, overwrite: true }));
  }
  if (data.success) {
    showToast(`Renamed to ${newName}`, 'success');
    await refreshLibrary();
  } else if (status !== 409) {
    showToast(data.error || 'Rename failed', 'error');
  }
}

async function deleteFile(name: string): Promise<void> {
  if (!window.confirm(`Delete ${name} from the library? This cannot be undone.`)) return;
  const { data } = await postJson(libraryUrl(name), undefined, 'DELETE');
  if (data.success) {
    showToast(`Deleted ${name}`, 'success');
    await refreshLibrary();
  } else {
    showToast(data.error || 'Delete failed', 'error');
  }
}

/** Stage the stored file on the server and continue in the Upload Job dialog. */
async function printFromLibrary(name: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  setProgress(`Preparing ${name}...`, 0);
  try {
    const result = await apiRequestWithMetadata<JobUploadStageResponse>(
      libraryUrl(name, '/stage'),
      { method: 'POST' }
    );
    const staged = result.data;
    if (!staged.success || !staged.uploadId) {
      showToast(staged.error || 'Could not prepare the file', 'error');
      return;
    }
    closeFileLibrary();
    await openJobUploadWithStaged(staged, name);
  } catch (error) {
    console.error('Print from library failed:', error);
    showToast('Could not prepare the file', 'error');
  } finally {
    button.disabled = false;
    setProgress(null);
  }
}

async function sendToPrinter(name: string, button: HTMLButtonElement): Promise<void> {
  if (
    !window.confirm(
      `Send ${name} to the printer?\nIt is uploaded only; start it from the printer's file list.`
    )
  ) {
    return;
  }
  button.disabled = true;
  setProgress(`Sending ${name} to the printer...`, 0);
  try {
    const { data } = await postJson(libraryUrl(name, '/send'), {
      startNow: false,
      leveling: false,
    });
    if (data.success) {
      showToast(data.message || 'Sent to printer', 'success');
      if (window.confirm('Sent. Open the printer file list to start it?')) {
        closeFileLibrary();
        await loadFileList('recent');
      }
    } else {
      showToast(data.error || 'Send failed', 'error');
    }
  } catch (error) {
    console.error('Send failed:', error);
    showToast('Send failed', 'error');
  } finally {
    button.disabled = false;
    setProgress(null);
  }
}

export function setupFileLibraryHandlers(): void {
  $('lib-close')?.addEventListener('click', closeFileLibrary);
  $('lib-refresh')?.addEventListener('click', () => void refreshLibrary());
  $('lib-printer-files')?.addEventListener('click', async () => {
    closeFileLibrary();
    await loadFileList('recent');
  });

  const input = $('lib-upload-input') as HTMLInputElement | null;
  input?.addEventListener('change', () => {
    if (input.files && input.files.length > 0) {
      const files = Array.from(input.files);
      input.value = '';
      void uploadFiles(files);
    }
  });

  const modal = $('file-library-modal');
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeFileLibrary();
  });
  modal?.addEventListener('dragover', (event) => {
    event.preventDefault();
  });
  modal?.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) void uploadFiles(event.dataTransfer.files);
  });

  $('lib-list')?.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement | null)?.closest(
      'button.lib-action'
    ) as HTMLButtonElement | null;
    if (!button || button.disabled) return;
    const name = button.dataset.name;
    if (!name) return;
    switch (button.dataset.action) {
      case 'print':
        void printFromLibrary(name, button);
        break;
      case 'view':
        if (previewGcodeFile(name)) {
          closeFileLibrary();
        } else {
          showToast('Enable the G-code View panel in the settings to preview files', 'error');
        }
        break;
      case 'send':
        void sendToPrinter(name, button);
        break;
      case 'download':
        void downloadFile(name);
        break;
      case 'rename':
        void renameFile(name);
        break;
      case 'delete':
        void deleteFile(name);
        break;
    }
  });
}
