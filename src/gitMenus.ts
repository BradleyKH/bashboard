import { item, separator, type MenuEntry } from './contextMenuModel';
import type { GitCommit } from './gitApi';
import type { GitRow } from './gitModel';

export interface GitFileMenuHandlers {
  showDiff: (row: GitRow) => void;
  /** Stages the row, or unstages it in the Staged list. */
  toggle: (row: GitRow) => void;
  openInEditor: (row: GitRow) => void;
  copyPath: (row: GitRow) => void;
  insertPath: (row: GitRow) => void;
}

/** The menu for a changed-file row (docs/design.md section 4.4). */
export function gitFileMenuItems(row: GitRow, staged: boolean, h: GitFileMenuHandlers): MenuEntry[] {
  return [
    item('Show diff', () => h.showDiff(row)),
    item(staged ? 'Unstage' : 'Stage', () => h.toggle(row)),
    separator(),
    // A deleted file has nothing to open, and its row hides the Open button.
    item('Open in editor', () => h.openInEditor(row), { enabled: row.entry.status !== 'D' }),
    item('Copy path', () => h.copyPath(row)),
    item('Insert path', () => h.insertPath(row)),
  ];
}

export interface GitCommitMenuHandlers {
  showDiff: (commit: GitCommit) => void;
  copyHash: (hash: string) => void;
  copySubject: (subject: string) => void;
  undo: (hash: string) => void;
}

/** The menu for a commit row; Undo commit only for the commit the diff's Undo button targets. */
export function gitCommitMenuItems(
  commit: GitCommit,
  undoHash: string | null,
  h: GitCommitMenuHandlers,
): MenuEntry[] {
  const entries: MenuEntry[] = [
    item('Show diff', () => h.showDiff(commit)),
    separator(),
    item('Copy hash', () => h.copyHash(commit.hash)),
    item('Copy subject', () => h.copySubject(commit.subject)),
  ];
  if (undoHash !== null && commit.hash === undoHash) {
    entries.push(separator(), item('Undo commit', () => h.undo(commit.hash)));
  }
  return entries;
}
