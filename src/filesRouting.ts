/** Where a Files request goes, and the path text it produces (docs/design.md section 4.12). */

import { samePath } from './favorites';
import { relativeWithin } from './filesModel';

export interface FilesPaneInfo {
  paneId: string;
  root: string;
  folder: string;
}

export interface FilesRequest {
  root: string;
  folder: string;
  /** Absolute path of the entry to select. */
  select?: string;
}

/**
 * Reuse a Files pane already showing the request's repo (preferring one already in that folder),
 * else open a new one.
 */
export function routeFilesRequest(
  panes: readonly FilesPaneInfo[],
  req: FilesRequest,
): { reuse: string } | { open: true } {
  const sameRepo = panes.filter((p) => samePath(p.root, req.root));
  const hit = sameRepo.find((p) => samePath(p.folder, req.folder)) ?? sameRepo[0];
  return hit ? { reuse: hit.paneId } : { open: true };
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return trimmed;
  const head = trimmed.slice(0, idx);
  if (head === '') return '/';
  return /^[A-Za-z]:$/.test(head) ? `${head}${path.includes('\\') ? '\\' : '/'}` : head;
}

/** A folder pin shows that folder; a file pin shows its folder and selects the file. */
export function pinTarget(
  _root: string,
  absolutePath: string,
  isDir: boolean,
): { folder: string; select?: string } {
  return isDir ? { folder: absolutePath } : { folder: parentOf(absolutePath), select: absolutePath };
}

/** Forward-slash path relative to the repo root, or the absolute path when outside it. */
export function insertPathText(root: string, path: string): string {
  const rel = relativeWithin(root, path);
  if (rel === null) return path;
  return rel === '' ? '.' : rel;
}
