import './tabStrip.css';
import { TabItem } from './tabItem';
import type { Workspace } from './workspace';

const DRAG_THRESHOLD_PX = 4;
const HOVER_SWITCH_MS = 500;

/** Window-top tab strip, visible with two or more tabs (docs/design.md section 4.10). */
export class TabStrip {
  private readonly items = new Map<string, TabItem>();
  private readonly add: HTMLButtonElement;
  private hoverTab: string | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private dragging = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly workspace: Workspace,
    private readonly focusTerminal: () => void,
  ) {
    this.add = document.createElement('button');
    this.add.type = 'button';
    this.add.className = 'tab-add';
    this.add.textContent = '+';
    this.add.title = 'New tab';
    this.add.addEventListener('click', () => this.workspace.newTab());
    // Clicking a control would otherwise move focus off xterm; click handlers still fire.
    this.el.addEventListener('mousedown', (e) => {
      if (!(e.target as HTMLElement).closest('.tab-rename')) e.preventDefault();
    });
    workspace.onChange(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const tabs = this.workspace.tabs();
    const live = new Set(tabs.map((t) => t.id));
    for (const [id, item] of this.items) {
      if (live.has(id)) continue;
      item.el.remove();
      this.items.delete(id);
    }
    tabs.forEach((info, i) => {
      let item = this.items.get(info.id);
      if (!item) {
        item = new TabItem(info.id, {
          onSwitch: (id) => {
            if (!this.dragging) this.workspace.switchTab(id);
          },
          onClose: (id) => void this.workspace.requestCloseTab(id),
          onRename: (id, name) => this.workspace.renameTab(id, name),
          onRenameDone: this.focusTerminal,
          onPointerDown: (id, e) => this.beginReorder(id, e),
        });
        this.items.set(info.id, item);
      }
      item.update(info);
      if (this.el.children[i] !== item.el) this.el.insertBefore(item.el, this.el.children[i] ?? null);
    });
    this.el.append(this.add);
    const show = tabs.length >= 2;
    this.el.hidden = !show;
    document.body.classList.toggle('has-tabs', show);
  }

  /** Called while a terminal drag runs; switches to the tab under the pointer after a dwell. */
  dragHover(pos: { x: number; y: number } | null): void {
    const id = pos ? this.tabAt(pos.x, pos.y) : null;
    if (id === this.hoverTab) return;
    this.hoverTab = id;
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
    if (!id) return;
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.workspace.switchTab(id);
    }, HOVER_SWITCH_MS);
  }

  private tabAt(x: number, y: number): string | null {
    if (this.el.hidden) return null;
    for (const [id, item] of this.items) {
      const r = item.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
    }
    return null;
  }

  private beginReorder(id: string, e: PointerEvent): void {
    const { pointerId, clientX: x0, clientY: y0 } = e;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!this.dragging) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_THRESHOLD_PX) return;
        this.dragging = true;
        this.items.get(id)?.el.classList.add('dragging');
      }
      const order = this.workspace.tabs().map((t) => t.id);
      const from = order.indexOf(id);
      const to = order.findIndex((tid) => {
        const r = this.items.get(tid)?.el.getBoundingClientRect();
        return !!r && ev.clientX >= r.left && ev.clientX <= r.right;
      });
      if (from >= 0 && to >= 0 && to !== from) this.workspace.reorderTab(from, to);
    };
    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
      this.items.get(id)?.el.classList.remove('dragging');
      // The click that follows pointerup must still see the flag.
      setTimeout(() => (this.dragging = false), 0);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
  }
}
