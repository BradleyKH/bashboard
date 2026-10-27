import { windowEdgeAt, type DropTarget, type WindowEdge } from './docking';
import { dockZoneAt, type DockZone } from './layout';

export interface DockOverlayHooks {
  paneRects(): Map<string, DOMRect>;
  zonesFor(paneId: string): DockZone[];
  /** `null` means the layout is empty and the drop fills the window. */
  onDrop(target: DropTarget | null): void;
  /** A tab drop target under the point (a dashboard group), checked before every other target. */
  tabAt?(x: number, y: number): { tabId: string; rect: DOMRect } | null;
  /** The pane area, or null when the active tab has no expanded pane (no window bands then). */
  areaRect?(): DOMRect | null;
  onCancel(): void;
  /** Pointer position on every tracked move; `null` when the drag ends. */
  onHover?(pos: { x: number; y: number } | null): void;
}

interface Hit {
  paneId: string;
  zone: DockZone;
  rect: DOMRect;
}

/** Pointer-driven drag layer for docking (docs/design.md section 4.2); never HTML5 drag and drop. */
export class DockOverlay {
  private active: (() => void) | null = null;
  private retrack: (() => void) | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: DockOverlayHooks,
  ) {}

  isActive(): boolean {
    return this.active !== null;
  }

  /** Recomputes the drop zone at the last pointer position, after the pane rects changed. */
  refresh(): void {
    this.retrack?.();
  }

  begin(e: PointerEvent, label: string): void {
    this.active?.();

    const layer = document.createElement('div');
    layer.className = 'dock-layer';
    layer.style.cssText = 'position:fixed;inset:0;z-index:1000;touch-action:none;cursor:grabbing;';

    const zone = document.createElement('div');
    zone.className = 'dock-zone';
    zone.style.cssText = 'position:fixed;display:none;pointer-events:none;';

    const ghost = document.createElement('div');
    ghost.className = 'dock-ghost';
    ghost.textContent = label;
    ghost.style.cssText = 'position:fixed;pointer-events:none;white-space:nowrap;';

    layer.append(zone, ghost);
    (this.root.ownerDocument.body).append(layer);
    try {
      layer.setPointerCapture(e.pointerId);
    } catch {
      // The layer covers the window, so events still arrive without capture.
    }

    let hit: Hit | null = null;
    let windowHit: WindowEdge | null = null;
    let tabHit: string | null = null;
    let empty = false;

    let lastX = e.clientX;
    let lastY = e.clientY;
    const track = (x: number, y: number) => {
      lastX = x;
      lastY = y;
      this.hooks.onHover?.({ x, y });
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y + 12}px`;
      const rects = this.hooks.paneRects();
      empty = rects.size === 0;
      hit = null;
      windowHit = null;
      tabHit = null;
      const tab = this.hooks.tabAt?.(x, y) ?? null;
      if (tab) {
        tabHit = tab.tabId;
        zone.style.display = 'block';
        zone.dataset.zone = 'tab';
        zone.style.left = `${tab.rect.left}px`;
        zone.style.top = `${tab.rect.top}px`;
        zone.style.width = `${tab.rect.width}px`;
        zone.style.height = `${tab.rect.height}px`;
        return;
      }
      const area = this.hooks.areaRect?.() ?? null;
      const edge = area ? windowEdgeAt(area, x, y) : null;
      if (area && edge) {
        windowHit = edge;
        const third = edge === 'left' || edge === 'right' ? area.width / 3 : area.height / 3;
        const horizontal = edge === 'left' || edge === 'right';
        zone.style.display = 'block';
        zone.dataset.zone = `window-${edge}`;
        zone.style.left = `${edge === 'right' ? area.right - third : area.left}px`;
        zone.style.top = `${edge === 'bottom' ? area.bottom - third : area.top}px`;
        zone.style.width = `${horizontal ? third : area.width}px`;
        zone.style.height = `${horizontal ? area.height : third}px`;
        return;
      }
      for (const [paneId, rect] of rects) {
        if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue;
        const z = dockZoneAt(rect, x, y);
        if (this.hooks.zonesFor(paneId).includes(z)) hit = { paneId, zone: z, rect };
        break;
      }
      if (!hit) {
        zone.style.display = 'none';
        zone.removeAttribute('data-zone');
        return;
      }
      const { rect: r, zone: z } = hit;
      const w = z === 'left' || z === 'right' ? r.width / 2 : r.width;
      const h = z === 'top' || z === 'bottom' ? r.height / 2 : r.height;
      zone.style.display = 'block';
      zone.dataset.zone = z;
      zone.style.left = `${z === 'right' ? r.left + r.width / 2 : r.left}px`;
      zone.style.top = `${z === 'bottom' ? r.top + r.height / 2 : r.top}px`;
      zone.style.width = `${w}px`;
      zone.style.height = `${h}px`;
    };

    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
    };

    const cleanup = () => {
      layer.removeEventListener('pointermove', onMove);
      layer.removeEventListener('pointerup', onUp);
      layer.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      layer.remove();
      this.active = null;
      this.retrack = null;
      this.hooks.onHover?.(null);
    };
    // A click can follow pointerup and must not reach whatever sat under the drag.
    const suppressNextClick = () => {
      const drop = () => {
        window.removeEventListener('click', swallowClick, true);
        window.removeEventListener('pointerdown', drop, true);
        clearTimeout(timer);
      };
      const timer = setTimeout(drop, 50);
      window.addEventListener('click', swallowClick, true);
      window.addEventListener('pointerdown', drop, true);
    };

    const onMove = (ev: PointerEvent) => track(ev.clientX, ev.clientY);
    const onUp = (ev: PointerEvent) => {
      track(ev.clientX, ev.clientY);
      const tabTarget = tabHit;
      const edgeTarget = windowHit;
      const target = hit ? { paneId: hit.paneId, zone: hit.zone } : null;
      const wasEmpty = empty;
      cleanup();
      suppressNextClick();
      if (tabTarget) this.hooks.onDrop({ tabId: tabTarget });
      else if (edgeTarget) this.hooks.onDrop({ windowEdge: edgeTarget });
      else if (target) this.hooks.onDrop(target);
      else if (wasEmpty) this.hooks.onDrop(null);
      else this.hooks.onCancel();
    };
    const onCancel = () => {
      cleanup();
      this.hooks.onCancel();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      onCancel();
    };

    layer.addEventListener('pointermove', onMove);
    layer.addEventListener('pointerup', onUp);
    layer.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    this.active = cleanup;
    this.retrack = () => track(lastX, lastY);
    track(e.clientX, e.clientY);
  }
}
