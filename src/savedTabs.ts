// Converts between live tabs and their saved shape (docs/design.md sections 4.9 and 7). Pure, no DOM.
import type { DashboardSection } from './dashboardSections';
import { leaves } from './layout';
import { pruneLayout, remapLayout, type SavedPane, type SavedTab, type SavedWorkspace } from './savedWorkspace';
import type { TabState, TabsState } from './tabs';

export interface RestoredTab {
  tab: TabState;
  /** Saved pane key to new pane id. */
  ids: Map<string, string>;
}

/**
 * Rebuilds a saved tab around new pane ids, keeping its order, collapsed panes, and focus.
 * `takeId` sees the pane, since ids differ by kind.
 */
export function restoredTab(
  saved: SavedTab,
  tabId: string,
  name: string | null,
  takeId: (pane: SavedPane) => string,
): RestoredTab {
  const ids = new Map<string, string>();
  for (const p of saved.panes) ids.set(p.key, takeId(p));
  const tree = saved.layout ? remapLayout(saved.layout, ids) : null;
  const focused = saved.focused ? ids.get(saved.focused) : undefined;
  return {
    ids,
    tab: {
      id: tabId,
      name,
      tree,
      focusedId: tree ? (focused ?? leaves(tree)[0]) : '',
      collapsed: saved.panes.filter((p) => p.collapsed).map((p) => ids.get(p.key)!),
      panes: saved.panes.map((p) => ids.get(p.key)!),
    },
  };
}

/**
 * Pane ids double as saved keys, since they are unique across tabs and kinds. `pane` returns
 * null for a pane that no longer exists or is not saved (a container shell); tabs left with no panes are dropped.
 */
export function snapshotTabs(
  state: TabsState,
  pane: (paneId: string, collapsed: boolean) => SavedPane | null,
  collapsedSections: DashboardSection[] = [],
): SavedWorkspace {
  const tabs: SavedTab[] = [];
  let activeTab = 0;
  for (const tab of state.tabs) {
    const panes = tab.panes
      .map((id) => pane(id, tab.collapsed.includes(id)))
      .filter((p): p is SavedPane => p !== null);
    if (panes.length === 0) continue;
    if (tab.id === state.activeId) activeTab = tabs.length;
    // A pane the callback skipped (a container shell) must leave no leaf in the saved layout.
    const layout = tab.tree ? pruneLayout(tab.tree, new Set(panes.map((p) => p.key))) : null;
    const focused = tab.focusedId && layout && leaves(layout).includes(tab.focusedId) ? tab.focusedId : null;
    tabs.push({ name: tab.name, panes, layout, focused: focused ?? (layout ? leaves(layout)[0] : null) });
  }
  return { version: 3, tabs, activeTab, collapsedSections: [...collapsedSections] };
}
