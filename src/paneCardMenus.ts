import { item, separator, type MenuEntry, type MenuItem } from './contextMenuModel';

export interface PaneCardMenuHandlers {
  onFocus(): void;
  onToggleCollapse(): void;
  onOpenInExplorer(path: string): void;
  onCopyPath(path: string): void;
  onClose(): void;
}

/** The entries every folder-bearing row shares: the Open menu's, File Explorer, and Copy path. */
function folderEntries(
  path: string,
  openItems: MenuItem[],
  handlers: Pick<PaneCardMenuHandlers, 'onOpenInExplorer' | 'onCopyPath'>,
): MenuEntry[] {
  return [
    ...openItems,
    item('Open in File Explorer', () => handlers.onOpenInExplorer(path)),
    item('Copy path', () => handlers.onCopyPath(path)),
  ];
}

/** The menu for a Panes card (docs/v0.2.0-design.md section 11.3); `path` is empty for a pane with no folder. */
export function paneCardMenuItems(
  card: { path: string; collapsed: boolean },
  openItems: MenuItem[],
  handlers: PaneCardMenuHandlers,
): MenuEntry[] {
  const out: MenuEntry[] = [
    item('Focus', handlers.onFocus),
    item(card.collapsed ? 'Expand' : 'Collapse', handlers.onToggleCollapse),
  ];
  if (card.path) out.push(separator(), ...folderEntries(card.path, openItems, handlers));
  out.push(separator(), item('Close', handlers.onClose));
  return out;
}

export interface SessionRowMenuHandlers {
  onOpenInExplorer(path: string): void;
  onCopyPath(path: string): void;
  onCopyCwd(cwd: string): void;
  onCopySessionId(sessionId: string): void;
}

/** The menu for an External sessions row; the Copy entries are offered whether or not the row is expanded. */
export function sessionRowMenuItems(
  session: { cwd: string; sessionId: string },
  openItems: MenuItem[],
  handlers: SessionRowMenuHandlers,
): MenuEntry[] {
  const out: MenuEntry[] = [];
  if (session.cwd) out.push(...folderEntries(session.cwd, openItems, handlers), separator());
  out.push(
    item('Copy cwd', () => handlers.onCopyCwd(session.cwd)),
    item('Copy session id', () => handlers.onCopySessionId(session.sessionId)),
  );
  return out;
}

export interface ClaudeRowMenuHandlers {
  onFocus(): void;
  onCopyPath(path: string): void;
}

/** The menu for a Claude section row. */
export function claudeRowMenuItems(row: { path: string }, handlers: ClaudeRowMenuHandlers): MenuEntry[] {
  const out: MenuEntry[] = [item('Focus', handlers.onFocus)];
  if (row.path) out.push(item('Copy path', () => handlers.onCopyPath(row.path)));
  return out;
}
