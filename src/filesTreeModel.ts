/**
 * The Files list's rows in both views, and the tree's keys and expansion rules
 * (docs/design/files.md section 4.12, Tree view). No DOM.
 *
 * A row's key is its path below the folder shown, with forward slashes; the folder shown is ''.
 * In the Folder view every key is a bare name.
 */

import { relativeWithin, sortEntries, type FileEntry, type FilesSort } from './filesModel';

export type FilesView = 'folder' | 'tree';

export function parseFilesView(raw: unknown): FilesView | undefined {
  return raw === 'tree' || raw === 'folder' ? raw : undefined;
}

/** One row of the list: an entry, where it sits, and whether it is an expanded folder. */
export interface FileItem extends FileEntry {
  key: string;
  depth: number;
  open: boolean;
}

export function childKey(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

/** The key of the folder holding `key`: '' for a top-level row. */
export function parentKey(key: string): string {
  const i = key.lastIndexOf('/');
  return i < 0 ? '' : key.slice(0, i);
}

/** Whether `key` is `folder` itself or inside it. */
export function isWithin(key: string, folder: string): boolean {
  return folder === '' || key === folder || key.startsWith(`${folder}/`);
}

/** The folder keys to expand, outermost first, for `key`'s row to show. */
export function ancestorsOf(key: string): string[] {
  const parts = key.split('/');
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** The absolute path of `key` below `folder`, in the folder's own separator. */
export function joinKey(folder: string, key: string): string {
  if (key === '') return folder;
  const sep = folder.includes('\\') ? '\\' : '/';
  const rel = sep === '/' ? key : key.replace(/\//g, sep);
  return /[\\/]$/.test(folder) ? `${folder}${rel}` : `${folder}${sep}${rel}`;
}

/** The key of an absolute `path` below `folder`, '' for the folder itself, or null outside it. */
export function keyWithin(folder: string, path: string): string | null {
  return relativeWithin(folder, path);
}

const ABSOLUTE = /^([A-Za-z]:)?[\\/]/;

/**
 * The key a requested selection names: a bare name or a key as is, an absolute path by its key
 * below `folder`. Null for nothing, the folder itself, or a path outside it.
 */
export function selectionKey(folder: string, select: string | null | undefined): string | null {
  if (!select) return null;
  if (ABSOLUTE.test(select)) {
    const key = keyWithin(folder, select);
    return key === null || key === '' ? null : key;
  }
  const key = select.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return key === '' ? null : key;
}

/** What the list knows of the folder shown: each listed folder's entries, by key, and which are expanded. */
export interface TreeState {
  children: ReadonlyMap<string, readonly FileEntry[]>;
  open: ReadonlySet<string>;
}

/**
 * The rows in order. The Folder view lists the top's entries alone. The tree nests each open
 * folder's sorted children under its row; a filter keeps matching names and their parent folders.
 */
export function visibleItems(state: TreeState, view: FilesView, sort: FilesSort, filter: string): FileItem[] {
  const all: FileItem[] = [];
  const walk = (folder: string, depth: number): void => {
    for (const e of sortEntries(state.children.get(folder) ?? [], sort)) {
      const key = childKey(folder, e.name);
      const open = view === 'tree' && e.isDir && state.open.has(key) && state.children.has(key);
      all.push({ ...e, key, depth, open });
      if (open) walk(key, depth + 1);
    }
  };
  walk('', 0);
  const needle = filter.toLowerCase();
  if (needle === '') return all;
  const keep = new Set<string>();
  for (const item of all) {
    if (!item.name.toLowerCase().includes(needle)) continue;
    keep.add(item.key);
    for (const a of ancestorsOf(item.key)) keep.add(a);
  }
  return all.filter((i) => keep.has(i.key));
}

/** Every listed key, filter aside; what a selection may keep across a refresh. */
export function listedKeys(state: TreeState, view: FilesView): string[] {
  return visibleItems(state, view, { key: 'name', desc: false }, '').map((i) => i.key);
}

/** The open folders that still show: each listed, and every folder above it open. */
export function pruneOpen(state: TreeState): Set<string> {
  const out = new Set<string>();
  const byDepth = [...state.open].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const key of byDepth) {
    const parent = parentKey(key);
    if (parent !== '' && !out.has(parent)) continue;
    const name = key.slice(parent === '' ? 0 : parent.length + 1);
    if (state.children.get(parent)?.some((e) => e.isDir && e.name === name)) out.add(key);
  }
  return out;
}

/** `open` without `key` and the folders inside it. */
export function collapse(open: ReadonlySet<string>, key: string): Set<string> {
  return new Set([...open].filter((k) => !isWithin(k, key)));
}

export type TreeMove = { kind: 'expand'; key: string } | { kind: 'collapse'; key: string } | { kind: 'cursor'; key: string };

/**
 * Left and Right in the tree: Right expands a collapsed folder or steps into an expanded one,
 * Left collapses an expanded folder or steps out to the parent. Null when the key does nothing.
 */
export function treeArrow(items: readonly FileItem[], cursor: string | null, key: 'ArrowLeft' | 'ArrowRight'): TreeMove | null {
  const at = cursor === null ? -1 : items.findIndex((i) => i.key === cursor);
  if (at < 0) return null;
  const item = items[at];
  if (key === 'ArrowRight') {
    if (!item.isDir) return null;
    if (!item.open) return { kind: 'expand', key: item.key };
    const next = items[at + 1];
    return next && parentKey(next.key) === item.key ? { kind: 'cursor', key: next.key } : null;
  }
  if (item.open) return { kind: 'collapse', key: item.key };
  const parent = parentKey(item.key);
  return parent === '' ? null : { kind: 'cursor', key: parent };
}
