/**
 * @fileoverview Centralized WebUI application state and shared singletons.
 *
 * Hosts the mutable AppState container along with context tracking helpers. Provides accessor
 * utilities so other modules can read and mutate shared state without reaching
 * into module-level variables directly.
 */

import type {
  ActiveSpoolData,
  MaterialMapping,
  MaterialStationStatus,
  PendingJobStart,
  PrinterContext,
  PrinterFeatures,
  PrinterStatus,
  SpoolmanConfigResponse,
  SpoolAssignment,
  SpoolSummary,
  WebUIJobFile,
} from '../app.js';

export class AppState {
  public isAuthenticated: boolean = false;
  public authToken: string | null = null;
  public websocket: WebSocket | null = null;
  public isConnected: boolean = false;
  public printerStatus: PrinterStatus | null = null;
  public printerFeatures: PrinterFeatures | null = null;
  public selectedFile: string | null = null;
  public jobMetadata: Map<string, WebUIJobFile> = new Map();
  public pendingJobStart: PendingJobStart | null = null;
  public reconnectAttempts: number = 0;
  public maxReconnectAttempts: number = 5;
  public reconnectDelay: number = 2000;
  public authRequired: boolean = true;
  public defaultPassword: boolean = false;
  public hasPassword: boolean = true;
  public spoolmanConfig: SpoolmanConfigResponse | null = null;
  public activeSpool: ActiveSpoolData | null = null;
  public availableSpools: SpoolSummary[] = [];
}

export const state = new AppState();

export const DEMO_SERIAL = 'demo-layout';

let currentPrinterSerial: string | null = null;
let currentContextId: string | null = null;
export const contextById = new Map<string, PrinterContext>();

/**
 * Optional overrides that let a caller other than the file dialog drive the
 * material matching modal. The job uploader uses them to collect mappings for a
 * file that is not on the printer yet, instead of starting a resident job.
 */
export interface MaterialMatchingHooks {
  /** Runs in place of the default job-start request. Return true to close the modal. */
  onConfirm?: (
    mappings: MaterialMapping[],
    spoolAssignments: SpoolAssignment[]
  ) => Promise<boolean>;
  /** Runs when the modal is dismissed without confirming. */
  onCancel?: () => void;
}

export interface MaterialMatchingState {
  pending: PendingJobStart;
  materialStation: MaterialStationStatus | null;
  selectedToolId: number | null;
  mappings: Map<number, MaterialMapping>;
  /**
   * Spoolman spool per tool when per-job tracking applies: a spool id, null
   * for "do not track", or no entry while the user has not chosen yet.
   */
  spoolChoices: Map<number, number | null>;
  /** Spools offered in the dialog; null when tracking does not apply. */
  spools: SpoolSummary[] | null;
  hooks?: MaterialMatchingHooks;
  /** Set once onConfirm succeeds so teardown does not also fire onCancel. */
  confirmed?: boolean;
}

let materialMatchingState: MaterialMatchingState | null = null;

export function getCurrentPrinterSerial(): string | null {
  return currentPrinterSerial;
}

export function setCurrentPrinterSerial(serial: string | null): void {
  currentPrinterSerial = serial;
}

export function getCurrentContextId(): string | null {
  return currentContextId;
}

export function setCurrentContextId(contextId: string | null): void {
  currentContextId = contextId;
}

export function getMaterialMatchingState(): MaterialMatchingState | null {
  return materialMatchingState;
}

export function setMaterialMatchingState(matchingState: MaterialMatchingState | null): void {
  materialMatchingState = matchingState;
}
