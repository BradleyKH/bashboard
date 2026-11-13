import { invoke } from '@tauri-apps/api/core';

export interface BranchSize {
  /** The worktree's toplevel, display form (as `git_worktree_detail` returns `path`). */
  worktree: string;
  /** Checked-out branch; null on a detached HEAD. */
  branch: string | null;
  /** Short comparison ref, e.g. "origin/main"; null when there is none. */
  comparison: string | null;
  /** Lines added plus lines removed, counted files only. 0 when comparison is null. */
  lines: number;
  added: number;
  removed: number;
  /** Counted files changed. */
  files: number;
  /** Lines and files left out as tests, lockfiles, or generated files. */
  excludedLines: number;
  excludedFiles: number;
}

export function gitBranchSize(path: string): Promise<BranchSize> {
  return invoke<BranchSize>('git_branch_size', { path });
}
