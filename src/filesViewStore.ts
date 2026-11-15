import type { FilesView } from './filesTreeModel';

/** The view a new Files pane starts in: the one last picked in any pane (docs/design/files.md section 4.12). */
let current: FilesView = 'folder';
let listener: (() => void) | null = null;

export function filesView(): FilesView {
  return current;
}

/** Restores the view from workspace.json, before any pane is built. */
export function loadFilesView(view: FilesView): void {
  current = view;
}

export function setFilesView(view: FilesView): void {
  if (view === current) return;
  current = view;
  listener?.();
}

/** One listener, the workspace saver. */
export function onFilesViewChange(fn: () => void): void {
  listener = fn;
}
