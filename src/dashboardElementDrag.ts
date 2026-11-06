import { attachBodyDrag } from './bodyDrag';
import type { DashboardColumn } from './dashboardColumns';
import type { DashboardElement, ElementZone } from './dashboardSections';
import './dashboardElementDrag.css';

/** A gap something can be dropped into, spanning its column from `left` to `right`. */
export interface DropTarget<T> {
  value: T;
  y: number;
  left: number;
  right: number;
}

/** What a drag works with, read when it starts; null refuses the drag. */
export interface DragSetup<T> {
  dragged: HTMLElement | null;
  targets: () => DropTarget<T>[];
}

/**
 * Lets `handle` drag something among the gaps `setup` offers. The drop line goes to whichever gap
 * is nearest the pointer in the column under it (any column when none is). It is drawn in
 * `lineHost`, which must be positioned and must not scroll.
 */
export function attachDropDrag<T>(
  handle: HTMLElement,
  lineHost: HTMLElement,
  setup: () => DragSetup<T> | null,
  onDrop: (value: T) => void,
): void {
  attachBodyDrag(handle, (start) => {
    if (start.pointerType !== 'mouse') return;
    const s = setup();
    if (!s) return;
    s.dragged?.classList.add('dragging');
    document.body.classList.add('dashboard-element-dragging');
    const line = document.createElement('div');
    line.className = 'element-drop-line';
    lineHost.appendChild(line);

    let chosen: DropTarget<T> | null = null;

    const update = (x: number, y: number): void => {
      const all = s.targets();
      const under = all.filter((t) => x >= t.left && x <= t.right);
      chosen = null;
      for (const t of under.length > 0 ? under : all) {
        if (!chosen || Math.abs(t.y - y) < Math.abs(chosen.y - y)) chosen = t;
      }
      if (!chosen) return;
      const host = lineHost.getBoundingClientRect();
      line.style.top = `${chosen.y - host.top}px`;
      line.style.left = `${chosen.left - host.left}px`;
      line.style.width = `${chosen.right - chosen.left}px`;
    };

    const cleanup = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      line.remove();
      s.dragged?.classList.remove('dragging');
      document.body.classList.remove('dashboard-element-dragging');
    };
    const onMove = (e: PointerEvent): void => update(e.clientX, e.clientY);
    const onUp = (): void => {
      const target = chosen;
      cleanup();
      if (target) onDrop(target.value);
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
    update(start.clientX, start.clientY);
  });
}

/** A slot elements can be dropped into, inside the scrolling column `columnEl`. */
export interface DropZone {
  zone: ElementZone;
  column: DashboardColumn;
  el: HTMLElement;
  columnEl: HTMLElement;
}

export interface ElementDrop {
  zone: ElementZone;
  column: DashboardColumn;
  /** The element the dropped one lands just before, or null for last in the slot. */
  before: DashboardElement | null;
}

/** A gap before each shown element of each zone, and one after the last. */
export function elementTargets(zones: DropZone[]): DropTarget<ElementDrop>[] {
  const out: DropTarget<ElementDrop>[] = [];
  for (const { zone, column, el, columnEl } of zones) {
    const col = columnEl.getBoundingClientRect();
    const at = (before: DashboardElement | null, y: number): DropTarget<ElementDrop> => ({
      value: { zone, column, before },
      y,
      left: col.left,
      right: col.right,
    });
    const shown = Array.from(el.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.element !== undefined && !c.hidden,
    );
    if (shown.length === 0) {
      // An empty zone may not be laid out, so it lands just under whatever precedes it.
      const laidOut = el.getClientRects().length > 0;
      const y = laidOut
        ? el.getBoundingClientRect().top
        : (el.previousElementSibling?.getBoundingClientRect().bottom ?? col.top);
      out.push(at(null, y));
      continue;
    }
    let prevBottom: number | null = null;
    for (const c of shown) {
      const r = c.getBoundingClientRect();
      out.push(at(c.dataset.element as DashboardElement, prevBottom === null ? r.top : (prevBottom + r.top) / 2));
      prevBottom = r.bottom;
    }
    out.push(at(null, prevBottom!));
  }
  return out;
}
