/**
 * Drag handling for the vertical divider between a pane's list and its preview or diff (Files,
 * Search, and Git panes). The divider captures the pointer, so the drag keeps tracking when the
 * cursor leaves it or crosses the preview's own pointer handlers.
 */

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;

/**
 * Starts a drag from a pointerdown on `divider`, calling `apply` with the left side's share of
 * `container`'s width, clamped so neither side collapses.
 */
export function startSplitDrag(
  e: PointerEvent,
  divider: HTMLElement,
  container: HTMLElement,
  apply: (fraction: number) => void,
): void {
  if (e.button !== 0) return;
  e.preventDefault();
  divider.setPointerCapture(e.pointerId);
  divider.classList.add('dragging');
  const move = (ev: PointerEvent) => {
    const r = container.getBoundingClientRect();
    if (r.width <= 0) return;
    apply(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, (ev.clientX - r.left) / r.width)));
  };
  const up = () => {
    divider.classList.remove('dragging');
    divider.removeEventListener('pointermove', move);
    divider.removeEventListener('pointerup', up);
    divider.removeEventListener('pointercancel', up);
  };
  divider.addEventListener('pointermove', move);
  divider.addEventListener('pointerup', up);
  divider.addEventListener('pointercancel', up);
}
