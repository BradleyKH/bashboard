import { item, separator, submenu, type MenuEntry } from './contextMenuModel';
import type { FileEntry } from './filesModel';

export interface MoveTarget {
  label: string;
  path: string;
}

/** Each item reports the row's entry; the menu holds no app state. */
export interface FileRowMenuHandlers {
  openTerminalHere: (entry: FileEntry) => void;
  openInEditor: (entry: FileEntry) => void;
  copyPath: (entry: FileEntry) => void;
  insertPath: (entry: FileEntry) => void;
  /** `toDir` is the chosen target's absolute folder. */
  moveTo: (entry: FileEntry, toDir: string) => void;
  pin: (entry: FileEntry) => void;
}

/**
 * A Files row's menu (docs/design.md section 4.12), from its ⋯ button or a right-click. Move to
 * appears for files only (`fs_move` moves files) and only when there are targets.
 */
export function fileRowMenuItems(
  entry: FileEntry,
  moveTargets: readonly MoveTarget[],
  handlers: FileRowMenuHandlers,
): MenuEntry[] {
  const out: MenuEntry[] = [];
  if (entry.isDir) out.push(item('Open terminal here', () => handlers.openTerminalHere(entry)));
  out.push(
    item('Open in editor', () => handlers.openInEditor(entry)),
    separator(),
    item('Copy path', () => handlers.copyPath(entry)),
    item('Insert path', () => handlers.insertPath(entry)),
    separator(),
  );
  if (!entry.isDir && moveTargets.length > 0) {
    out.push(
      submenu(
        'Move to',
        moveTargets.map((t) => item(t.label, () => handlers.moveTo(entry, t.path))),
      ),
    );
  }
  out.push(item('Pin', () => handlers.pin(entry)));
  return out;
}

export interface FolderMenuState {
  /** The current folder is pinned, so the pin item unpins. */
  pinned: boolean;
}

export interface FolderMenuHandlers {
  openTerminalHere: () => void;
  openInExplorer: () => void;
  copyPath: () => void;
  /** Pins the current folder, or unpins it when pinned, as the breadcrumb's pin button does. */
  togglePin: () => void;
}

/** The breadcrumb's and the empty list area's menu, acting on the current folder. */
export function folderMenuItems(state: FolderMenuState, handlers: FolderMenuHandlers): MenuEntry[] {
  return [
    item('Open terminal here', handlers.openTerminalHere),
    item('Open in File Explorer', handlers.openInExplorer),
    separator(),
    item('Copy path', handlers.copyPath),
    separator(),
    item(state.pinned ? 'Unpin' : 'Pin', handlers.togglePin),
  ];
}

export interface FilePreviewMenuState {
  /** Text is selected inside the preview. */
  hasSelection: boolean;
  /** The previewed file, or null when nothing is previewed. */
  path: string | null;
  /** The preview has a find bar (a text preview); defaults to true. */
  canFind?: boolean;
}

export interface FilePreviewMenuHandlers {
  copy: () => void;
  find: () => void;
  openInEditor: (path: string) => void;
  copyPath: (path: string) => void;
}

/** The preview's menu outside the text editor; nothing when no file is previewed. */
export function filePreviewMenuItems(state: FilePreviewMenuState, handlers: FilePreviewMenuHandlers): MenuEntry[] {
  const path = state.path;
  if (path === null) return [];
  const out: MenuEntry[] = [];
  if (state.hasSelection) out.push(item('Copy', handlers.copy), separator());
  out.push(
    item('Find', handlers.find, { enabled: state.canFind !== false }),
    item('Open in editor', () => handlers.openInEditor(path)),
    separator(),
    item('Copy path', () => handlers.copyPath(path)),
  );
  return out;
}
