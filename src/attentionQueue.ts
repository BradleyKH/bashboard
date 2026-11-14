// Ctrl+Shift+N's walk order over the Needs you list (docs/design/dashboard.md section 4.28). Pure.

/** Where the walk stands: the stable key it is on, and that key's index when it was walked to. */
export interface WalkPosition {
  key: string;
  index: number;
}

/**
 * The index of the next row after `at` in `keys` (stable keys in walk order), wrapping; the first
 * row when there is no position. A walked-to row often leaves the list on arrival (a done terminal
 * clears once seen), so a position whose key is gone resumes at its old index, which now holds the
 * row that followed it. Null when the list is empty.
 */
export function nextInWalk(keys: readonly string[], at: WalkPosition | null): number | null {
  if (keys.length === 0) return null;
  if (at === null) return 0;
  const i = keys.indexOf(at.key);
  if (i >= 0) return (i + 1) % keys.length;
  return at.index >= 0 && at.index < keys.length ? at.index : 0;
}

/**
 * The fallback with nothing in the walk: the agent terminal after `focusedId` in `ring` (reading
 * order), wrapping, or the first when the focused pane is not one; null when there are none.
 */
export function nextAgent(ring: readonly string[], focusedId: string): string | null {
  if (ring.length === 0) return null;
  const at = ring.indexOf(focusedId);
  return at < 0 ? ring[0] : ring[(at + 1) % ring.length];
}
