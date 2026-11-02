import { attachBodyDrag } from './bodyDrag';
import type { DashboardElement, ElementZone } from './dashboardSections';
import './dashboardElementDrag.css';

/** A container elements can be dropped into. */
export interface DropZone {
  zone: ElementZone;
  el: HTMLElement;
}

interface DropPosition {
  zone: ElementZone;
  before: DashboardElement | null;
  y: number;
}

/**
 * Lets `handle` (a section header, or the whole clock) drag the element `id` among `zones`.
 * `onDrop` gets the zone and the element the dragged one should land just before, or null for
 * last in that zone. The drop line goes to whichever gap is nearest the pointer. It is drawn in
 * `lineHost`, which must be positioned, with an offset that may be negative for a zone above it.
 */
export function attachElementDrag(
  handle: HTMLElement,
  zones: DropZone[],
  lineHost: HTMLElement,
  id: DashboardElement,
  onDrop: (zone: ElementZone, before: DashboardElement | null) => void,
): void {
  attachBodyDrag(handle, (start) => {
    if (start.pointerType !== 'mouse') return;
    const selector = `:scope > [data-element="${id}"]`;
    const dragged = zones.map((z) => z.el.querySelector<HTMLElement>(selector)).find((el) => el !== null) ?? null;
    dragged?.classList.add('dragging');
    document.body.classList.add('dashboard-element-dragging');
    const line = document.createElement('div');
    line.className = 'element-drop-line';
    lineHost.appendChild(line);

    let chosen: DropPosition | null = null;

    const positions = (): DropPosition[] => {
      const out: DropPosition[] = [];
      for (const { zone, el } of zones) {
        const shown = Array.from(el.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && c.dataset.element !== undefined && !c.hidden,
        );
        if (shown.length === 0) {
          // An empty zone may not be laid out, so it lands just under whatever precedes it.
          const laidOut = el.getClientRects().length > 0;
          const y = laidOut
            ? el.getBoundingClientRect().top
            : (el.previousElementSibling?.getBoundingClientRect().bottom ?? lineHost.getBoundingClientRect().top);
          out.push({ zone, before: null, y });
          continue;
        }
        let prevBottom: number | null = null;
        for (const c of shown) {
          const r = c.getBoundingClientRect();
          const y = prevBottom === null ? r.top : (prevBottom + r.top) / 2;
          out.push({ zone, before: c.dataset.element as DashboardElement, y });
          prevBottom = r.bottom;
        }
        out.push({ zone, before: null, y: prevBottom! });
      }
      return out;
    };

    const update = (clientY: number): void => {
      chosen = null;
      for (const p of positions()) {
        if (!chosen || Math.abs(p.y - clientY) < Math.abs(chosen.y - clientY)) chosen = p;
      }
      if (chosen) line.style.top = `${chosen.y - lineHost.getBoundingClientRect().top}px`;
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
      const target = chosen;
      cleanup();
      if (target) onDrop(target.zone, target.before);
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
