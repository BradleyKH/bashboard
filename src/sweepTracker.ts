import type { PtyActivity } from './persistence';
import type { SweepState } from './terminalStatus';

/**
 * Folds one activity sweep into the per-pty state (docs/design.md section 4.8). `changedAt`
 * moves only when `busy` flips; ptys missing from the sweep are dropped.
 */
export function applyActivity(
  prev: ReadonlyMap<number, SweepState>,
  list: PtyActivity[],
  now: number,
): { next: Map<number, SweepState>; changed: boolean } {
  const next = new Map<number, SweepState>();
  let changed = false;
  for (const { id, busy } of list) {
    const old = prev.get(id);
    if (old && old.busy === busy) {
      next.set(id, old);
    } else {
      next.set(id, { busy, changedAt: now });
      changed = true;
    }
  }
  for (const id of prev.keys()) if (!next.has(id)) changed = true;
  return { next, changed };
}
