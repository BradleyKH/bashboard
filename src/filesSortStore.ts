import { DEFAULT_FILES_SORT, parseFilesSort, type FilesSort } from './filesModel';
import { pathKey } from './pathCompare';

/**
 * The sort a new Files pane starts at: the one last picked in a pane showing that folder
 * (docs/design/files.md section 4.12). Keyed by `pathKey`, oldest first, so the cap drops the
 * folders sorted longest ago.
 */
const MAX_FOLDERS = 200;
let sorts = new Map<string, FilesSort>();
let listener: (() => void) | null = null;

export function filesSortFor(folder: string): FilesSort {
  return sorts.get(pathKey(folder)) ?? DEFAULT_FILES_SORT;
}

export function setFilesSort(folder: string, sort: FilesSort): void {
  const key = pathKey(folder);
  const had = sorts.get(key);
  sorts.delete(key);
  // The default is what an unknown folder gets anyway, so it needs no entry.
  if (sort.key !== DEFAULT_FILES_SORT.key || sort.desc !== DEFAULT_FILES_SORT.desc) {
    sorts.set(key, sort);
    while (sorts.size > MAX_FOLDERS) sorts.delete(sorts.keys().next().value as string);
  } else if (!had) return;
  listener?.();
}

/** The `filesSorts` field of workspace.json; undefined when no folder has one. */
export function filesSortsSnapshot(): Record<string, FilesSort> | undefined {
  return sorts.size > 0 ? Object.fromEntries(sorts) : undefined;
}

/** Restores the sorts from workspace.json, before any pane is built. */
export function loadFilesSorts(saved: Record<string, FilesSort>): void {
  sorts = new Map(Object.entries(saved).slice(-MAX_FOLDERS));
}

/** Reads `filesSorts`, dropping malformed entries; undefined when none remain. */
export function parseFilesSorts(raw: unknown): Record<string, FilesSort> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, FilesSort> = {};
  for (const [folder, value] of Object.entries(raw as Record<string, unknown>)) {
    const sort = parseFilesSort(value);
    // parseFilesSort falls back to the default for junk, which needs no entry either.
    if (sort !== DEFAULT_FILES_SORT) out[folder] = sort;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** One listener, the workspace saver. */
export function onFilesSortChange(fn: () => void): void {
  listener = fn;
}
