import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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

/** What `worktree_plan` resolved: shown to the user before anything changes. */
export interface WorktreePlan {
  /** Native path of the repo's main worktree. */
  mainRoot: string;
  branch: string;
  baseRef: string;
  baseSha: string;
  shortSha: string;
  /** Native path the new worktree will occupy. */
  path: string;
  /** The new folder's name. */
  name: string;
  /** True when the base was the default rather than an explicit `--from`. */
  hint: boolean;
}

export interface WorktreeCreated {
  plan: WorktreePlan;
  /** The stable per-repo worktree index (`BB_WORKTREE_INDEX`). */
  index: number;
  /** Relative paths copied from `.worktreeinclude`. */
  copied: string[];
  warnings: string[];
  /** Whether `.bashboard/setup.sh` exists and, if so, is already approved for this repo. */
  setup: 'none' | 'trusted' | 'needsApproval';
}

export interface WorktreeCreatedEvent {
  /** The pty of the pane that ran `bb`; the new pane opens next to it. */
  ptyId: number;
  created: WorktreeCreated;
  agent: string | null;
  prompt: string | null;
}

/** Checks only; rejects with a plain sentence when the branch or path is unusable. */
export function worktreePlan(cwd: string, branch: string, from?: string): Promise<WorktreePlan> {
  return invoke<WorktreePlan>('worktree_plan', { cwd, branch, from });
}

/** Fetches, then creates the worktree and copies its includes. */
export function worktreeCreate(cwd: string, branch: string, from?: string): Promise<WorktreeCreated> {
  return invoke<WorktreeCreated>('worktree_create', { cwd, branch, from });
}

/** The text of `<path>/.bashboard/setup.sh`, or null when there is none. */
export function worktreeSetupScript(path: string): Promise<string | null> {
  return invoke<string | null>('worktree_setup_script', { path });
}

/** Approves the script currently at `path` for the repo; the core reads it, so approved equals run. */
export function worktreeTrustSetup(mainRoot: string, path: string): Promise<void> {
  return invoke<void>('worktree_trust_setup', { mainRoot, path });
}

/** Fires when `bb` created a worktree; the front end opens the pane. */
export function onWorktreeCreated(cb: (e: WorktreeCreatedEvent) => void): Promise<UnlistenFn> {
  return listen<WorktreeCreatedEvent>('worktree://created', (e) => cb(e.payload));
}
