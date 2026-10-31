/**
 * @fileoverview Panel mounting, panel availability, the settings dialog and the colour theme.
 *
 * Panels are mounted into the views once (see ui/views.ts). Which panels apply to the
 * connected printer is decided here from its features. The theme section applies the five
 * `--theme-*` colours the server stores; saved values that equal the old default blue
 * palette are shown in the current default palette.
 */

import type { ApiResponse, PrinterFeatures, PrinterStatus } from '../app.js';
import { getCurrentContextId as getStoredContextId, state } from '../core/AppState.js';
import { apiRequest, apiRequestWithMetadata } from '../core/Transport.js';
import { $, showToast } from '../shared/dom.js';
import { componentRegistry } from '../ui/panel-registry.js';
import { mountPanels } from '../ui/views.js';

export interface LayoutUiHooks {
  onConnectionStatusUpdate?: (connected: boolean) => void;
  onPrinterStatusUpdate?: (status: PrinterStatus | null) => void;
  onSpoolmanPanelUpdate?: () => void;
  onAfterLayoutRefresh?: () => void;
}

let layoutUiHooks: LayoutUiHooks = {};

export function initializeLayout(hooks: LayoutUiHooks = {}): void {
  layoutUiHooks = { ...hooks };
}

export function setupLayoutEventHandlers(): void {
  const modal = $('settings-modal');

  $('settings-button')?.addEventListener('click', () => openSettingsModal());
  $('close-settings')?.addEventListener('click', () => closeSettingsModal());
  $('save-settings-btn')?.addEventListener('click', () => closeSettingsModal());
  $('apply-webui-theme-btn')?.addEventListener('click', () => {
    void handleApplyWebUITheme();
  });
  $('reset-webui-theme-btn')?.addEventListener('click', () => {
    loadDefaultThemeIntoSettings();
  });

  modal?.addEventListener('click', (event) => {
    if (event.target === modal) {
      closeSettingsModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSettingsModal();
    }
  });
}

export function rehydrateLayoutState(): void {
  layoutUiHooks.onConnectionStatusUpdate?.(state.isConnected);

  if (layoutUiHooks.onPrinterStatusUpdate) {
    layoutUiHooks.onPrinterStatusUpdate(state.printerStatus ?? null);
  }

  layoutUiHooks.onSpoolmanPanelUpdate?.();
}

/** Mount the panels (first call only) and show the ones that apply to this printer. */
export function loadLayoutForCurrentPrinter(): void {
  mountPanels();
  applyPanelVisibility();
  rehydrateLayoutState();
  layoutUiHooks.onAfterLayoutRefresh?.();
}

/** Hide the panels the connected printer has no feature for (for example the single-nozzle card on a Creator 5). */
export function applyPanelVisibility(): void {
  for (const componentId of componentRegistry.getAllIds()) {
    const supported = isComponentSupported(componentId, state.printerFeatures ?? null);
    componentRegistry.createElement(componentId).classList.toggle('hidden', !supported);
  }
}

export function openSettingsModal(): void {
  const modal = $('settings-modal');
  if (!modal) return;
  void loadCurrentThemeIntoSettings();
  modal.classList.remove('hidden');
}

export function closeSettingsModal(): void {
  const modal = $('settings-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}

export function isSpoolmanAvailableForCurrentContext(): boolean {
  if (!state.spoolmanConfig?.enabled) {
    return false;
  }

  if (!state.spoolmanConfig.contextId) {
    return true;
  }

  return state.spoolmanConfig.contextId === getStoredContextId();
}

export function isComponentSupported(
  componentId: string,
  features: PrinterFeatures | null
): boolean {
  if (!features) {
    return true;
  }

  if (componentId === 'filtration-tvoc') {
    // Shown for filtration-capable printers, and for the Creator 5 Pro which exposes
    // a read-only TVOC air-quality reading (its filtration controls are hidden).
    return Boolean(features.hasFiltration) || Boolean(features.isCreator5Pro);
  }

  // The single-nozzle temperature card and the multi-tool (Creator 5) card are
  // mutually exclusive — pick one based on the printer's tool configuration.
  if (componentId === 'temp-control') {
    return !features.hasMultiTool;
  }

  if (componentId === 'creator5-temperature') {
    return Boolean(features.hasMultiTool);
  }

  if (componentId === 'spoolman-tracker') {
    return isSpoolmanAvailableForCurrentContext();
  }

  if (componentId === 'ifs-station') {
    return Boolean(features.hasMaterialStation);
  }

  return true;
}

export async function loadWebUITheme(): Promise<void> {
  try {
    const response = await apiRequestWithMetadata<unknown>('/api/webui/theme');

    if (response.ok && isThemeColors(response.data)) {
      applyWebUITheme(response.data);
      return;
    }

    console.warn(
      'WebUI theme endpoint returned unexpected payload. Falling back to default.',
      response.status
    );
  } catch (error) {
    console.error('Error loading WebUI theme:', error);
  }

  applyDefaultTheme();
}

interface ThemeColors {
  primary: string;
  secondary: string;
  background: string;
  surface: string;
  text: string;
}

export function applyWebUITheme(requested: ThemeColors): void {
  const root = document.documentElement;
  const theme = migrateLegacyColors(requested);

  root.style.setProperty('--theme-primary', theme.primary);
  root.style.setProperty('--theme-secondary', theme.secondary);
  root.style.setProperty('--theme-background', theme.background);
  root.style.setProperty('--theme-surface', theme.surface);
  root.style.setProperty('--theme-text', theme.text);

  const primaryHover = lightenColor(theme.primary, 15);
  const secondaryHover = lightenColor(theme.secondary, 15);
  root.style.setProperty('--theme-primary-hover', primaryHover);
  root.style.setProperty('--theme-secondary-hover', secondaryHover);
}

export function lightenColor(hex: string, percent: number): string {
  const num = parseInt(hex.replace('#', ''), 16);

  if (Number.isNaN(num)) {
    return hex;
  }

  const r = Math.min(255, Math.floor((num >> 16) + (255 - (num >> 16)) * (percent / 100)));
  const g = Math.min(
    255,
    Math.floor(((num >> 8) & 0x00ff) + (255 - ((num >> 8) & 0x00ff)) * (percent / 100))
  );
  const b = Math.min(
    255,
    Math.floor((num & 0x0000ff) + (255 - (num & 0x0000ff)) * (percent / 100))
  );
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export async function loadCurrentThemeIntoSettings(): Promise<void> {
  try {
    const theme = await apiRequest<ThemeColors>('/api/webui/theme');
    setThemeInputValues(migrateLegacyColors(theme));
  } catch (error) {
    console.error('Error loading theme into settings:', error);
    setThemeInputValues(DEFAULT_THEME_COLORS);
  }
}

export function loadDefaultThemeIntoSettings(): void {
  setThemeInputValues(DEFAULT_THEME_COLORS);
  showToast('Theme reset to defaults. Click Apply to save.', 'info');
}

export async function handleApplyWebUITheme(): Promise<void> {
  try {
    const theme = getThemeFromInputs();

    await apiRequest<ApiResponse>('/api/webui/theme', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(theme),
    });

    applyWebUITheme(theme);
    showToast('Theme applied successfully', 'success');
  } catch (error) {
    console.error('Error applying theme:', error);
    showToast('Error applying theme', 'error');
  }
}

/** Palette of the redesign (see DESIGN.md): ink on film, dimension cyan for measured values. */
const DEFAULT_THEME_COLORS: ThemeColors = {
  primary: '#e9e6dc',
  secondary: '#5ed0e8',
  background: '#12171b',
  surface: '#1b2229',
  text: '#e9e6dc',
};

/**
 * Colours that earlier versions wrote as defaults (the blue palette and the colour pair of
 * data/config.example.json). A saved value equal to one of these was never chosen by the user,
 * so it is shown in the redesign palette instead.
 */
const LEGACY_DEFAULTS: Record<keyof ThemeColors, readonly string[]> = {
  primary: ['#4285f4', '#2260c3'],
  secondary: ['#357abd'],
  background: ['#121212'],
  surface: ['#1e1e1e'],
  text: ['#e0e0e0'],
};

function migrateLegacyColors(theme: ThemeColors): ThemeColors {
  const result = { ...theme };
  for (const key of Object.keys(LEGACY_DEFAULTS) as Array<keyof ThemeColors>) {
    if (LEGACY_DEFAULTS[key].includes(theme[key].toLowerCase())) {
      result[key] = DEFAULT_THEME_COLORS[key];
    }
  }
  return result;
}

export function applyDefaultTheme(): void {
  applyWebUITheme(DEFAULT_THEME_COLORS);
}

function setThemeInputValues(theme: ThemeColors): void {
  const primaryInput = $('webui-theme-primary') as HTMLInputElement | null;
  const secondaryInput = $('webui-theme-secondary') as HTMLInputElement | null;
  const backgroundInput = $('webui-theme-background') as HTMLInputElement | null;
  const surfaceInput = $('webui-theme-surface') as HTMLInputElement | null;
  const textInput = $('webui-theme-text') as HTMLInputElement | null;

  if (primaryInput) primaryInput.value = theme.primary;
  if (secondaryInput) secondaryInput.value = theme.secondary;
  if (backgroundInput) backgroundInput.value = theme.background;
  if (surfaceInput) surfaceInput.value = theme.surface;
  if (textInput) textInput.value = theme.text;
}

function getThemeFromInputs(): ThemeColors {
  const primaryInput = $('webui-theme-primary') as HTMLInputElement | null;
  const secondaryInput = $('webui-theme-secondary') as HTMLInputElement | null;
  const backgroundInput = $('webui-theme-background') as HTMLInputElement | null;
  const surfaceInput = $('webui-theme-surface') as HTMLInputElement | null;
  const textInput = $('webui-theme-text') as HTMLInputElement | null;

  const primary = primaryInput?.value ?? DEFAULT_THEME_COLORS.primary;
  const secondary = secondaryInput?.value ?? DEFAULT_THEME_COLORS.secondary;
  const background = backgroundInput?.value ?? DEFAULT_THEME_COLORS.background;
  const surface = surfaceInput?.value ?? DEFAULT_THEME_COLORS.surface;
  const text = textInput?.value ?? DEFAULT_THEME_COLORS.text;

  return {
    primary: isValidHexColor(primary) ? primary : DEFAULT_THEME_COLORS.primary,
    secondary: isValidHexColor(secondary) ? secondary : DEFAULT_THEME_COLORS.secondary,
    background: isValidHexColor(background) ? background : DEFAULT_THEME_COLORS.background,
    surface: isValidHexColor(surface) ? surface : DEFAULT_THEME_COLORS.surface,
    text: isValidHexColor(text) ? text : DEFAULT_THEME_COLORS.text,
  };
}

function isValidHexColor(value: string): boolean {
  return /^#([0-9a-fA-F]{6})$/.test(value);
}

function isThemeColors(value: unknown): value is ThemeColors {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.primary === 'string' &&
    typeof candidate.secondary === 'string' &&
    typeof candidate.background === 'string' &&
    typeof candidate.surface === 'string' &&
    typeof candidate.text === 'string'
  );
}
