import { item, separator, type MenuEntry } from './contextMenuModel';
import type { GitCommit } from './gitApi';
import type { GitRow } from './gitModel';

export interface GitFileMenuHandlers {
  showDiff: (row: GitRow) => void;
  /** Stages the row, or unstages it in the Staged list. */
  toggle: (row: GitRow) => void;
  showInFiles: (row: GitRow) => void;
  copyPath: (row: GitRow) => void;
  insertPath: (row: GitRow) => void;
  /** Throws away the row's unstaged change; the caller confirms first. */
  revert: (row: GitRow) => void;
}

/**
 * Revert applies to an unstaged edit or deletion and to an untracked file. A conflicted file has
 * no single version to go back to, and an unstaged rename (from `add -N`) has two paths whose
 * index versions do not undo it cleanly.
 */
export function canRevert(row: GitRow): boolean {
  return row.kind === 'untracked' || (row.kind === 'unstaged' && !row.entry.origPath);
}

/** The menu for a changed-file row (docs/design/terminal.md section 4.4). */
export function gitFileMenuItems(row: GitRow, staged: boolean, h: GitFileMenuHandlers): MenuEntry[] {
  return [
    item('Show diff', () => h.showDiff(row)),
    item(staged ? 'Unstage' : 'Stage', () => h.toggle(row)),
    ...(!staged && canRevert(row) ? [item('Revert changes...', () => h.revert(row))] : []),
    separator(),
    // A deleted file has nothing to show, and its row hides the Open button.
    item('Show in Files', () => h.showInFiles(row), { enabled: row.entry.status !== 'D' }),
    item('Copy path', () => h.copyPath(row)),
    item('Insert path', () => h.insertPath(row)),
  ];
}

export interface GitCommitMenuHandlers {
  showDiff: (commit: GitCommit) => void;
  copyHash: (hash: string) => void;
  copySubject: (subject: string) => void;
  undo: (hash: string) => void;
  /** Pushes the branch (`upTo` null) or only up to the given commit. */
  push: (upTo: string | null) => void;
}

export interface GitCommitMenuState {
  /** The commit the diff's Undo button targets, if any. */
  undoHash: string | null;
  /** From `commitPushKind`; null hides the push entry. */
  push: 'push' | 'upTo' | null;
  /** False while a fetch, pull, or push is running. */
  canPush: boolean;
}

/** The menu for a commit row (docs/design/git.md section 4.13). */
export function gitCommitMenuItems(commit: GitCommit, state: GitCommitMenuState, h: GitCommitMenuHandlers): MenuEntry[] {
  const entries: MenuEntry[] = [
    item('Show diff', () => h.showDiff(commit)),
    separator(),
    item('Copy hash', () => h.copyHash(commit.hash)),
    item('Copy subject', () => h.copySubject(commit.subject)),
  ];
  const actions: MenuEntry[] = [];
  if (state.push === 'push') {
    actions.push(item('Push', () => h.push(null), { enabled: state.canPush }));
  } else if (state.push === 'upTo') {
    actions.push(item('Push up to here', () => h.push(commit.hash), { enabled: state.canPush }));
  }
  if (state.undoHash !== null && commit.hash === state.undoHash) {
    actions.push(item('Undo commit', () => h.undo(commit.hash)));
  }
  if (actions.length > 0) entries.push(separator(), ...actions);
  return entries;
}
