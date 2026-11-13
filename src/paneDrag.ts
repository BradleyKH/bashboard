import { lastFolder } from './dashboardModel';
import { applyDock, dropZones, expandInto, type DockTarget, type DragSource, type DropTarget } from './docking';
import { DockOverlay } from './dockOverlay';
import { findPath, type CellSize, type Layout, type Rect } from './layout';
import type { PaneView } from './paneView';
import { addTab, switchTab as switchTabState, type TabState } from './tabs';
import type { TabStore } from './tabStore';
import { showToast } from './toast';
import type { OpenTerminalOptions, WorkspaceHooks } from './workspaceTypes';

/** What pane dragging and docking read of the workspace and the layout steps they drive. */
export interface PaneDragContext {
  readonly store: TabStore;
  readonly paneViews: ReadonlyMap<string, PaneView>;
  readonly root: HTMLElement;
  readonly hooks: WorkspaceHooks;
  layoutCell(): CellSize | null;
  containerRect(): Rect;
  paneRects(): Map<string, DOMRect>;
  titleOf(id: string): string;
  markCollapsed(id: string): void;
  render(): void;
  notify(): void;
  hideTab(tab: TabState): void;
  showActive(): void;
  /** Drops a tab's zoom, for a tab a move emptied. */
  forgetZoom(tabId: string): void;
  openTerminal(cwd?: string, opts?: OpenTerminalOptions): void;
  newTab(cwd?: string): void;
}

/**
 * Pane drags and where they land (docs/design/workspace.md section 4.2, docs/design/dashboard.md
 * section 4.6): the dock overlay, docking a pane into the active tab, and moving one to another
 * tab. A folder dragged from the dashboard opens a terminal where it drops.
 */
export class PaneDrag {
  private readonly overlay: DockOverlay;
  private drag: DragSource | null = null;

  constructor(private readonly ctx: PaneDragContext) {
    this.overlay = new DockOverlay(ctx.root, {
      paneRects: () => ctx.paneRects(),
      areaRect: () => (ctx.store.tree ? ctx.root.getBoundingClientRect() : null),
      zonesFor: (paneId) => (this.drag ? dropZones(this.drag, paneId) : []),
      onDrop: (target) => this.onDrop(target),
      onHover: (pos) => ctx.hooks.onDragHover?.(pos),
      tabAt: (x, y) => {
        if (this.drag?.kind !== 'pane') return null;
        const hit = ctx.hooks.tabDropAt?.(x, y) ?? null;
        return hit && hit.tabId !== ctx.store.tabOf(this.drag.paneId)?.id ? hit : null;
      },
      newTabAt: (x, y) => {
        const drag = this.drag;
        if (!drag || (drag.kind === 'pane' && !this.canMoveToNewTab(drag.paneId))) return null;
        return ctx.hooks.newTabDropAt?.(x, y) ?? null;
      },
      onCancel: () => {
        this.drag = null;
        ctx.paneViews.get(ctx.store.focusedId)?.focus();
      },
    });
  }

  isActive(): boolean {
    return this.overlay.isActive();
  }

  /** A tab switched to mid-drag has different pane rects. */
  refresh(): void {
    this.overlay.refresh();
  }

  /** Starts a pointer drag that docks a pane or opens a folder where it drops. */
  startDrag(source: DragSource, e: PointerEvent): void {
    if (source.kind === 'pane' && !this.ctx.paneViews.has(source.paneId)) return;
    this.drag = source;
    const label = source.kind === 'pane' ? this.ctx.titleOf(source.paneId) : lastFolder(source.path) || source.path;
    this.overlay.begin(e, label);
  }

  /**
   * Design 4.2 docking into the active tab; a null target is only valid while its layout is
   * empty. A pane from another tab moves into the active one, closing a source tab it empties.
   */
  dock(paneId: string, target: DockTarget | null): void {
    const { ctx } = this;
    const { store } = ctx;
    const pane = ctx.paneViews.get(paneId);
    const source = store.tabOf(paneId);
    if (!pane || !source) return;
    const fromActive = source.id === store.activeId;
    const inTree = fromActive && store.tree !== null && findPath(store.tree, paneId) !== null;
    const cell = ctx.layoutCell() ?? pane.cellSize();
    const r = applyDock(store.tree, paneId, inTree, target, ctx.containerRect(), cell);
    if (r.kind !== 'ok') {
      if (r.kind === 'noRoom') showToast('Not enough room to dock there');
      ctx.paneViews.get(store.focusedId)?.focus();
      return;
    }
    store.moveToActive(paneId);
    if (r.displaced) ctx.markCollapsed(r.displaced);
    store.tree = r.tree;
    store.setCollapsed(paneId, false);
    store.focusedId = paneId;
    ctx.render();
    if (!inTree) pane.setExpanded(true);
    pane.focus();
    ctx.notify();
  }

  /**
   * Design 4.6: a card dropped on another tab's group moves its pane into that tab without
   * switching to it. A collapsed pane stays collapsed; an expanded one splits that tab's focused
   * pane as expanding does, or lands collapsed when there is no room. A tab it empties closes.
   */
  moveToTab(paneId: string, tabId: string): void {
    const { ctx } = this;
    const { store } = ctx;
    const pane = ctx.paneViews.get(paneId);
    const source = store.tabOf(paneId);
    const target = store.find(tabId);
    if (!pane || !source || !target || source.id === tabId) {
      ctx.paneViews.get(store.focusedId)?.focus();
      return;
    }
    const activeBefore = store.activeId;
    const toActive = tabId === activeBefore;
    const wasCollapsed = store.isCollapsed(paneId);
    const wasOnScreen = source.id === activeBefore && !wasCollapsed;
    let next: Layout | null = null;
    if (!wasCollapsed) {
      // Every tab fills the same pane area, so the active tab's rect stands in for the target's.
      const cell = (toActive ? ctx.layoutCell() : null) ?? pane.cellSize();
      next = expandInto(target.tree, target.focusedId, paneId, ctx.containerRect(), cell);
      if (!next) showToast('Not enough room in that tab, so the pane moved collapsed');
    }
    store.moveTo(paneId, tabId, next === null);
    if (next) store.update(tabId, { tree: next, focusedId: paneId });
    else if (!wasCollapsed) ctx.markCollapsed(paneId);

    if (store.activeId !== activeBefore) {
      // The source was the active tab and the move emptied it.
      ctx.forgetZoom(source.id);
      if (store.activeId !== tabId) {
        const fallback = store.active;
        store.state = switchTabState(store.state, tabId);
        ctx.hideTab(fallback);
      }
      ctx.showActive();
    } else if (toActive) {
      ctx.render();
      if (next) {
        pane.setExpanded(true);
        pane.focus();
      }
    } else {
      if (wasOnScreen && next) pane.setExpanded(false);
      if (wasOnScreen) ctx.render();
      ctx.paneViews.get(store.focusedId)?.focus();
    }
    ctx.notify();
  }

  /** A pane alone in its tab has nothing to leave behind, so a new tab would only replace its own. */
  canMoveToNewTab(paneId: string): boolean {
    return (this.ctx.store.tabOf(paneId)?.panes.length ?? 0) > 1;
  }

  /**
   * Design 4.10: moves the pane into a new tab of its own, expanded and focused, and switches to
   * that tab.
   */
  moveToNewTab(paneId: string): void {
    const { ctx } = this;
    const { store } = ctx;
    const pane = ctx.paneViews.get(paneId);
    if (!pane || !this.canMoveToNewTab(paneId)) {
      ctx.paneViews.get(store.focusedId)?.focus();
      return;
    }
    const prevId = store.activeId;
    const tab = store.emptyTab();
    store.state = addTab(store.state, tab);
    store.moveTo(paneId, tab.id, false);
    store.update(tab.id, { tree: { kind: 'pane', paneId }, focusedId: paneId });
    // Read after the move, so the pane leaving that tab is not released only to be taken again.
    const prev = store.find(prevId);
    if (prev) ctx.hideTab(prev);
    ctx.showActive();
    ctx.notify();
  }

  private onDrop(target: DropTarget | null): void {
    const source = this.drag;
    this.drag = null;
    if (!source) return;
    if (target && 'newTab' in target) {
      if (source.kind === 'pane') this.moveToNewTab(source.paneId);
      else this.ctx.newTab(source.path);
    } else if (target && 'tabId' in target) {
      if (source.kind === 'pane') this.moveToTab(source.paneId, target.tabId);
    } else if (source.kind === 'pane') {
      this.dock(source.paneId, target);
    } else if (target) {
      this.ctx.openTerminal(source.path, { dock: target });
    } else {
      this.ctx.openTerminal(source.path);
    }
  }
}
