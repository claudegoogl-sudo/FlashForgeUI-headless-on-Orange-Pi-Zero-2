/**
 * @fileoverview Shared DOM helper utilities for the WebUI static client.
 *
 * Provides lightweight wrappers for common DOM interactions including
 * element lookup, visibility toggling, text updates, and toast notifications.
 * These helpers keep `app.ts` focused on higher-level orchestration logic.
 */

export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function showElement(id: string): void {
  const element = $(id);
  if (element) {
    element.classList.remove('hidden');
  }
}

export function hideElement(id: string): void {
  const element = $(id);
  if (element) {
    element.classList.add('hidden');
  }
}

export function setTextContent(id: string, text: string): void {
  const element = $(id);
  if (element) {
    element.textContent = text;
  }
}

export function showToast(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const toast = $('toast');
  if (!toast) {
    return;
  }

  toast.textContent = message;
  toast.className = `toast ${type}`;
  showElement('toast');
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => hideElement('toast'), 300);
  }, 3000);
}

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive. */
  danger?: boolean;
}

/**
 * Ask for confirmation in the page's own dialog. Resolves true only when the confirm
 * button is pressed; Escape, the backdrop and the cancel button resolve false.
 * Focus starts on the cancel button so a stray Enter never confirms.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  const modal = $('confirm-modal');
  const title = $('confirm-title');
  const message = $('confirm-message');
  const ok = $('confirm-ok') as HTMLButtonElement | null;
  const cancel = $('confirm-cancel') as HTMLButtonElement | null;
  if (!modal || !title || !message || !ok || !cancel) {
    return Promise.resolve(window.confirm(`${options.title}\n\n${options.message}`));
  }

  title.textContent = options.title;
  message.textContent = options.message;
  ok.textContent = options.confirmLabel;
  ok.classList.toggle('danger', options.danger === true);
  cancel.textContent = options.cancelLabel ?? 'Cancel';

  const opener = document.activeElement as HTMLElement | null;
  modal.classList.remove('hidden');
  cancel.focus();

  return new Promise<boolean>((resolve) => {
    const finish = (result: boolean): void => {
      modal.classList.add('hidden');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey, true);
      opener?.focus();
      resolve(result);
    };
    const onOk = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onBackdrop = (event: MouseEvent): void => {
      if (event.target === modal) finish(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        finish(false);
      } else if (event.key === 'Tab') {
        const order = [cancel, ok];
        const index = order.indexOf(document.activeElement as HTMLButtonElement);
        order[(index + (event.shiftKey ? order.length - 1 : 1)) % order.length]?.focus();
        event.preventDefault();
      }
    };
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
  });
}
