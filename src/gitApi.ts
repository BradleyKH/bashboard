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

/** The callback gets the root exactly as it was passed to `gitWatch`. */
export function onGitChanged(cb: (root: string) => void): Promise<UnlistenFn> {
  return listen<{ root: string }>('git://changed', (e) => cb(e.payload.root));
}
