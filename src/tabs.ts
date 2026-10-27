// Tab model (docs/design.md section 4.10). Pure data and functions, no DOM.
import { type Layout, replaceLeaf } from './layout';
import type { TerminalStatus } from './terminalStatus';

export interface TabState {
  id: string;
  /** Null follows the focused pane's title. */
  name: string | null;
  tree: Layout | null;
  focusedId: string;
  /** Panes not in `tree`. */
  collapsed: string[];
  /** Every pane id in the tab, in the order opened or moved in. */
  panes: string[];
}

export interface TabsState {
  tabs: TabState[];
  activeId: string;
}

/** Appends the tab and makes it active. */
export function addTab(state: TabsState, tab: TabState): TabsState {
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * Removes a tab. Closing the active tab activates its right neighbor, else its left one.
 * Returns null when the last tab closes (the window closes with it). An unknown id is a no-op.
 */
export function closeTab(state: TabsState, id: string): TabsState | null {
  const index = state.tabs.findIndex((t) => t.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((t) => t.id !== id);
  if (tabs.length === 0) return null;
  if (id !== state.activeId) return { tabs, activeId: state.activeId };
  return { tabs, activeId: tabs[Math.min(index, tabs.length - 1)].id };
}

/** Moves the tab at index `from` to index `to`; the active tab is unchanged. */
export function reorderTab(state: TabsState, from: number, to: number): TabsState {
  const last = state.tabs.length - 1;
  if (from < 0 || from > last || to < 0 || to > last || from === to) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { ...state, tabs };
}

export function switchTab(state: TabsState, id: string): TabsState {
  if (id === state.activeId || !state.tabs.some((t) => t.id === id)) return state;
  return { ...state, activeId: id };
}

/** Activates the tab `delta` places away, wrapping at both ends. */
export function nextTab(state: TabsState, delta: number): TabsState {
  const n = state.tabs.length;
  const index = state.tabs.findIndex((t) => t.id === state.activeId);
  if (n === 0 || index < 0) return state;
  const target = (((index + delta) % n) + n) % n;
  return { ...state, activeId: state.tabs[target].id };
}

/**
 * The tab for Ctrl+Alt+digit: 1-based, with 9 meaning the last tab however many there are.
 * Other digits past the end return null.
 */
export function tabAt(state: TabsState, index1Based: number): TabState | null {
  if (index1Based === 9) return state.tabs[state.tabs.length - 1] ?? null;
  return state.tabs[index1Based - 1] ?? null;
}

export function tabOf(state: TabsState, paneId: string): TabState | null {
  return state.tabs.find((t) => t.panes.includes(paneId)) ?? null;
}

/**
 * Drops a pane from its tab's `panes` and `collapsed`. The caller removes it from the
 * tree, which needs layout rects. A tab left with no panes of any kind closes as in
 * `closeTab`, so this returns null when that was the last tab.
 */
export function removePane(state: TabsState, paneId: string): TabsState | null {
  const tab = tabOf(state, paneId);
  if (!tab) return state;
  const panes = tab.panes.filter((id) => id !== paneId);
  if (panes.length === 0) return closeTab(state, tab.id);
  const updated: TabState = {
    ...tab,
    panes,
    collapsed: tab.collapsed.filter((id) => id !== paneId),
  };
  return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? updated : t)) };
}

/** Records a pane in a tab; `collapsed` says whether it starts outside the tree. */
export function addPane(
  state: TabsState,
  tabId: string,
  paneId: string,
  collapsed: boolean,
): TabsState {
  return {
    ...state,
    tabs: state.tabs.map((t) =>
      t.id !== tabId
        ? t
        : {
            ...t,
            panes: t.panes.includes(paneId) ? t.panes : [...t.panes, paneId],
            collapsed:
              collapsed && !t.collapsed.includes(paneId) ? [...t.collapsed, paneId] : t.collapsed,
          },
    ),
  };
}

/**
 * Swaps `oldId` for `newId` in its tab: the tree leaf, the same place in `panes`, `collapsed`,
 * and focus. An unknown `oldId` is a no-op.
 */
export function replacePane(state: TabsState, oldId: string, newId: string): TabsState {
  const tab = tabOf(state, oldId);
  if (!tab) return state;
  const swap = (id: string) => (id === oldId ? newId : id);
  const updated: TabState = {
    ...tab,
    tree: tab.tree ? replaceLeaf(tab.tree, oldId, newId) : null,
    panes: tab.panes.map(swap),
    collapsed: tab.collapsed.map(swap),
    focusedId: swap(tab.focusedId),
  };
  return { ...state, tabs: state.tabs.map((t) => (t.id === tab.id ? updated : t)) };
}

/** A blank or whitespace-only name returns the tab to following its focused pane. */
export function renameTab(state: TabsState, id: string, name: string): TabsState {
  const trimmed = name.trim();
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id ? { ...t, name: trimmed === '' ? null : trimmed } : t)),
  };
}

export function tabTitle(tab: TabState, focusedTitle: string): string {
  return tab.name ?? focusedTitle;
}

const URGENCY: Record<TerminalStatus, number> = { idle: 0, working: 1, done: 2, waiting: 3 };

/** The most urgent status: waiting, then done, then working, then idle (also for no terminals). */
export function combinedStatus(statuses: TerminalStatus[]): TerminalStatus {
  let best: TerminalStatus = 'idle';
  for (const s of statuses) if (URGENCY[s] > URGENCY[best]) best = s;
  return best;
}
