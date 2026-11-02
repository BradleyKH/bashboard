import { item, separator, type MenuEntry, type MenuItem } from './contextMenuModel';

export interface PathMenuHandlers {
  openInExplorer: (path: string) => void;
  copyPath: (path: string) => void;
}

export interface FavoriteMenuHandlers extends PathMenuHandlers {
  remove: () => void;
}

export interface RecentMenuHandlers extends PathMenuHandlers {
  promote: (path: string) => void;
}

export interface LayoutMenuHandlers {
  open: () => void;
  rename: () => void;
  remove: () => void;
}

// The Open menu's entries lead, set apart from the path actions; no entries (no onOpenIn
// callback) leaves the rest without a stray separator.
function pathEntries(path: string, openItems: MenuItem[], h: PathMenuHandlers): MenuEntry[] {
  return [
    ...openItems,
    ...(openItems.length > 0 ? [separator()] : []),
    item('Open in File Explorer', () => h.openInExplorer(path)),
    item('Copy path', () => h.copyPath(path)),
  ];
}

/** Menu for a Favorites row (docs/design.md section 4.4). */
export function favoriteRowMenuItems(path: string, openItems: MenuItem[], h: FavoriteMenuHandlers): MenuEntry[] {
  return [...pathEntries(path, openItems, h), separator(), item('Remove favorite', h.remove)];
}

/** Menu for a Recent row. */
export function recentRowMenuItems(path: string, openItems: MenuItem[], h: RecentMenuHandlers): MenuEntry[] {
  return [...pathEntries(path, openItems, h), separator(), item('Add to favorites', () => h.promote(path))];
}

/** Menu for a Layouts row. */
export function layoutRowMenuItems(h: LayoutMenuHandlers): MenuEntry[] {
  return [item('Open', h.open), item('Rename', h.rename), separator(), item('Remove', h.remove)];
}
