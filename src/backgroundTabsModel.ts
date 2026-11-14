// Background tabs' geometry and motion (docs/design/workspace.md section 4.30): where each
// background tab's cluster sits, how its panes are laid out inside it, how it drifts, and how
// far forward it comes. No DOM, so it is unit-tested.
import { computeRects, leaves, type Layout, type Rect } from './layout';
import type { TransitionLeg } from './tabTransitionModel';

/** Forward for a tab with a pane that needs you, back for an idle one, rest otherwise. */
export type ClusterDepth = 'forward' | 'rest' | 'back';

export interface BackgroundTab {
  id: string;
  tree: Layout | null;
  /** Every pane in the tab, used when the tree is empty (every pane collapsed). */
  panes: readonly string[];
}

export interface ClusterPlacement {
  tabId: string;
  /** The cluster's box in window px. */
  rect: Rect;
  /** Each pane's box in window px, inside `rect`. */
  panes: Map<string, Rect>;
}

/** How often background terminals with new output are redrawn. */
export const SNAPSHOT_MS = 250;
/** Background terminals redrawn per pass at most, so many busy tabs cannot stall a frame. */
export const SNAPSHOTS_PER_PASS = 6;
/** Gap between a cluster's panes, in px at cluster scale, so the cluster reads as loose. */
export const CLUSTER_GAP_PX = 6;
/** How much of the room a cluster has in the pane area its path spans, per axis. */
export const ROAM = 0.8;
/** A cluster's loop takes this long, chosen per tab between the two. */
export const DRIFT_MIN_MS = 90_000;
export const DRIFT_MAX_MS = 150_000;

/** A cluster's size as a fraction of the pane area: smaller as tabs are added. */
export function clusterScale(tabCount: number): number {
  if (tabCount <= 3) return 0.3;
  return Math.max(0.16, 0.3 - 0.02 * (tabCount - 3));
}

/**
 * Homes for every tab, background or not, so a tab keeps its home as the active tab changes and
 * recedes to the same spot it came from. Homes sit on an ellipse that nearly touches the area's
 * edges, starting at the top left and running clockwise, so clusters stay in the edges and
 * corners rather than behind the middle of the panes.
 */
export function clusterHome(index: number, tabCount: number, area: Rect, size: { width: number; height: number }): Rect {
  const angle = -0.75 * Math.PI + (2 * Math.PI * index) / Math.max(1, tabCount);
  const rx = Math.max(0, (area.width - size.width) / 2) * 0.94;
  const ry = Math.max(0, (area.height - size.height) / 2) * 0.94;
  const cx = area.x + area.width / 2 + rx * Math.cos(angle);
  const cy = area.y + area.height / 2 + ry * Math.sin(angle);
  return { x: cx - size.width / 2, y: cy - size.height / 2, width: size.width, height: size.height };
}

/** Each pane's box inside a cluster: the tab's split tree at cluster scale, else a row of its panes. */
export function clusterPanes(tab: BackgroundTab, box: Rect): Map<string, Rect> {
  const raw = new Map<string, Rect>();
  if (tab.tree) {
    for (const [id, r] of computeRects(tab.tree, box)) raw.set(id, r);
  } else if (tab.panes.length > 0) {
    const w = box.width / tab.panes.length;
    const h = Math.min(box.height, w * 0.7);
    const y = box.y + (box.height - h) / 2;
    tab.panes.forEach((id, i) => raw.set(id, { x: box.x + i * w, y, width: w, height: h }));
  }
  const out = new Map<string, Rect>();
  const inset = CLUSTER_GAP_PX / 2;
  for (const [id, r] of raw) {
    out.set(id, {
      x: r.x + inset,
      y: r.y + inset,
      width: Math.max(1, r.width - 2 * inset),
      height: Math.max(1, r.height - 2 * inset),
    });
  }
  return out;
}

/** Clusters for every tab but the active one, in tab order; a tab with no panes has none. */
export function clusterLayout(tabs: readonly BackgroundTab[], activeId: string, area: Rect): ClusterPlacement[] {
  const scale = clusterScale(tabs.length);
  const size = { width: area.width * scale, height: area.height * scale };
  const out: ClusterPlacement[] = [];
  tabs.forEach((tab, i) => {
    if (tab.id === activeId) return;
    const ids = tab.tree ? leaves(tab.tree) : tab.panes;
    if (ids.length === 0) return;
    const rect = clusterHome(i, tabs.length, area, size);
    out.push({ tabId: tab.id, rect, panes: clusterPanes(tab, rect) });
  });
  return out;
}

export function clusterDepth(attention: boolean, status: 'idle' | 'working' | 'waiting' | 'done' | 'failed'): ClusterDepth {
  if (attention || status === 'waiting') return 'forward';
  return status === 'idle' ? 'back' : 'rest';
}

/** FNV-1a, so a tab's drift is the same on every launch and every render. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A closed loop of offsets from a cluster's home, played forever: a Lissajous path across the
 * room the cluster has in the pane area, so clusters float past each other rather than holding
 * their corners. The axis frequencies, phases, and loop length come from the seed, so neighboring
 * clusters take different paths and never move in step.
 */
export function driftPlan(seed: number, home: Rect, area: Rect): TransitionLeg {
  const unit = (shift: number): number => ((seed >>> shift) & 0xff) / 255;
  const fx = 1 + (seed & 1);
  const fy = fx === 1 ? 2 + ((seed >>> 1) & 1) : 3;
  const phaseX = unit(4) * 2 * Math.PI;
  const phaseY = unit(12) * 2 * Math.PI;
  const duration = DRIFT_MIN_MS + Math.round(unit(20) * (DRIFT_MAX_MS - DRIFT_MIN_MS));
  // Room to either side of home that keeps the cluster inside the area.
  const loX = area.x - home.x;
  const hiX = area.x + area.width - (home.x + home.width);
  const loY = area.y - home.y;
  const hiY = area.y + area.height - (home.y + home.height);
  const cx = (loX + hiX) / 2;
  const cy = (loY + hiY) / 2;
  const ax = Math.max(0, ((hiX - loX) / 2) * ROAM);
  const ay = Math.max(0, ((hiY - loY) / 2) * ROAM);
  const steps = 64;
  const keyframes: Keyframe[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = (2 * Math.PI * k) / steps;
    const dx = cx + ax * Math.sin(fx * t + phaseX);
    const dy = cy + ay * Math.sin(fy * t + phaseY);
    keyframes.push({ transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)` });
  }
  return { keyframes, options: { duration, iterations: Infinity, easing: 'linear' } };
}

/**
 * Where in its loop a cluster is at `now`: tied to the clock, so a tab that returns to the
 * background picks its path up where it would have been, and the seed spreads the tabs out.
 */
export function driftTime(seed: number, duration: number, now: number): number {
  return (now + (seed % duration)) % duration;
}

/** The transform that draws an element laid out at `at` over `over`, with its origin at the top left. */
export function rectTransform(at: Rect, over: Rect): string {
  const sx = at.width > 0 ? over.width / at.width : 1;
  const sy = at.height > 0 ? over.height / at.height : 1;
  return `translate(${(over.x - at.x).toFixed(2)}px, ${(over.y - at.y).toFixed(2)}px) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
}

export const RECEDE_MS = 360;
export const RISE_MS = 380;
/** How a pane looks at a cluster's depth: the layer's dimming, roughly. */
const IN_CLUSTER = { opacity: 0.6, filter: 'brightness(0.7) blur(1px)' };

/** An outgoing pane at `rest` shrinking into its spot `target` in its tab's cluster. */
export function recedeLeg(rest: Rect, target: Rect): TransitionLeg {
  return {
    keyframes: [
      { transformOrigin: '0 0', transform: 'none', opacity: 1, filter: 'none' },
      { transformOrigin: '0 0', transform: rectTransform(rest, target), ...IN_CLUSTER },
    ],
    options: { duration: RECEDE_MS, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' },
  };
}

/** An incoming pane rising from its spot `from` in its tab's cluster to `rest`. */
export function riseLeg(from: Rect, rest: Rect): TransitionLeg {
  return {
    keyframes: [
      { transformOrigin: '0 0', transform: rectTransform(rest, from), ...IN_CLUSTER },
      { transformOrigin: '0 0', transform: 'none', opacity: 1, filter: 'none' },
    ],
    options: { duration: RISE_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'backwards' },
  };
}
