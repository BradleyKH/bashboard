// Binary split-tree pane layout (docs/design.md section 4.2). Pure data and functions, no DOM.

export type Layout =
  | { kind: 'pane'; paneId: string }
  | { kind: 'split'; dir: 'row' | 'column'; ratio: number; a: Layout; b: Layout };

export type Split = Extract<Layout, { kind: 'split' }>;
export type Dir = Split['dir'];
export type Path = ('a' | 'b')[];
export type Rect = { x: number; y: number; width: number; height: number };
/** One character cell in px; `padX` / `padY` are px of per-pane chrome the grid cannot use. */
export type CellSize = { width: number; height: number; padX?: number; padY?: number };
export type Axis = 'x' | 'y';
export type Direction = 'left' | 'right' | 'up' | 'down';
export type Divider = { path: Path; dir: Dir; rect: Rect };

export const DIVIDER_PX = 4;
export const MIN_COLS = 20;
export const MIN_ROWS = 5;

const EPS = 0.5;

/** `row` splits along x (side by side), `column` along y (stacked). */
function axisOf(dir: Dir): Axis {
  return dir === 'row' ? 'x' : 'y';
}

function extent(rect: Rect, axis: Axis): number {
  return axis === 'x' ? rect.width : rect.height;
}

/** Child rects and divider rect of a split occupying `rect`. */
function splitRects(node: Split, rect: Rect): { a: Rect; b: Rect; divider: Rect } {
  if (node.dir === 'row') {
    const avail = Math.max(0, rect.width - DIVIDER_PX);
    const aw = avail * node.ratio;
    return {
      a: { x: rect.x, y: rect.y, width: aw, height: rect.height },
      divider: { x: rect.x + aw, y: rect.y, width: DIVIDER_PX, height: rect.height },
      b: { x: rect.x + aw + DIVIDER_PX, y: rect.y, width: avail - aw, height: rect.height },
    };
  }
  const avail = Math.max(0, rect.height - DIVIDER_PX);
  const ah = avail * node.ratio;
  return {
    a: { x: rect.x, y: rect.y, width: rect.width, height: ah },
    divider: { x: rect.x, y: rect.y + ah, width: rect.width, height: DIVIDER_PX },
    b: { x: rect.x, y: rect.y + ah + DIVIDER_PX, width: rect.width, height: avail - ah },
  };
}

export function computeRects(tree: Layout, container: Rect): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (node: Layout, rect: Rect): void => {
    if (node.kind === 'pane') {
      out.set(node.paneId, rect);
      return;
    }
    const r = splitRects(node, rect);
    walk(node.a, r.a);
    walk(node.b, r.b);
  };
  walk(tree, container);
  return out;
}

export function computeDividers(tree: Layout, container: Rect): Divider[] {
  const out: Divider[] = [];
  const walk = (node: Layout, rect: Rect, path: Path): void => {
    if (node.kind === 'pane') return;
    const r = splitRects(node, rect);
    out.push({ path, dir: node.dir, rect: r.divider });
    walk(node.a, r.a, [...path, 'a']);
    walk(node.b, r.b, [...path, 'b']);
  };
  walk(tree, container, []);
  return out;
}

export function leaves(tree: Layout): string[] {
  return tree.kind === 'pane' ? [tree.paneId] : [...leaves(tree.a), ...leaves(tree.b)];
}

export function findPath(tree: Layout, paneId: string): Path | null {
  if (tree.kind === 'pane') return tree.paneId === paneId ? [] : null;
  const a = findPath(tree.a, paneId);
  if (a) return ['a', ...a];
  const b = findPath(tree.b, paneId);
  return b ? ['b', ...b] : null;
}

export function nodeAt(tree: Layout, path: Path): Layout | null {
  let node: Layout = tree;
  for (const step of path) {
    if (node.kind !== 'split') return null;
    node = node[step];
  }
  return node;
}

/** Rect of the subtree at `path`. */
export function rectAt(tree: Layout, path: Path, container: Rect): Rect | null {
  let node: Layout = tree;
  let rect = container;
  for (const step of path) {
    if (node.kind !== 'split') return null;
    rect = splitRects(node, rect)[step];
    node = node[step];
  }
  return rect;
}

/** Returns a copy of `tree` with the node at `path` replaced. */
function replaceAt(tree: Layout, path: Path, replacement: Layout): Layout {
  if (path.length === 0) return replacement;
  if (tree.kind !== 'split') return tree;
  const [step, ...rest] = path;
  return { ...tree, [step]: replaceAt(tree[step], rest, replacement) };
}

/** Minimum px the subtree needs along `axis`, ignoring its ratios. */
export function minExtent(node: Layout, axis: Axis, cell: CellSize): number {
  if (node.kind === 'pane') {
    return axis === 'x'
      ? MIN_COLS * cell.width + (cell.padX ?? 0)
      : MIN_ROWS * cell.height + (cell.padY ?? 0);
  }
  const a = minExtent(node.a, axis, cell);
  const b = minExtent(node.b, axis, cell);
  return axisOf(node.dir) === axis ? a + b + DIVIDER_PX : Math.max(a, b);
}

// Ratios are relative, so a nested same-axis split with an uneven ratio needs more than the
// plain sum to keep its smaller side at the minimum. Clamping uses this to avoid squeezing it.
function requiredExtent(node: Layout, axis: Axis, cell: CellSize): number {
  if (node.kind === 'pane') return minExtent(node, axis, cell);
  const a = requiredExtent(node.a, axis, cell);
  const b = requiredExtent(node.b, axis, cell);
  if (axisOf(node.dir) !== axis) return Math.max(a, b);
  const r = Math.min(Math.max(node.ratio, 1e-6), 1 - 1e-6);
  return DIVIDER_PX + Math.max(a / r, b / (1 - r));
}

export function autoDir(rect: Rect): Dir {
  return rect.width > rect.height ? 'row' : 'column';
}

export function split(
  tree: Layout,
  paneId: string,
  newPaneId: string,
  dir: Dir,
  container: Rect,
  cell: CellSize,
): Layout {
  const path = findPath(tree, paneId);
  if (!path) return tree;
  const rect = rectAt(tree, path, container);
  if (!rect) return tree;
  const axis = axisOf(dir);
  const leaf: Layout = { kind: 'pane', paneId };
  const half = (extent(rect, axis) - DIVIDER_PX) / 2;
  if (half < minExtent(leaf, axis, cell)) return tree;
  return replaceAt(tree, path, {
    kind: 'split',
    dir,
    ratio: 0.5,
    a: leaf,
    b: { kind: 'pane', paneId: newPaneId },
  });
}

export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** Wraps `targetId` in a 0.5 split with `newId` on `edge`; `tree` itself when a half is too small. */
export function insertAtEdge(
  tree: Layout,
  targetId: string,
  newId: string,
  edge: Exclude<DockZone, 'center'>,
  container: Rect,
  cell: CellSize,
): Layout {
  const path = findPath(tree, targetId);
  if (!path) return tree;
  const rect = rectAt(tree, path, container);
  if (!rect) return tree;
  const dir: Dir = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const axis = axisOf(dir);
  const target: Layout = { kind: 'pane', paneId: targetId };
  const half = (extent(rect, axis) - DIVIDER_PX) / 2;
  if (half < minExtent(target, axis, cell)) return tree;
  const added: Layout = { kind: 'pane', paneId: newId };
  const first = edge === 'left' || edge === 'top';
  return replaceAt(tree, path, {
    kind: 'split',
    dir,
    ratio: 0.5,
    a: first ? added : target,
    b: first ? target : added,
  });
}

/**
 * Wraps the whole tree in a split along `edge`'s axis with `newId` on that side, taking a third
 * of `container` or its minimum size if larger; `tree` itself when the rest would fall below its
 * minimum (or the container is too thin across for the new leaf).
 */
export function insertAtRootEdge(
  tree: Layout,
  newId: string,
  edge: Exclude<DockZone, 'center'>,
  container: Rect,
  cell: CellSize,
): Layout {
  const dir: Dir = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const axis = axisOf(dir);
  const cross: Axis = axis === 'x' ? 'y' : 'x';
  const added: Layout = { kind: 'pane', paneId: newId };
  if (extent(container, cross) < minExtent(added, cross, cell)) return tree;
  const avail = extent(container, axis) - DIVIDER_PX;
  const share = Math.max(avail / 3, minExtent(added, axis, cell));
  if (avail - share < requiredExtent(tree, axis, cell)) return tree;
  const first = edge === 'left' || edge === 'top';
  return {
    kind: 'split',
    dir,
    ratio: first ? share / avail : 1 - share / avail,
    a: first ? added : tree,
    b: first ? tree : added,
  };
}

/** Exchanges the positions of two leaves. */
export function swap(tree: Layout, idA: string, idB: string): Layout {
  if (idA === idB || !findPath(tree, idA) || !findPath(tree, idB)) return tree;
  const walk = (node: Layout): Layout => {
    if (node.kind === 'pane') {
      if (node.paneId === idA) return { kind: 'pane', paneId: idB };
      if (node.paneId === idB) return { kind: 'pane', paneId: idA };
      return node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(tree);
}

/** Puts `newId` where `oldId` sits, for a pane that is not in the tree. */
export function replaceLeaf(tree: Layout, oldId: string, newId: string): Layout {
  const path = findPath(tree, oldId);
  if (!path) return tree;
  return replaceAt(tree, path, { kind: 'pane', paneId: newId });
}

/** The middle 50% box (by width and height) is `center`; anything else is the nearest edge. */
export function dockZoneAt(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): DockZone {
  const fx = rect.width > 0 ? (x - rect.left) / rect.width : 0.5;
  const fy = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;
  if (fx >= 0.25 && fx <= 0.75 && fy >= 0.25 && fy <= 0.75) return 'center';
  const dists: [DockZone, number][] = [
    ['left', fx],
    ['right', 1 - fx],
    ['top', fy],
    ['bottom', 1 - fy],
  ];
  let best = dists[0];
  for (const d of dists) if (d[1] < best[1]) best = d;
  return best[0];
}

export function close(tree: Layout, paneId: string): Layout | null {
  const path = findPath(tree, paneId);
  if (!path) return tree;
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const parent = nodeAt(tree, parentPath) as Split;
  const sibling = path[path.length - 1] === 'a' ? parent.b : parent.a;
  return replaceAt(tree, parentPath, sibling);
}

export function clampRatio(
  tree: Layout,
  path: Path,
  ratio: number,
  container: Rect,
  cell: CellSize,
): number {
  const node = nodeAt(tree, path);
  const rect = rectAt(tree, path, container);
  if (!node || node.kind !== 'split' || !rect) return ratio;
  const axis = axisOf(node.dir);
  const avail = extent(rect, axis) - DIVIDER_PX;
  const minA = requiredExtent(node.a, axis, cell);
  const minB = requiredExtent(node.b, axis, cell);
  if (avail <= 0 || minA + minB > avail) return minA / (minA + minB);
  const lo = minA / avail;
  const hi = 1 - minB / avail;
  return Math.min(Math.max(ratio, lo), hi);
}

export function setRatio(tree: Layout, path: Path, ratio: number): Layout {
  const node = nodeAt(tree, path);
  if (!node || node.kind !== 'split') return tree;
  return replaceAt(tree, path, { ...node, ratio });
}

export function resizePane(
  tree: Layout,
  paneId: string,
  direction: Direction,
  container: Rect,
  cell: CellSize,
  step = 0.05,
): Layout {
  const path = findPath(tree, paneId);
  if (!path) return tree;
  const want: Dir = direction === 'left' || direction === 'right' ? 'row' : 'column';
  const delta = direction === 'right' || direction === 'down' ? step : -step;
  for (let depth = path.length - 1; depth >= 0; depth--) {
    const splitPath = path.slice(0, depth);
    const node = nodeAt(tree, splitPath) as Split;
    if (node.dir !== want) continue;
    const next = clampRatio(tree, splitPath, node.ratio + delta, container, cell);
    if (Math.abs(next - node.ratio) < 1e-9) return tree;
    return setRatio(tree, splitPath, next);
  }
  return tree;
}

export function neighbor(
  tree: Layout,
  paneId: string,
  direction: Direction,
  container: Rect,
): string | null {
  const rects = computeRects(tree, container);
  const f = rects.get(paneId);
  if (!f) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const fCenter = { x: f.x + f.width / 2, y: f.y + f.height / 2 };

  let best: { id: string; gap: number; overlap: number; dist: number } | null = null;
  for (const [id, r] of rects) {
    if (id === paneId) continue;
    let gap: number;
    switch (direction) {
      case 'right': gap = r.x - (f.x + f.width); break;
      case 'left': gap = f.x - (r.x + r.width); break;
      case 'down': gap = r.y - (f.y + f.height); break;
      case 'up': gap = f.y - (r.y + r.height); break;
    }
    if (gap < -EPS) continue;
    const overlap = horizontal
      ? Math.min(f.y + f.height, r.y + r.height) - Math.max(f.y, r.y)
      : Math.min(f.x + f.width, r.x + r.width) - Math.max(f.x, r.x);
    if (overlap <= EPS) continue;
    const dist = Math.hypot(r.x + r.width / 2 - fCenter.x, r.y + r.height / 2 - fCenter.y);
    // Adjacent panes beat farther ones even with less overlap, so a full-height pane two
    // columns away never wins over a half-height pane right next to the focused one.
    const better =
      !best ||
      gap < best.gap - EPS ||
      (Math.abs(gap - best.gap) <= EPS &&
        (overlap > best.overlap + EPS || (Math.abs(overlap - best.overlap) <= EPS && dist < best.dist)));
    if (better) best = { id, gap, overlap, dist };
  }
  return best ? best.id : null;
}
