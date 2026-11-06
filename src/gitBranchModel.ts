/** Pure helpers behind the Git pane's Branches tab and branch switcher (docs/design/git.md section 4.13); no DOM. */

import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from './gitApi';

export type GitTab = 'changes' | 'branches';

/**
 * Why `name` cannot be a branch, or null when it can. Mirrors `git check-ref-format --branch`
 * for live feedback; the core runs the real check before git sees the name.
 */
export function branchNameError(name: string): string | null {
  if (name === '') return 'Enter a name';
  if (name.startsWith('-')) return 'A branch name cannot start with -';
  if (name === '@') return 'A branch name cannot be @';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return 'A branch name cannot hold spaces or ~ ^ : ? * [ \\';
  if (name.includes('..')) return 'A branch name cannot hold ..';
  if (name.includes('@{')) return 'A branch name cannot hold @{';
  if (name.includes('//')) return 'A branch name cannot hold //';
  if (name.endsWith('/') || name.endsWith('.')) return 'A branch name cannot end with / or .';
  if (name.startsWith('/')) return 'A branch name cannot start with /';
  for (const part of name.split('/')) {
    if (part.startsWith('.')) return 'No part of a branch name can start with .';
    if (part.endsWith('.lock')) return 'No part of a branch name can end with .lock';
  }
  return null;
}

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

/** Both lists narrowed to names containing the query, ignoring case. */
export function filterBranches(list: GitBranchList, query: string): GitBranchList {
  const q = query.trim();
  if (q === '') return list;
  return {
    local: list.local.filter((b) => matches(b.name, q)),
    remote: list.remote.filter((b) => matches(b.name, q)),
  };
}

/** The upstream state beside a local branch: `↑2 ↓1`, `gone`, or empty when up to date or untracked. */
export function trackText(b: GitLocalBranch): string {
  if (b.gone) return 'gone';
  const parts: string[] = [];
  if (b.ahead > 0) parts.push(`↑${b.ahead}`);
  if (b.behind > 0) parts.push(`↓${b.behind}`);
  return parts.join(' ');
}

export function trackTitle(b: GitLocalBranch): string {
  if (b.upstream === null) return 'No upstream';
  if (b.gone) return `${b.upstream} was deleted on the remote`;
  if (b.ahead === 0 && b.behind === 0) return `Up to date with ${b.upstream}`;
  return `${b.ahead} ahead, ${b.behind} behind ${b.upstream}`;
}

/** Why a branch cannot be switched to or deleted, or null when it can. */
export function lockedReason(b: GitLocalBranch): string | null {
  if (b.head) return 'This is the current branch';
  if (b.worktree !== null) return `Checked out in ${b.worktree}`;
  return null;
}

/** Branches whose upstream was deleted that Clean up can remove: not current, not in a worktree. */
export function goneBranches(list: GitBranchList): GitLocalBranch[] {
  return list.local.filter((b) => b.gone && lockedReason(b) === null);
}

export type SwitcherEntry =
  | { kind: 'local'; branch: GitLocalBranch }
  | { kind: 'remote'; branch: GitRemoteBranch }
  | { kind: 'create'; name: string };

/**
 * The branch switcher's rows for a query: matching local branches, then matching remote ones,
 * then a Create row when the query is a valid name no local branch has.
 */
export function switcherEntries(list: GitBranchList, query: string): SwitcherEntry[] {
  const shown = filterBranches(list, query);
  const out: SwitcherEntry[] = [
    ...shown.local.map((branch): SwitcherEntry => ({ kind: 'local', branch })),
    ...shown.remote.map((branch): SwitcherEntry => ({ kind: 'remote', branch })),
  ];
  const name = query.trim();
  if (name !== '' && branchNameError(name) === null && !list.local.some((b) => b.name === name)) {
    out.push({ kind: 'create', name });
  }
  return out;
}

/** The row a switcher opens on: the first branch that is not current, else the first row. */
export function switcherStart(entries: readonly SwitcherEntry[]): number {
  if (entries.length === 0) return -1;
  const i = entries.findIndex((e) => !(e.kind === 'local' && e.branch.head));
  return i < 0 ? 0 : i;
}
