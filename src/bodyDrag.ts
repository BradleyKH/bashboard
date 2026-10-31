const DRAG_THRESHOLD_PX = 4;

/**
 * Starts `onDragStart` once the pointer moves 4 px from a left-button press on the row body,
 * and swallows the click that would otherwise follow, so a plain click still opens the row.
 */
export function attachBodyDrag(
  row: HTMLElement,
  onDragStart: (e: PointerEvent) => void,
): void {
  let dragged = false;
  row.addEventListener('pointerdown', (e) => {
    dragged = false;
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, .favorite-handle')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    const move = (ev: PointerEvent): void => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      stop();
      dragged = true;
      onDragStart(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  });
  row.addEventListener(
    'click',
    (e) => {
      if (!dragged) return;
      dragged = false;
      e.stopImmediatePropagation();
    },
    true,
  );
}
