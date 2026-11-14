// Background tabs (docs/design/workspace.md section 4.30): every background tab drifts behind the
// active one as a cluster of its panes in #drift. Background panes are pictures, not live
// panes: a terminal is redrawn from its buffer a few times a second while it has new output,
// and other kinds show a card. The layer takes no pointer events.
import type { Rect } from './layout';
import {
  driftPlan,
  driftTime,
  clusterLayout,
  seedOf,
  SNAPSHOT_MS,
  SNAPSHOTS_PER_PASS,
  type ClusterDepth,
  type BackgroundTab,
} from './backgroundTabsModel';

export interface BackgroundTabInput extends BackgroundTab {
  depth: ClusterDepth;
}

/** A background terminal as the clusters read it. */
export interface BackgroundTerminal {
  readonly outputSeq: number;
  drawInto(canvas: HTMLCanvasElement, cssW: number, cssH: number): void;
}

/** What drawing the clusters reads of the workspace. */
export interface BackgroundTabsContext {
  tabs(): BackgroundTabInput[];
  activeId(): string;
  /** The pane area in window px. */
  area(): Rect;
  card(paneId: string): { icon: string; title: string };
  terminal(paneId: string): BackgroundTerminal | null;
}

interface PaneEl {
  el: HTMLElement;
  canvas: HTMLCanvasElement | null;
  /** The output count and size last drawn; -1 until the first draw. */
  seq: number;
  width: number;
  height: number;
}

interface ClusterEl {
  root: HTMLElement;
  drift: HTMLElement;
  body: HTMLElement;
  motion: Animation | null;
  /** The home and area the motion was planned for; a change replans it. */
  motionKey: string;
  panes: Map<string, PaneEl>;
}

export class BackgroundTabsLayer {
  private readonly field: HTMLElement;
  private readonly clusters = new Map<string, ClusterEl>();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly resize: ResizeObserver;
  private enabled = false;
  private timer: number | undefined;
  /** Where the last snapshot pass stopped, so a busy cluster cannot starve the ones after it. */
  private cursor = 0;

  constructor(
    layer: HTMLElement,
    private readonly panesRoot: HTMLElement,
    private readonly ctx: BackgroundTabsContext,
  ) {
    this.field = document.createElement('div');
    this.field.className = 'tab-cluster-field';
    // First in the layer, so the tab transition's ghosts draw over the clusters.
    layer.prepend(this.field);
    this.resize = new ResizeObserver(() => this.sync());
    this.reducedMotion.addEventListener('change', () => this.rebuild());
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      this.resize.observe(this.panesRoot);
      this.timer = window.setInterval(() => this.tick(), SNAPSHOT_MS);
      this.sync();
    } else {
      this.resize.disconnect();
      window.clearInterval(this.timer);
      this.timer = undefined;
      this.clear();
    }
  }

  /** Brings the clusters in line with the tabs: which exist, where they sit, and how deep. */
  sync(): void {
    if (!this.enabled) return;
    const tabs = this.ctx.tabs();
    const depths = new Map(tabs.map((t) => [t.id, t.depth]));
    const area = this.ctx.area();
    const placements = clusterLayout(tabs, this.ctx.activeId(), area);
    const keep = new Set<string>();
    for (const place of placements) {
      keep.add(place.tabId);
      const cluster = this.clusters.get(place.tabId) ?? this.createCluster(place.tabId);
      setBox(cluster.root, place.rect);
      this.plan(cluster, place.tabId, place.rect, area);
      cluster.root.dataset.depth = depths.get(place.tabId) ?? 'rest';
      const live = new Set<string>();
      for (const [paneId, r] of place.panes) {
        live.add(paneId);
        let pane = cluster.panes.get(paneId);
        // A pane that changed kind in place keeps its id but needs the other picture.
        if (pane && (pane.canvas !== null) !== (this.ctx.terminal(paneId) !== null)) {
          pane.el.remove();
          pane = undefined;
        }
        pane ??= this.createPane(cluster, paneId);
        setBox(pane.el, { x: r.x - place.rect.x, y: r.y - place.rect.y, width: r.width, height: r.height });
        if (pane.canvas) {
          if (pane.width !== r.width || pane.height !== r.height) pane.seq = -1;
          pane.width = r.width;
          pane.height = r.height;
        } else {
          this.fillCard(pane.el, paneId);
        }
      }
      for (const [paneId, pane] of cluster.panes) {
        if (live.has(paneId)) continue;
        pane.el.remove();
        cluster.panes.delete(paneId);
      }
    }
    for (const [tabId, cluster] of this.clusters) {
      if (keep.has(tabId)) continue;
      cluster.motion?.cancel();
      cluster.root.remove();
      this.clusters.delete(tabId);
    }
  }

  /** Window rects of every background pane as drawn, drift included. */
  paneRects(): Map<string, DOMRect> {
    const out = new Map<string, DOMRect>();
    for (const cluster of this.clusters.values()) {
      for (const [id, pane] of cluster.panes) out.set(id, pane.el.getBoundingClientRect());
    }
    return out;
  }

  /**
   * Hides a cluster that panes are receding into, so the snapshot does not show twice under the
   * ghosts; returns where each of its panes is drawn.
   */
  arrive(tabId: string): Map<string, DOMRect> {
    const cluster = this.clusters.get(tabId);
    const out = new Map<string, DOMRect>();
    if (!cluster) return out;
    cluster.root.classList.add('tab-cluster-arriving');
    for (const [id, pane] of cluster.panes) {
      this.draw(id, pane);
      out.set(id, pane.el.getBoundingClientRect());
    }
    return out;
  }

  /** Shows every cluster `arrive` hid. */
  settle(): void {
    for (const { root } of this.clusters.values()) {
      if (!root.classList.contains('tab-cluster-arriving')) continue;
      // The ghosts land where the cluster is drawn, so it takes their place at once, not fading in.
      root.style.transition = 'none';
      root.classList.remove('tab-cluster-arriving');
      void root.offsetWidth;
      root.style.transition = '';
    }
  }

  private createCluster(tabId: string): ClusterEl {
    const root = document.createElement('div');
    root.className = 'tab-cluster';
    const drift = document.createElement('div');
    drift.className = 'tab-cluster-drift';
    const body = document.createElement('div');
    body.className = 'tab-cluster-body';
    drift.append(body);
    root.append(drift);
    this.field.append(root);
    const cluster: ClusterEl = { root, drift, body, motion: null, motionKey: '', panes: new Map() };
    this.clusters.set(tabId, cluster);
    return cluster;
  }

  /**
   * Starts the cluster's drift, or replans it when its home or the pane area changed. The drift
   * moves the wrapper and the dimming filter sits on the body inside it, so the compositor moves
   * an already filtered layer instead of refiltering every frame.
   */
  private plan(cluster: ClusterEl, tabId: string, home: Rect, area: Rect): void {
    if (this.reducedMotion.matches) return;
    const key = [home.x, home.y, home.width, home.height, area.x, area.y, area.width, area.height].map(Math.round).join(',');
    if (key === cluster.motionKey) return;
    cluster.motionKey = key;
    cluster.motion?.cancel();
    const seed = seedOf(tabId);
    const plan = driftPlan(seed, home, area);
    cluster.motion = cluster.drift.animate(plan.keyframes, plan.options);
    cluster.motion.currentTime = driftTime(seed, Number(plan.options.duration), performance.now());
  }

  private createPane(cluster: ClusterEl, paneId: string): PaneEl {
    const el = document.createElement('div');
    el.className = 'tab-cluster-pane';
    let canvas: HTMLCanvasElement | null = null;
    if (this.ctx.terminal(paneId)) {
      canvas = document.createElement('canvas');
      el.append(canvas);
    } else {
      el.classList.add('tab-cluster-card');
      const icon = document.createElement('span');
      icon.className = 'tab-cluster-card-icon';
      const title = document.createElement('span');
      title.className = 'tab-cluster-card-title';
      el.append(icon, title);
    }
    cluster.body.append(el);
    const pane: PaneEl = { el, canvas, seq: -1, width: 0, height: 0 };
    cluster.panes.set(paneId, pane);
    return pane;
  }

  private fillCard(el: HTMLElement, paneId: string): void {
    const { icon, title } = this.ctx.card(paneId);
    const [iconEl, titleEl] = el.children;
    if (iconEl.textContent !== icon) iconEl.textContent = icon;
    if (titleEl.textContent !== title) titleEl.textContent = title;
  }

  /** Redraws a terminal's picture when it had output or changed size since the last draw. */
  private draw(paneId: string, pane: PaneEl): boolean {
    if (!pane.canvas) return false;
    const term = this.ctx.terminal(paneId);
    if (!term || term.outputSeq === pane.seq || pane.width < 1 || pane.height < 1) return false;
    term.drawInto(pane.canvas, pane.width, pane.height);
    pane.seq = term.outputSeq;
    return true;
  }

  private tick(): void {
    if (document.hidden) return;
    this.sync();
    const panes: Array<[string, PaneEl]> = [];
    for (const cluster of this.clusters.values()) panes.push(...cluster.panes);
    if (panes.length === 0) return;
    let drawn = 0;
    for (let i = 0; i < panes.length && drawn < SNAPSHOTS_PER_PASS; i++) {
      const [id, pane] = panes[(this.cursor + i) % panes.length];
      if (this.draw(id, pane)) drawn++;
    }
    this.cursor = (this.cursor + 1) % panes.length;
  }

  private clear(): void {
    for (const cluster of this.clusters.values()) cluster.motion?.cancel();
    this.clusters.clear();
    this.field.replaceChildren();
  }

  private rebuild(): void {
    if (!this.enabled) return;
    this.clear();
    this.sync();
  }
}

function setBox(el: HTMLElement, r: Rect): void {
  const s = el.style;
  const left = `${r.x}px`;
  const top = `${r.y}px`;
  const width = `${r.width}px`;
  const height = `${r.height}px`;
  if (s.left !== left) s.left = left;
  if (s.top !== top) s.top = top;
  if (s.width !== width) s.width = width;
  if (s.height !== height) s.height = height;
}
