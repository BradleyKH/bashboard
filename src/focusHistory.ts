/**
 * Most-recent-first pane ids. Every function returns a new array so callers can keep the
 * previous value for comparison.
 */

export function touch(history: readonly string[], id: string): string[] {
  return [id, ...history.filter((h) => h !== id)];
}

export function forget(history: readonly string[], id: string): string[] {
  return history.filter((h) => h !== id);
}

/**
 * The most recently focused terminal in a tab: the first id in `history` that belongs to the
 * tab and is a terminal, else the tab's first terminal in pane order, else null.
 */
export function recentTerminal(
  history: readonly string[],
  tabPaneIds: readonly string[],
  isTerminal: (id: string) => boolean,
): string | null {
  const inTab = new Set(tabPaneIds);
  const recent = history.find((id) => inTab.has(id) && isTerminal(id));
  if (recent !== undefined) return recent;
  return tabPaneIds.find((id) => isTerminal(id)) ?? null;
}
