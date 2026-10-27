// Docking and expand rules over the split tree (docs/design.md sections 4.2, 4.3). Pure, no DOM.
import {
  autoDir,
  close,
  findPath,
  insertAtEdge,
  insertAtRootEdge,
  leaves,
  nodeAt,
  rectAt,
  replaceLeaf,
  swap,
  type CellSize,
  type DockZone,
  type Layout,
  type Rect,
} from './layout';

export type DragSource = { kind: 'pane'; paneId: string } | { kind: 'folder'; path: string };

export type DockResult =
  | { kind: 'ok'; tree: Layout; displaced: string | null }
  | { kind: 'noop' }
  | { kind: 'noRoom' };

export type WindowEdge = Exclude<DockZone, 'center'>;
export type DockTarget = { paneId: string; zone: DockZone } | { windowEdge: WindowEdge };
/** A dock target, or a dashboard group whose tab a pane moves into (docs/design.md section 4.6). */
export type DropTarget = DockTarget | { tabId: string };

/** Width of the drop band along each edge of the pane area (docs/design.md section 4.2). */
export const WINDOW_EDGE_BAND_PX = 24;

const EDGES: DockZone[] = ['left', 'right', 'top', 'bottom'];
const ALL: DockZone[] = [...EDGES, 'center'];

/** A folder opens a new terminal, so it has nothing to swap with; a pane never docks onto itself. */
export function dropZones(source: DragSource, targetPaneId: string): DockZone[] {
  if (source.kind === 'folder') return EDGES;
  return source.paneId === targetPaneId ? [] : ALL;
}

/** The window edge whose band holds the point, or null; a corner picks the nearer edge. */
export function windowEdgeAt(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  band: number = WINDOW_EDGE_BAND_PX,
): WindowEdge | null {
  const dists: [WindowEdge, number][] = [
    ['left', x - rect.left],
    ['right', rect.left + rect.width - x],
    ['top', y - rect.top],
    ['bottom', rect.top + rect.height - y],
  ];
  let best: [WindowEdge, number] | null = null;
  for (const d of dists) {
    if (d[1] < 0 || d[1] > band) continue;
    if (!best || d[1] < best[1]) best = d;
  }
  return best ? best[0] : null;
}

/**
 * Docks `paneId` at `target`. `inTree` says whether it is expanded. A collapsed pane dropped
 * on a center replaces the target, which is returned as `displaced` to be collapsed.
 */
export function applyDock(
  tree: Layout | null,
  paneId: string,
  inTree: boolean,
  target: DockTarget | null,
  container: Rect,
  cell: CellSize,
): DockResult {
  if (!target) {
    return tree ? { kind: 'noop' } : { kind: 'ok', tree: { kind: 'pane', paneId }, displaced: null };
  }
  if (!tree) return { kind: 'noop' };
  if ('windowEdge' in target) {
    const rest = inTree ? close(tree, paneId) : tree;
    if (!rest) return { kind: 'noop' };
    const wrapped = insertAtRootEdge(rest, paneId, target.windowEdge, container, cell);
    return wrapped === rest ? { kind: 'noRoom' } : { kind: 'ok', tree: wrapped, displaced: null };
  }
  if (target.paneId === paneId || !findPath(tree, target.paneId)) return { kind: 'noop' };
  if (target.zone === 'center') {
    if (inTree) return { kind: 'ok', tree: swap(tree, paneId, target.paneId), displaced: null };
    return { kind: 'ok', tree: replaceLeaf(tree, target.paneId, paneId), displaced: target.paneId };
  }
  const base = inTree ? close(tree, paneId) : tree;
  if (!base) return { kind: 'noop' };
  const next = insertAtEdge(base, target.paneId, paneId, target.zone, container, cell);
  return next === base ? { kind: 'noRoom' } : { kind: 'ok', tree: next, displaced: null };
}

/** Splits the focused pane in the auto direction with `paneId` as the second side; null when there is no room. */
export function expandInto(
  tree: Layout | null,
  focusedId: string,
  paneId: string,
  container: Rect,
  cell: CellSize,
): Layout | null {
  if (!tree) return { kind: 'pane', paneId };
  const path = findPath(tree, focusedId);
  const rect = path ? rectAt(tree, path, container) : null;
  if (!rect) return null;
  const edge = autoDir(rect) === 'row' ? 'right' : 'bottom';
  const next = insertAtEdge(tree, focusedId, paneId, edge, container, cell);
  return next === tree ? null : next;
}

/** Which pane should hold focus once `id` leaves the tree: its sibling's first leaf if it was focused. */
export function focusAfterRemoval(tree: Layout, id: string, focusedId: string): string {
  if (id !== focusedId) return focusedId;
  const path = findPath(tree, id);
  if (!path || path.length === 0) return '';
  const siblingStep = path[path.length - 1] === 'a' ? 'b' : 'a';
  const sibling = nodeAt(tree, [...path.slice(0, -1), siblingStep]);
  return sibling ? leaves(sibling)[0] : '';
}
