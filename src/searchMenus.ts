import { item, separator, type MenuEntry } from './contextMenuModel';
import type { SearchItem } from './searchModel';

export interface SearchMenuHandlers {
  /** Opens the file in the editor; a match row's item carries its line. */
  open: (target: SearchItem) => void;
  /** Both receive the file's repo-relative path, never `path:line`. */
  copyPath: (path: string) => void;
  insertPath: (path: string) => void;
}

export interface SearchGroupMenuHandlers extends SearchMenuHandlers {
  toggle: (path: string) => void;
}

/** Menu for a match row (docs/v0.2.0-design.md section 11.3). */
export function searchMatchMenuItems(target: Extract<SearchItem, { kind: 'match' }>, h: SearchMenuHandlers): MenuEntry[] {
  return [
    item('Open at line', () => h.open(target)),
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
    item('Open', () => h.open({ kind: 'name', path })),
    item('Copy path', () => h.copyPath(path)),
    item('Insert path', () => h.insertPath(path)),
  ];
  if (collapsed !== null && 'toggle' in h) {
    entries.push(separator(), item(collapsed ? 'Expand' : 'Collapse', () => h.toggle(path)));
  }
  return entries;
}
