import { attachBodyDrag } from './bodyDrag';
import type { DashboardElement } from './dashboardSections';
import './dashboardElementDrag.css';

/** Where a dragged element lands: just before an element in the list, last (null), or the top slot. */
export type ElementDropTarget = DashboardElement | null | 'top';

/**
 * Lets `handle` (a section header, or the whole clock) drag the element `id` to another place in
 * `list`. `onDrop` gets the element the dragged one should land just before, or null for last.
 * With `top`, the slot above Repo is a drop position too, chosen while the pointer is nearer it
 * than the list's first gap.
 */
export function attachElementDrag(
  handle: HTMLElement,
  list: HTMLElement,
  id: DashboardElement,
  onDrop: (target: ElementDropTarget) => void,
  top?: HTMLElement,
): void {
  attachBodyDrag(handle, (start) => {
    if (start.pointerType !== 'mouse') return;
    const selector = `:scope > [data-element="${id}"]`;
    const dragged = list.querySelector<HTMLElement>(selector) ?? top?.querySelector<HTMLElement>(selector) ?? null;
    dragged?.classList.add('dragging');
    document.body.classList.add('dashboard-element-dragging');
    const line = document.createElement('div');
    line.className = 'element-drop-line';
    list.appendChild(line);

    let before: ElementDropTarget = null;

    const update = (clientY: number): void => {
      const shown = Array.from(list.children).filter(
        (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.element !== undefined && !c.hidden,
      );
      const listTop = list.getBoundingClientRect().top;
      before = null;
      let y = 0;
      let prevBottom: number | null = null;
      let placed = false;
      for (const el of shown) {
        const r = el.getBoundingClientRect();
        if (clientY < r.top + r.height / 2) {
          before = el.dataset.element as DashboardElement;
          y = prevBottom === null ? r.top : (prevBottom + r.top) / 2;
          placed = true;
          break;
        }
        prevBottom = r.bottom;
      }
      if (!placed) y = prevBottom ?? listTop;
      if (top) {
        // An empty slot is hidden, so it lands just under whatever precedes it.
        const topY = top.hidden
          ? (top.previousElementSibling?.getBoundingClientRect().bottom ?? listTop)
          : top.getBoundingClientRect().top;
        const firstY = shown.length > 0 ? shown[0].getBoundingClientRect().top : listTop;
        if (clientY < (topY + firstY) / 2) {
          before = 'top';
          y = topY;
        }
      }
      line.style.top = `${y - listTop}px`;
    };

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      line.remove();
      dragged?.classList.remove('dragging');
      document.body.classList.remove('dashboard-element-dragging');
    };
    const onMove = (e: PointerEvent): void => update(e.clientY);
    const onUp = (): void => {
      const target = before;
      cleanup();
      onDrop(target);
    };
    const onCancel = (): void => cleanup();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    update(start.clientY);
  });
}
