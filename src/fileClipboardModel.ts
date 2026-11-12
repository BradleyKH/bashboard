import { samePath } from './favorites';

/** The clipboard's file list (`clipboard_read_files`); `cut` when File Explorer cut them. */
export interface ClipboardFiles {
  paths: string[];
  cut: boolean;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((p) => b.some((q) => samePath(p, q)));
}

/**
 * Whether pasting `files` moves them (docs/design/files.md section 4.12): the clipboard says
 * cut, as File Explorer's Cut does on Windows, or this app cut exactly these paths, which is
 * how a cut is known on macOS and Linux, where the clipboard carries no such flag.
 */
export function pasteMoves(files: ClipboardFiles, appCut: readonly string[]): boolean {
  return files.cut || (appCut.length > 0 && sameSet(files.paths, appCut));
}
