import { item, separator, submenu, type MenuEntry } from './contextMenuModel';
import type { FileEntry } from './filesModel';

export interface MoveTarget {
  label: string;
  path: string;
}

/** Each item reports the entries it acts on; the menu holds no app state. */
export interface FileRowMenuHandlers {
  openTerminalHere: (entry: FileEntry) => void;
  searchHere: (entry: FileEntry) => void;
  openInEditor: (entry: FileEntry) => void;
  copyPath: (entries: FileEntry[]) => void;
  insertPath: (entries: FileEntry[]) => void;
  /** `toDir` is the chosen target's absolute folder; `files` are never folders. */
  moveTo: (files: FileEntry[], toDir: string) => void;
  rename: (entry: FileEntry) => void;
  pin: (entry: FileEntry) => void;
}

/**
 * A Files row's menu (docs/design/files.md section 4.12), from its ⋯ button or a right-click.
 * `selection` is what the menu acts on: the row, or every selected row when it is one of several,
 * which leaves only the items that take many paths. Move to moves the selection's files
 * (`fs_move` moves files) and appears only when there are files and targets.
 */
export function fileRowMenuItems(
  entry: FileEntry,
  selection: readonly FileEntry[],
  moveTargets: readonly MoveTarget[],
  handlers: FileRowMenuHandlers,
): MenuEntry[] {
  const entries = selection.length > 0 ? [...selection] : [entry];
  const many = entries.length > 1;
  const files = entries.filter((e) => !e.isDir);
  const out: MenuEntry[] = [];
  if (!many) {
    if (entry.isDir) {
      out.push(
        item('Open terminal here', () => handlers.openTerminalHere(entry)),
        item('Search in this folder', () => handlers.searchHere(entry)),
      );
    }
    out.push(item('Open in editor', () => handlers.openInEditor(entry)), separator());
  }
  out.push(
    item(many ? 'Copy paths' : 'Copy path', () => handlers.copyPath(entries)),
    item(many ? 'Insert paths' : 'Insert path', () => handlers.insertPath(entries)),
  );
  if (files.length > 0 && moveTargets.length > 0) {
    out.push(
      separator(),
      submenu(
        many ? `Move ${files.length === 1 ? '1 file' : `${files.length} files`} to` : 'Move to',
        moveTargets.map((t) => item(t.label, () => handlers.moveTo(files, t.path))),
      ),
    );
  }
  if (!many) {
    if (files.length === 0 || moveTargets.length === 0) out.push(separator());
    out.push(item('Rename', () => handlers.rename(entry)), item('Pin', () => handlers.pin(entry)));
  }
  return out;
}

export interface FolderMenuState {
  /** The current folder is pinned, so the pin item unpins. */
  pinned: boolean;
}

export interface FolderMenuHandlers {
  openTerminalHere: () => void;
  openInExplorer: () => void;
  searchHere: () => void;
  copyPath: () => void;
  /** Pins the current folder, or unpins it when pinned, as the breadcrumb's pin button does. */
  togglePin: () => void;
}

/** The breadcrumb's and the empty list area's menu, acting on the current folder. */
export function folderMenuItems(state: FolderMenuState, handlers: FolderMenuHandlers): MenuEntry[] {
  return [
    item('Open terminal here', handlers.openTerminalHere),
    item('Open in File Explorer', handlers.openInExplorer),
    item('Search in this folder', handlers.searchHere),
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
