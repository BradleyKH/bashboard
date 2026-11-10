import { item, separator, type MenuEntry, type MenuItem } from './contextMenuModel';

export interface PinRowMenuHandlers {
  open: () => void;
  openInExplorer: () => void;
  copyPath: () => void;
  rename: () => void;
  remove: () => void;
}

/** The menu for a pin row; a pin whose target is missing keeps only Remove pin. */
export function pinRowMenuItems(state: { exists: boolean }, h: PinRowMenuHandlers): MenuEntry[] {
  const enabled = state.exists;
  return [
    item('Open', h.open, { enabled }),
    item('Open in File Explorer', h.openInExplorer, { enabled }),
    item('Copy path', h.copyPath, { enabled }),
    separator(),
    item('Rename', h.rename, { enabled }),
    item('Remove pin', h.remove),
  ];
}

export interface CommandPinRowMenuHandlers {
  run: () => void;
  edit: () => void;
  copyCommand: () => void;
  openInExplorer: () => void;
  copyPath: () => void;
  remove: () => void;
}

/** The menu for a command pin row; one whose folder is missing keeps only Remove pin. */
export function commandPinRowMenuItems(state: { exists: boolean }, h: CommandPinRowMenuHandlers): MenuEntry[] {
  const enabled = state.exists;
  return [
    item('Type in terminal', h.run, { enabled }),
    item('Edit', h.edit, { enabled }),
    item('Copy command', h.copyCommand, { enabled }),
    separator(),
    item('Open in File Explorer', h.openInExplorer, { enabled }),
    item('Copy path', h.copyPath, { enabled }),
    separator(),
    item('Remove pin', h.remove),
  ];
}

export interface GlobalPinRowMenuHandlers {
  run: () => void;
  edit: () => void;
  copyCommand: () => void;
  remove: () => void;
}

/** The menu for a global pin row, which has no folder of its own to open or copy. */
export function globalPinRowMenuItems(h: GlobalPinRowMenuHandlers): MenuEntry[] {
  return [
    item('Type in terminal', h.run),
    item('Edit', h.edit),
    item('Copy command', h.copyCommand),
    separator(),
    item('Remove pin', h.remove),
  ];
}

export interface WorktreeRowMenuHandlers {
  openInExplorer: () => void;
  copyPath: () => void;
  /** Absent for the main worktree, which cannot be deleted. */
  delete?: () => void;
}

/** The menu for a worktree row; a worktree whose folder is missing keeps only Delete. */
export function worktreeRowMenuItems(
  state: { missing: boolean; locked?: boolean },
  openItems: MenuItem[],
  h: WorktreeRowMenuHandlers,
): MenuEntry[] {
  const enabled = !state.missing;
  const entries: MenuEntry[] = [
    ...openItems.map((i) => ({ ...i, enabled: enabled && i.enabled !== false })),
    separator(),
    item('Open in File Explorer', h.openInExplorer, { enabled }),
    item('Copy path', h.copyPath, { enabled }),
  ];
  if (h.delete) entries.push(separator(), item('Delete', h.delete, { enabled: !state.locked }));
  return entries;
}
