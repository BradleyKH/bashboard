import { invoke } from '@tauri-apps/api/core';
import { pasteMoves, type ClipboardFiles } from './fileClipboardModel';
import { showToast } from './toast';

/**
 * The Files panes' cut, copy, and paste over the OS clipboard (docs/design/files.md section
 * 4.12), shared by every pane so a cut in one shows dimmed in all and pastes as a move in any.
 */

let cutPaths: string[] = [];
const listeners = new Set<() => void>();

function setCut(paths: string[]): void {
  cutPaths = paths;
  for (const fn of listeners) fn();
}

/** The paths of the last cut not yet pasted, which the lists draw dimmed. */
export function currentCut(): readonly string[] {
  return cutPaths;
}

/** Calls `fn` whenever the cut paths change; returns the unsubscribe. */
export function onCutChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function count(n: number): string {
  return n === 1 ? '1 item' : `${n} items`;
}

/** Puts files on the clipboard for a paste here or in File Explorer, toasting the outcome. */
export async function putFiles(paths: string[], cut: boolean): Promise<void> {
  try {
    await invoke('clipboard_write_files', { paths, cut });
  } catch (e) {
    showToast(`Could not ${cut ? 'cut' : 'copy'}: ${String(e)}`);
    return;
  }
  setCut(cut ? paths : []);
  showToast(`${cut ? 'Cut' : 'Copied'} ${count(paths.length)}`, 1500);
}

/** The clipboard's files and whether pasting them moves them; null when it holds no files. */
export async function readFiles(): Promise<{ paths: string[]; move: boolean } | null> {
  const files = await invoke<ClipboardFiles | null>('clipboard_read_files').catch(() => null);
  if (files === null) {
    if (cutPaths.length > 0) setCut([]);
    return null;
  }
  const move = pasteMoves(files, cutPaths);
  // Something else replaced the cut on the clipboard, so its rows are no longer pending.
  if (!move && cutPaths.length > 0) setCut([]);
  return { paths: files.paths, move };
}

/** A cut was pasted: the clipboard empties, as File Explorer leaves it, and nothing stays dimmed. */
export function cutPasted(): void {
  setCut([]);
  void invoke('clipboard_clear').catch(() => {});
}
