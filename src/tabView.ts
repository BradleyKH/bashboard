import type { FindBar } from './findBar';
import { clampRatio, leaves, setRatio, type CellSize, type Rect } from './layout';
import { LayoutView } from './layoutView';
import type { PaneView } from './paneView';
import type { TabState } from './tabs';
import type { TabStore } from './tabStore';
import type { TitleStrip } from './titleStrip';
import { PaneZoom } from './zoom';

/** What drawing the active tab reads of the workspace. */
export interface TabViewContext {
  readonly store: TabStore;
  readonly root: HTMLElement;
  readonly hosts: Map<string, HTMLElement>;
  readonly paneViews: ReadonlyMap<string, PaneView>;
  strip(id: string): TitleStrip | undefined;
  readonly findBar: FindBar;
  layoutCell(): CellSize | null;
  containerRect(): Rect;
  /** Closes the find bar unless it is on the focused pane. */
  syncFindBar(): void;
  hasAttention(id: string): boolean;
}

/**
 * Puts the active tab's split tree on screen (docs/design/workspace.md section 4.2), with each
 * tab's zoom: the zoomed pane alone fills the pane area while the rest leave the DOM, and they
 * come back when the zoom ends.
 */
export class TabView {
  private readonly view: LayoutView;
  private readonly zoom = new PaneZoom();
  /** Tab id to the panes that tab's zoom took off screen, restored when the zoom ends. */
  private readonly zoomHidden = new Map<string, Set<string>>();
  /** The active tab's zoomed pane as the last render decided it. */
  private zoomed: string | null = null;

  constructor(private readonly ctx: TabViewContext) {
    this.view = new LayoutView(ctx.root, {
      clampRatio: (path, ratio) => {
        const cell = ctx.layoutCell();
        if (!ctx.store.tree || !cell) return ratio;
        return clampRatio(ctx.store.tree, path, ratio, ctx.containerRect(), cell);
      },
      // Panes refit live during the drag through their ResizeObservers; this commits the ratio.
      onRatioChange: (path, ratio) => {
        if (!ctx.store.tree) return;
        ctx.store.tree = setRatio(ctx.store.tree, path, ratio);
        this.render();
      },
    });
  }

  get zoomedId(): string | null {
    return this.zoomed;
  }

  /** Keeps a host that is off screen alive, so a Local Browser page loads before it is shown. */
  keep(host: HTMLElement): void {
    this.view.keep(host);
  }

  /** Re-rendering moves hosts and blurs the focused pane, so focus is restored after. */
  render(): void {
    const { ctx } = this;
    const tree = ctx.store.tree;
    const tabId = ctx.store.activeId;
    ctx.syncFindBar();
    const zoomed = this.zoom.zoomed(tabId, tree, ctx.store.focusedId);
    this.zoomed = zoomed;
    const hidden = this.zoomHidden.get(tabId);
    if (!tree) {
      this.zoomHidden.delete(tabId);
      this.view.clear();
      return;
    }
    if (zoomed !== null) {
      this.view.render({ kind: 'pane', paneId: zoomed }, ctx.hosts, ctx.store.focusedId);
      const set = hidden ?? new Set<string>();
      for (const id of leaves(tree)) {
        if (id === zoomed || set.has(id)) continue;
        set.add(id);
        ctx.paneViews.get(id)?.setExpanded(false);
      }
      this.zoomHidden.set(tabId, set);
    } else {
      this.view.render(tree, ctx.hosts, ctx.store.focusedId);
      // After render, so the hosts are attached when WebGL loads and the refit runs.
      if (hidden) {
        this.zoomHidden.delete(tabId);
        const onScreen = leaves(tree);
        for (const id of hidden) if (onScreen.includes(id)) ctx.paneViews.get(id)?.setExpanded(true);
      }
    }
    this.syncZoomButtons();
    if (!ctx.findBar.isOpen()) ctx.paneViews.get(ctx.store.focusedId)?.focus();
  }

  /** Design 4.2 Zoom: toggles the active tab's zoom on its focused pane and renders; false when nothing changed. */
  toggleZoom(): boolean {
    const { activeId, tree, focusedId } = this.ctx.store;
    // An entry a tree or focus change already invalidated shows as zoomed until the next render.
    const stale = this.zoomed !== null && this.zoom.zoomed(activeId, tree, focusedId) === null;
    if (!stale && !this.zoom.toggle(activeId, tree, focusedId)) return false;
    this.render();
    return true;
  }

  /** Ends the tab's zoom and renders. */
  endZoom(tabId: string): void {
    this.zoom.end(tabId);
    this.render();
  }

  /** Drops a closed or emptied tab's zoom. */
  forget(tabId: string): void {
    this.zoom.forget(tabId);
    this.zoomHidden.delete(tabId);
  }

  /** The zoom button pulses while a pane its zoom hides has attention (design 4.2). */
  syncZoomButtons(): void {
    const tree = this.ctx.store.tree;
    if (!tree) return;
    const ids = leaves(tree);
    const z = this.zoomed;
    const hiddenAttention = z !== null && ids.some((o) => o !== z && this.ctx.hasAttention(o));
    for (const id of ids) {
      this.ctx.strip(id)?.setZoom({
        available: tree.kind === 'split',
        zoomed: id === z,
        attention: id === z && hiddenAttention,
      });
    }
  }

  /** Window rects of the panes on screen: the zoomed pane alone, else every leaf. */
  paneRects(): Map<string, DOMRect> {
    const out = new Map<string, DOMRect>();
    if (!this.ctx.store.tree) return out;
    for (const id of this.onScreen()) {
      const host = this.ctx.hosts.get(id);
      if (host) out.set(id, host.getBoundingClientRect());
    }
    return out;
  }

  /** The outgoing tab's panes leave the DOM at the next render, releasing WebGL as collapsing does. */
  hideTab(tab: TabState): void {
    this.ctx.findBar.close(false);
    if (!tab.tree) return;
    for (const id of leaves(tab.tree)) this.ctx.paneViews.get(id)?.setExpanded(false);
  }

  /** Renders the active tab, then takes WebGL and refits once its hosts are attached. */
  showActive(): void {
    this.render();
    if (this.ctx.store.tree) {
      for (const id of this.onScreen()) this.ctx.paneViews.get(id)?.setExpanded(true);
    }
    this.ctx.paneViews.get(this.ctx.store.focusedId)?.focus();
  }

  private onScreen(): string[] {
    const tree = this.ctx.store.tree;
    if (!tree) return [];
    return this.zoomed !== null ? [this.zoomed] : leaves(tree);
  }
}
