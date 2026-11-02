import { item, type MenuEntry } from './contextMenuModel';

export interface TabMenuHandlers {
  onRename(): void;
  onNewTab(): void;
  onClose(): void;
}

/** The menu for one tab (docs/design.md section 4.4). */
export function tabMenuItems(handlers: TabMenuHandlers): MenuEntry[] {
  return [item('Rename', handlers.onRename), item('New tab', handlers.onNewTab), item('Close tab', handlers.onClose)];
}

/** The menu for the tab strip outside any tab (docs/design.md section 4.4). */
export function tabStripMenuItems(handlers: { onNewTab(): void }): MenuEntry[] {
  return [item('New tab', handlers.onNewTab)];
}
