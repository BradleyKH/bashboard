import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Porcelain v2 one-letter codes: M A D R C T U, '?' for untracked. */
export interface GitFileEntry {
  path: string;
  origPath?: string;
  status: string;
}

export interface GitStatus {
  /** null when HEAD is detached. */
  branch: string | null;
  /** null in a repo with no commits. */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileEntry[];
  unstaged: GitFileEntry[];
  untracked: GitFileEntry[];
  /** Unmerged entries; the pane lists them under Changes with status U. */
  conflicted: GitFileEntry[];
  /** Remote names; empty when the repo has none. */
  remotes: string[];
}

export interface GitDiff {
  text: string;
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  subject: string;
  author: string;
  /** Epoch ms. */
  time: number;
  /** Whether any remote-tracking branch contains it. */
  pushed: boolean;
}

export function gitStatus(root: string): Promise<GitStatus> {
  return invoke<GitStatus>('git_status', { root });
}

export function gitStage(root: string, paths: string[]): Promise<void> {
  return invoke<void>('git_stage', { root, paths });
}

export function gitUnstage(root: string, paths: string[]): Promise<void> {
  return invoke<void>('git_unstage', { root, paths });
}

export function gitDiff(root: string, path: string, staged: boolean): Promise<GitDiff> {
  return invoke<GitDiff>('git_diff', { root, path, staged });
}

/** Newest first; empty in a repo with no commits. */
export function gitLog(root: string, count: number): Promise<GitCommit[]> {
  return invoke<GitCommit[]>('git_log', { root, count });
}

export function gitShow(root: string, hash: string): Promise<GitDiff> {
  return invoke<GitDiff>('git_show', { root, hash });
}

/** Rejects with git's combined output (hooks included) when the commit fails. */
export function gitCommit(root: string, message: string): Promise<void> {
  return invoke<void>('git_commit', { root, message });
}

/** Resolves to the undone commit's full message. */
export function gitUndoCommit(root: string, expectedHead: string): Promise<string> {
  return invoke<string>('git_undo_commit', { root, expectedHead });
}

/** Reference-counted per repo; pair every call with `gitUnwatch`. */
export function gitWatch(root: string): Promise<void> {
  return invoke<void>('git_watch', { root });
}

export function gitUnwatch(root: string): Promise<void> {
  return invoke<void>('git_unwatch', { root });
}

/**
 * The callback gets the root exactly as it was passed to `gitWatch`. `metadata` is true when refs
 * or worktree records changed, false for ordinary file edits only.
 */
export function onGitChanged(cb: (root: string, metadata: boolean) => void): Promise<UnlistenFn> {
  return listen<{ root: string; metadata?: boolean }>('git://changed', (e) =>
    cb(e.payload.root, e.payload.metadata ?? true),
  );
}

/** The app's last fetch attempt for a repo; `message` is git's output on failure, empty on success. */
export interface GitLastFetch {
  /** Epoch ms. */
  time: number;
  ok: boolean;
  message: string;
}

/** Rejects with git's output when the fetch fails. */
export function gitFetch(root: string): Promise<void> {
  return invoke<void>('git_fetch', { root, background: false });
}

/** Fast-forward only; rejects with git's output. */
export function gitPull(root: string): Promise<void> {
  return invoke<void>('git_pull', { root });
}

/** Publishes an unpublished branch; never forces. Rejects with git's output. */
export function gitPush(root: string): Promise<void> {
  return invoke<void>('git_push', { root });
}

/** Null when the app has not fetched that repo this session. */
export function gitLastFetch(root: string): Promise<GitLastFetch | null> {
  return invoke<GitLastFetch | null>('git_last_fetch', { root });
}

/** Tells the background fetch scheduler which repos have an open Git pane. */
export function gitFetchRoots(roots: string[]): Promise<void> {
  return invoke<void>('git_fetch_roots', { roots });
}

/** Background fetch pauses while the window is hidden or minimized. */
export function gitFetchVisible(visible: boolean): Promise<void> {
  return invoke<void>('git_fetch_visible', { visible });
}

/** The callback gets every registered root sharing the fetched repo, plus the root a manual command ran on. */
export function onGitFetched(cb: (roots: string[]) => void): Promise<UnlistenFn> {
  return listen<{ roots: string[] }>('git://fetched', (e) => cb(e.payload.roots));
}
