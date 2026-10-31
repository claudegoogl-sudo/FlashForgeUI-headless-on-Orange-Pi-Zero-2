/**
 * @fileoverview Small number animation helper for live readings.
 *
 * Status updates arrive every few seconds. Instead of jumping, a number eases to its new
 * value over a short time. Nothing here animates layout: only the text of one element
 * changes. Skipped entirely when the user prefers reduced motion.
 */

const frames = new WeakMap<HTMLElement, number>();

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function tweenNumber(
  element: HTMLElement,
  to: number,
  format: (value: number) => string = (value) => String(Math.round(value)),
  durationMs = 700
): void {
  const from = Number(element.dataset.value ?? Number.NaN);
  element.dataset.value = String(to);

  const pending = frames.get(element);
  if (pending !== undefined) {
    cancelAnimationFrame(pending);
  }

  if (!Number.isFinite(from) || from === to || prefersReducedMotion()) {
    element.textContent = format(to);
    return;
  }

  const start = performance.now();
  const step = (now: number): void => {
    const progress = Math.min(1, (now - start) / durationMs);
    const eased = 1 - (1 - progress) ** 3;
    element.textContent = format(from + (to - from) * eased);
    if (progress < 1) {
      frames.set(element, requestAnimationFrame(step));
    }
  };
  frames.set(element, requestAnimationFrame(step));
}
