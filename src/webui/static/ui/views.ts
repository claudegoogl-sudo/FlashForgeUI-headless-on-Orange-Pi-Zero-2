/**
 * @fileoverview View switching for the WebUI shell.
 *
 * The page is a set of screens (Print, Heat, Move, Files, Light) selected from the dock.
 * Print and Move share the camera stage, so the camera stream is never torn down when
 * switching between them. Panels are mounted into the `data-slot` containers of
 * index.html once; switching a view only changes `data-active-view` on #views, which the
 * stylesheet uses to show the right screen.
 */

import { $ } from '../shared/dom.js';
import { componentRegistry } from './panel-registry.js';

export type ViewName = 'print' | 'heat' | 'move' | 'files' | 'light';
export type StageName = 'camera' | 'layers';

const VIEWS: readonly ViewName[] = ['print', 'heat', 'move', 'files', 'light'];

interface ViewHooks {
  enter?: () => void;
  leave?: () => void;
}

const hooks = new Map<ViewName, ViewHooks>();
let activeView: ViewName = 'print';
let mounted = false;

export function registerViewHooks(view: ViewName, viewHooks: ViewHooks): void {
  hooks.set(view, viewHooks);
}

export function getActiveView(): ViewName {
  return activeView;
}

function isViewName(value: string | null | undefined): value is ViewName {
  return VIEWS.includes(value as ViewName);
}

/** Mount every panel into its slot (once). */
export function mountPanels(): void {
  if (mounted) {
    return;
  }
  for (const componentId of componentRegistry.getAllIds()) {
    const slot = componentRegistry.getSlot(componentId);
    const container = slot ? document.querySelector<HTMLElement>(`[data-slot="${slot}"]`) : null;
    if (!container) {
      console.error(`[Views] No slot "${slot}" for panel ${componentId}`);
      continue;
    }
    container.appendChild(componentRegistry.createElement(componentId));
  }
  mounted = true;
}

export function setStage(stage: StageName): void {
  const slot = document.querySelector<HTMLElement>('.slot-stage');
  slot?.setAttribute('data-stage-active', stage);
  document.querySelectorAll<HTMLButtonElement>('#stage-toggle [data-stage]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.stage === stage));
  });
  // The layer view draws on a canvas that has no size while hidden; ask it to redraw.
  window.dispatchEvent(new Event('resize'));
}

export function showView(view: ViewName, options: { stage?: StageName } = {}): void {
  const views = $('views');
  if (!views) {
    return;
  }

  if (view !== activeView) {
    hooks.get(activeView)?.leave?.();
    activeView = view;
    hooks.get(view)?.enter?.();
  }

  views.setAttribute('data-active-view', view);
  document.querySelectorAll<HTMLButtonElement>('#dock [data-view-target]').forEach((button) => {
    const on = button.dataset.viewTarget === view;
    button.classList.toggle('on', on);
    if (on) {
      button.setAttribute('aria-current', 'page');
      for (const name of ['--h', '--l', '--on']) {
        const value = button.style.getPropertyValue(name);
        if (value) {
          views.style.setProperty(name, value);
        } else {
          views.style.removeProperty(name);
        }
      }
    } else {
      button.removeAttribute('aria-current');
    }
  });

  if (view === 'move') {
    setStage('camera');
  } else if (options.stage) {
    setStage(options.stage);
  }

  if (window.location.hash !== `#${view}`) {
    window.history.replaceState(null, '', `#${view}`);
  }
}

/** Wire the dock and the stage toggle. Safe to call once at startup. */
export function setupViews(): void {
  document.querySelectorAll<HTMLButtonElement>('#dock [data-view-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.viewTarget;
      if (isViewName(target)) {
        showView(target);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('#stage-toggle [data-stage]').forEach((button) => {
    button.addEventListener('click', () => {
      setStage(button.dataset.stage === 'layers' ? 'layers' : 'camera');
    });
  });

  window.addEventListener('hashchange', () => {
    const target = window.location.hash.slice(1);
    if (isViewName(target)) {
      showView(target);
    }
  });

  const initial = window.location.hash.slice(1);
  showView(isViewName(initial) ? initial : 'print');
}
