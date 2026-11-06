import { item, separator, type MenuEntry } from './contextMenuModel';
import type { GitLocalBranch, GitRemoteBranch } from './gitApi';
import { lockedReason } from './gitBranchModel';

export interface GitBranchMenuHandlers {
  switchTo: (b: GitLocalBranch) => void;
  /** Opens the worktree that has the branch checked out. */
  openWorktree: (path: string) => void;
  newFrom: (b: GitLocalBranch) => void;
  rename: (b: GitLocalBranch) => void;
  remove: (b: GitLocalBranch) => void;
  copyName: (name: string) => void;
  insertName: (name: string) => void;
}

/** The menu for a local branch row (docs/design/git.md section 4.13). */
export function localBranchMenuItems(b: GitLocalBranch, h: GitBranchMenuHandlers): MenuEntry[] {
  const locked = lockedReason(b) !== null;
  const first =
    b.worktree !== null
      ? item('Open its worktree', () => h.openWorktree(b.worktree as string))
      : item('Switch', () => h.switchTo(b), { enabled: !b.head });
  return [
    first,
    item('New branch from here', () => h.newFrom(b)),
    separator(),
    item('Rename', () => h.rename(b)),
    item('Delete', () => h.remove(b), { enabled: !locked }),
    separator(),
    item('Copy name', () => h.copyName(b.name)),
    item('Insert name', () => h.insertName(b.name)),
  ];
}

export interface GitRemoteBranchMenuHandlers {
  checkOut: (b: GitRemoteBranch) => void;
  copyName: (name: string) => void;
  insertName: (name: string) => void;
}

/** The menu for a remote branch row. */
export function remoteBranchMenuItems(b: GitRemoteBranch, h: GitRemoteBranchMenuHandlers): MenuEntry[] {
  return [
    item('Check out', () => h.checkOut(b)),
    separator(),
    item('Copy name', () => h.copyName(b.name)),
    item('Insert name', () => h.insertName(b.name)),
  ];
}
