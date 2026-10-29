/** A keyboard move within the dashboard's rows (docs/design.md section 4.6). */
export type NavMove = 'next' | 'prev' | 'first' | 'last';

/**
 * The row index a move lands on, clamped rather than wrapping, as list boxes do. With no current
 * row (-1), `next` starts at the top and `prev` at the bottom. Returns -1 for an empty list.
 */
export function stepIndex(count: number, current: number, move: NavMove): number {
  if (count === 0) return -1;
  switch (move) {
    case 'first':
      return 0;
    case 'last':
      return count - 1;
    case 'next':
      return current < 0 ? 0 : Math.min(current + 1, count - 1);
    case 'prev':
      return current < 0 ? count - 1 : Math.max(current - 1, 0);
  }
}

/**
 * The row to refocus after the dashboard rebuilds its rows: the one with the same key, or, when it
 * is gone (its pane closed), whatever now sits at its old position. Returns -1 for an empty list.
 */
export function restoreIndex(keys: string[], key: string, oldIndex: number): number {
  if (keys.length === 0) return -1;
  const same = keys.indexOf(key);
  if (same >= 0) return same;
  return Math.min(Math.max(oldIndex, 0), keys.length - 1);
}
