import { invoke } from '@tauri-apps/api/core';

export interface PrimaryBranch {
  /** The resolved primary branch; null when nothing resolves. */
  branch: string | null;
  /** The ref compared against: `origin/<branch>` when it exists, else `<branch>`. */
  comparison: string | null;
  /** The repos.json value as read, even if the branch no longer exists. */
  configured: string | null;
}

export type MergedState = 'merged' | 'probablyMerged' | 'notMerged' | 'unknown';

export interface Worktree {
  /** Native path. */
  path: string;
  head: string | null;
  /** Short name; null when detached. */
  branch: string | null;
  detached: boolean;
  main: boolean;
  locked: boolean;
  lockReason: string | null;
  /** Git lists it as prunable, or its folder is missing. */
  prunable: boolean;
  upstream: string | null;
  /** The upstream branch was deleted on the remote. */
  upstreamGone: boolean;
  /** Against the primary branch's comparison ref. */
  ahead: number;
  behind: number;
  merged: MergedState;
}

export interface WorktreeList {
  primary: PrimaryBranch;
  localBranches: string[];
  /** Main worktree first, then by folder name. */
  worktrees: Worktree[];
}

export interface HeadCommit {
  /** Short hash. */
  hash: string;
  subject: string;
  /** Epoch ms. */
  time: number;
}

export interface WorktreeDetail {
  path: string;
  branch: string | null;
  /** Null in a repo with no commits. */
  head: HeadCommit | null;
  comparison: string | null;
  ahead: number;
  behind: number;
  merged: MergedState;
  upstream: string | null;
  upstreamGone: boolean;
  upstreamAhead: number;
  upstreamBehind: number;
  staged: number;
  /** Unstaged plus conflicted entries. */
  changed: number;
  untracked: number;
}

export interface RemoveResult {
  /** Set when the worktree was removed but `git branch -d` failed. */
  branchError: string | null;
}

export function gitWorktrees(root: string): Promise<WorktreeList> {
  return invoke<WorktreeList>('git_worktrees', { root });
}

export function gitWorktreeDetail(path: string): Promise<WorktreeDetail> {
  return invoke<WorktreeDetail>('git_worktree_detail', { path });
}

export function gitPrimaryBranch(root: string): Promise<PrimaryBranch> {
  return invoke<PrimaryBranch>('git_primary_branch', { root });
}

/** Never forces. Rejects with a plain sentence when refused or git's output when it fails. */
export function gitWorktreeRemove(
  root: string,
  path: string,
  deleteBranch: boolean,
): Promise<RemoveResult> {
  return invoke<RemoveResult>('git_worktree_remove', { root, path, deleteBranch });
}
