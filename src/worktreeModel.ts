import type { PaneCardInput } from './dashboardModel';
import { samePath } from './favorites';
import type { Session } from './sessions';
import type { MergedState, Worktree, WorktreeDetail } from './worktreeApi';

/** Pure text and matching rules for the Repo section's worktree list (docs/design.md section 4.6). */

export type WorktreeBadge = 'Merged' | 'Probably merged' | 'Locked' | 'Prunable';

/** The main worktree never shows a merged badge; it falls through to the rest. */
export function worktreeBadge(w: Worktree): WorktreeBadge | null {
  if (!w.main) {
    if (w.merged === 'merged') return 'Merged';
    if (w.merged === 'probablyMerged') return 'Probably merged';
  }
  if (w.locked) return 'Locked';
  if (w.prunable) return 'Prunable';
  return null;
}

export function countsText(ahead: number, behind: number): string {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`${ahead} ahead`);
  if (behind > 0) parts.push(`${behind} behind`);
  return parts.join(', ');
}

export function mergedText(
  state: MergedState,
  comparison: string | null,
  upstream: string | null,
): string {
  switch (state) {
    case 'merged':
      return `Merged: every commit is in ${comparison ?? 'the primary branch'}`;
    case 'probablyMerged':
      return `Probably merged: ${upstream ?? 'its upstream'} was deleted on the remote`;
    case 'notMerged':
      return 'Not merged';
    default:
      return 'No primary branch to compare with';
  }
}

export function upstreamText(
  d: Pick<WorktreeDetail, 'upstream' | 'upstreamGone' | 'upstreamAhead' | 'upstreamBehind'>,
): string {
  if (d.upstreamGone) return 'Upstream deleted on the remote';
  if (!d.upstream) return 'No upstream';
  const counts = countsText(d.upstreamAhead, d.upstreamBehind);
  return counts ? `${d.upstream} ${counts}` : d.upstream;
}

export function workingTreeText(
  d: Pick<WorktreeDetail, 'staged' | 'changed' | 'untracked'>,
): string {
  const parts: string[] = [];
  if (d.staged > 0) parts.push(`${d.staged} staged`);
  if (d.changed > 0) parts.push(`${d.changed} changed`);
  if (d.untracked > 0) parts.push(`${d.untracked} untracked`);
  return parts.length === 0 ? 'Clean' : parts.join(', ');
}

function normalized(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** `path` equals or sits inside `folder`, ignoring case, slash style, and trailing separators. */
export function sameOrInside(path: string, folder: string): boolean {
  const p = normalized(path);
  const f = normalized(folder);
  return p === f || p.startsWith(f + '/');
}

/** The worktree containing `folder`; the longest matching path wins since linked worktrees may sit inside the main one. */
export function worktreeOf(folder: string, worktrees: Worktree[]): Worktree | null {
  let best: Worktree | null = null;
  for (const w of worktrees) {
    if (!sameOrInside(folder, w.path)) continue;
    if (!best || normalized(w.path).length > normalized(best.path).length) best = w;
  }
  return best;
}

function lastFolder(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** A sentence saying why the worktree cannot be deleted right now, or null. */
export function removalBlockers(
  path: string,
  panes: PaneCardInput[],
  external: Session[],
): string | null {
  const names: string[] = [];
  for (const p of panes) {
    if (p.kind === 'terminal') {
      if (p.cwd && sameOrInside(p.cwd, path)) names.push(`terminal in ${lastFolder(p.cwd)}`);
    } else {
      const folder = p.root ?? p.folder;
      if (folder && sameOrInside(folder, path)) names.push(p.title);
    }
  }
  if (names.length > 0) return `Close these panes first: ${names.join(', ')}`;
  if (external.some((s) => s.cwd && sameOrInside(s.cwd, path))) {
    return 'An external Claude session is working in this folder';
  }
  return null;
}

export interface DeleteBranchChoice {
  show: boolean;
  checked: boolean;
  enabled: boolean;
  note?: string;
}

export function deleteBranchChoice(w: Worktree): DeleteBranchChoice {
  if (!w.branch) return { show: false, checked: false, enabled: false };
  if (w.merged === 'merged') return { show: true, checked: true, enabled: true };
  if (w.merged === 'probablyMerged') {
    return {
      show: true,
      checked: false,
      enabled: false,
      note: 'Squash-merged branches need `git branch -D` in a terminal',
    };
  }
  return { show: true, checked: false, enabled: false };
}

/** Whether a `git://changed` root is one of the listed worktrees. */
export function isRepoRoot(root: string, worktrees: Worktree[]): boolean {
  return worktrees.some((w) => samePath(w.path, root));
}
