import { ContainersPane } from './containersPane';
import { expandInto } from './docking';
import { samePath } from './favorites';
import { FilesPane } from './filesPane';
import { routeFilesRequest, type FilesRequest } from './filesRouting';
import { routeGitRequest } from './gitModel';
import { GitPane } from './gitPane';
import { computeRects, type CellSize, type Rect } from './layout';
import type { PaneKind } from './paneKinds';
import type { PaneView } from './paneView';
import { PortsPane } from './portsPane';
import type { SavedPane, SavedTab } from './savedWorkspace';
import type { ShipTab } from './shipModel';
import { ShipPane } from './shipPane';
import type { TabState } from './tabs';
import type { TabStore } from './tabStore';
import type { LaunchTarget, OpenPaneOptions, PaneSpec } from './workspaceTypes';

/** What routing reads of the workspace and the ways it can show or open a pane. */
export interface PaneRoutingContext {
  readonly store: TabStore;
  readonly paneViews: ReadonlyMap<string, PaneView>;
  readonly root: HTMLElement;
  layoutCell(): CellSize | null;
  paneRects(): Map<string, DOMRect>;
  containerRect(): Rect;
  focusPane(id: string): void;
  expandPane(id: string): void;
  openPane(spec: PaneSpec, opts?: OpenPaneOptions): void;
  openLayout(saved: SavedTab, name: string): void;
}

// Requests for a pane of a kind, sent to an existing pane when one fits and opened otherwise
// (docs/design/workspace.md section 4.11). Every function takes the workspace's routing context.

/** Stands in for the launched pane's id while previewing; never mounted. */
const LAUNCH_PREVIEW_ID = '__launch-preview';

function filesPanes(ctx: PaneRoutingContext): { paneId: string; root: string; folder: string }[] {
  return ctx.store.active.panes.flatMap((id) => {
    const pane = ctx.paneViews.get(id);
    return pane instanceof FilesPane ? [{ paneId: id, root: pane.root(), folder: pane.folder }] : [];
  });
}

function gitPanes(ctx: PaneRoutingContext): { paneId: string; root: string }[] {
  return ctx.store.active.panes.flatMap((id) => {
    const pane = ctx.paneViews.get(id);
    return pane instanceof GitPane ? [{ paneId: id, root: pane.root() }] : [];
  });
}

/** Focuses the pane, expanding it first when it is collapsed. */
function show(ctx: PaneRoutingContext, id: string): void {
  if (ctx.store.isCollapsed(id)) ctx.expandPane(id);
  else ctx.focusPane(id);
}

/**
 * Design 4.6 Launch: where launching `kind` at `root` would land, in window coordinates, for the
 * preview. Files and Git reuse the tab's pane for the repo, as `showFiles` and `showGit` do.
 * Null when there is nothing on screen to show, such as a reused pane that is collapsed.
 */
export function launchTarget(ctx: PaneRoutingContext, kind: PaneKind, root: string): LaunchTarget | null {
  const origin = ctx.root.getBoundingClientRect();
  const toWindow = (r: Rect): Rect => ({ x: r.x + origin.x, y: r.y + origin.y, width: r.width, height: r.height });
  const reuse =
    kind === 'files'
      ? routeFilesRequest(filesPanes(ctx), { root, folder: root })
      : kind === 'git'
        ? routeGitRequest(gitPanes(ctx), root)
        : null;
  if (reuse && 'reuse' in reuse) {
    if (ctx.store.isCollapsed(reuse.reuse)) return null;
    const rect = ctx.paneRects().get(reuse.reuse);
    return rect ? { kind: 'reuse', pane: rect } : null;
  }
  const tree = ctx.store.tree;
  if (!tree) return { kind: 'fill', area: origin };
  const cell = ctx.layoutCell();
  const focused = ctx.paneRects().get(ctx.store.focusedId);
  if (!cell || !focused) return null;
  const container = ctx.containerRect();
  const next = expandInto(tree, ctx.store.focusedId, LAUNCH_PREVIEW_ID, container, cell);
  if (!next) return { kind: 'collapsed', pane: focused };
  const rects = computeRects(next, container);
  const added = rects.get(LAUNCH_PREVIEW_ID);
  const kept = rects.get(ctx.store.focusedId);
  if (!added || !kept) return null;
  return { kind: 'split', pane: focused, kept: toWindow(kept), added: toWindow(added) };
}

/**
 * Design 4.12: shows the folder in the active tab's Files pane for that repo, or opens one as
 * a split of the focused pane.
 */
export function showFiles(ctx: PaneRoutingContext, req: FilesRequest, opts: OpenPaneOptions): void {
  const route = routeFilesRequest(filesPanes(ctx), req);
  // A pane asked for in a new tab is a new pane, whatever the current tab holds.
  if ('reuse' in route && !opts.tab) {
    const pane = ctx.paneViews.get(route.reuse) as FilesPane;
    show(ctx, route.reuse);
    void pane.showFolder(req.folder, req.select);
    return;
  }
  ctx.openPane({ kind: 'files', folder: req.folder, selected: req.select ?? null, root: req.root }, opts);
}

/**
 * Design 4.13: focuses the active tab's Git pane for that repo, or opens one as a split of the
 * focused pane.
 */
export function showGit(ctx: PaneRoutingContext, root: string, opts: OpenPaneOptions): void {
  const route = routeGitRequest(gitPanes(ctx), root);
  if ('reuse' in route && !opts.tab) {
    show(ctx, route.reuse);
    return;
  }
  ctx.openPane({ kind: 'git', root }, opts);
}

/**
 * Shows the first pane in tab order that `matches`, expanding it if collapsed, or appends a tab
 * named `name` holding one `pane`. Returns the pane's id, or undefined if none could be shown.
 */
function showOrAppendTab(
  ctx: PaneRoutingContext,
  matches: (view: PaneView | undefined) => boolean,
  name: string,
  pane: SavedPane,
): string | undefined {
  const find = (tabs: TabState[]) => tabs.flatMap((t) => t.panes).find((id) => matches(ctx.paneViews.get(id)));
  const id = find(ctx.store.state.tabs);
  if (id) {
    show(ctx, id);
    return id;
  }
  ctx.openLayout({ name, panes: [pane], layout: { kind: 'pane', paneId: pane.key }, focused: pane.key }, name);
  return find([ctx.store.active]);
}

/**
 * Design 4.16: shows the first Containers pane in tab order, or appends a Containers tab, then
 * expands the groups with those `ContainerGroup` keys.
 */
export function openContainers(ctx: PaneRoutingContext, groupKeys: string[]): void {
  const id = showOrAppendTab(ctx, (v) => v instanceof ContainersPane, 'Containers', {
    key: 'c',
    kind: 'containers',
    collapsed: false,
  });
  const pane = id ? ctx.paneViews.get(id) : undefined;
  if (pane instanceof ContainersPane) for (const key of groupKeys) pane.expandGroup(key);
}

/**
 * Design 4.20: shows a Ship pane already drilled into `target` (a repo root or
 * `remote:<repo>`), else the first Ship pane in tab order drilled into it, else appends a
 * Ship tab on it. A null target shows the first Ship pane as it is, or a new one on the
 * Overview.
 */
export function openShip(ctx: PaneRoutingContext, target: string | null, tab?: ShipTab): void {
  // samePath because a pane rewrites a folder inside the repo to the repo's root.
  const drilledTo = (v: PaneView | undefined) => {
    const root = v instanceof ShipPane ? v.root() : null;
    return target !== null && root !== null && samePath(root, target);
  };
  const anyShip = (v: PaneView | undefined) => v instanceof ShipPane;
  const matches = [...ctx.paneViews.values()].some(drilledTo) ? drilledTo : anyShip;
  const id = showOrAppendTab(ctx, matches, 'Ship', {
    key: 'f',
    kind: 'ship',
    ...(target !== null && { root: target }),
    ...(tab !== undefined && { tab }),
    collapsed: false,
  });
  const pane = id ? ctx.paneViews.get(id) : undefined;
  // A null target means the Overview, so an existing pane drilled into a repo backs out to it.
  if (pane instanceof ShipPane) pane.drill(target, tab);
}

/**
 * Design 4.19: shows the first Ports pane in tab order, or appends a Ports tab, then selects
 * the row with that `listenerKey`, or, with `showAll`, clears its Started from a pane filter.
 */
export function openPorts(ctx: PaneRoutingContext, key: string | undefined, showAll: boolean): void {
  const id = showOrAppendTab(ctx, (v) => v instanceof PortsPane, 'Ports', {
    key: 'p',
    kind: 'ports',
    collapsed: false,
  });
  const pane = id ? ctx.paneViews.get(id) : undefined;
  if (!(pane instanceof PortsPane)) return;
  if (showAll) pane.showAll();
  if (key !== undefined) pane.highlight(key);
}

/**
 * Design 4.21: a Local Browser pane on `url` (null for its start page), split beside `fromPaneId`
 * or the focused pane; `tab` opens it alone in a new tab, `collapsed` opens it collapsed.
 */
export function openLocalBrowser(
  ctx: PaneRoutingContext,
  url: string | null,
  opts: { tab?: boolean; collapsed?: boolean; fromPaneId?: string },
): void {
  const { fromPaneId, ...place } = opts;
  if (fromPaneId && !place.tab && !ctx.store.isCollapsed(fromPaneId) && ctx.paneViews.has(fromPaneId)) {
    ctx.focusPane(fromPaneId);
  }
  ctx.openPane({ kind: 'browser', url }, place);
}
