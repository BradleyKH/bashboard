import { item, separator, type MenuEntry } from './contextMenuModel';
import type { SearchItem } from './searchModel';

export interface SearchMenuHandlers {
  /** Opens the file in the preferred editor; a match row's item carries its line. */
  open: (target: SearchItem) => void;
  /** The rest receive the file's repo-relative path, never `path:line`. */
  showInFiles: (path: string) => void;
  copyPath: (path: string) => void;
  insertPath: (path: string) => void;
}

export interface SearchGroupMenuHandlers extends SearchMenuHandlers {
  toggle: (path: string) => void;
}

/** Menu for a match row (docs/design.md section 4.14). */
export function searchMatchMenuItems(target: Extract<SearchItem, { kind: 'match' }>, h: SearchMenuHandlers): MenuEntry[] {
  return [
    item('Open in editor', () => h.open(target)),
    item('Show in Files', () => h.showInFiles(target.path)),
    separator(),
    item('Copy path', () => h.copyPath(target.path)),
    item('Insert path', () => h.insertPath(target.path)),
  ];
}

/**
 * Menu for a file group header, or for a file-name row when `collapsed` is null (names have
 * nothing to collapse).
 */
export function searchGroupMenuItems(
  path: string,
  collapsed: boolean | null,
  h: SearchGroupMenuHandlers | SearchMenuHandlers,
): MenuEntry[] {
  const entries: MenuEntry[] = [
    item('Open in editor', () => h.open({ kind: 'name', path })),
    item('Show in Files', () => h.showInFiles(path)),
    separator(),
    item('Copy path', () => h.copyPath(path)),
    item('Insert path', () => h.insertPath(path)),
  ];
  if (collapsed !== null && 'toggle' in h) {
    entries.push(separator(), item(collapsed ? 'Expand' : 'Collapse', () => h.toggle(path)));
  }
  return entries;
}
