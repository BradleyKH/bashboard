/** Files pane list, path, history, and keyboard rules (docs/design/files.md section 4.12). */

import { samePath } from './favorites';

/** Mirrors the core's `fs_list` entry (docs/design/files.md section 3.8); times are epoch milliseconds. */
export interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

/** Files over this size, or with a NUL byte near the start, are not previewed as text. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function byName(a: FileEntry, b: FileEntry): number {
  const folded = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return folded !== 0 ? folded : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export type FilesSortKey = 'name' | 'type' | 'modified';

/** The list's order, chosen from the breadcrumb's sort button and saved with the pane. */
export interface FilesSort {
  key: FilesSortKey;
  desc: boolean;
}

export const FILES_SORT_KEYS: readonly FilesSortKey[] = ['name', 'type', 'modified'];

/** The direction a key starts in when picked: newest first for modified, A to Z otherwise. */
function startsDesc(key: FilesSortKey): boolean {
  return key === 'modified';
}

export const DEFAULT_FILES_SORT: FilesSort = { key: 'modified', desc: true };

/** Picking the active key flips its direction; another key starts in its own direction. */
export function nextSort(current: FilesSort, key: FilesSortKey): FilesSort {
  return key === current.key ? { key, desc: !current.desc } : { key, desc: startsDesc(key) };
}

/** A saved sort, or the default when it is missing or malformed. */
export function parseFilesSort(raw: unknown): FilesSort {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_FILES_SORT;
  const { key, desc } = raw as { key?: unknown; desc?: unknown };
  if (!FILES_SORT_KEYS.includes(key as FilesSortKey) || typeof desc !== 'boolean') return DEFAULT_FILES_SORT;
  return { key: key as FilesSortKey, desc };
}

/** The sort button's text, such as "Modified ↓". */
export function sortLabel(sort: FilesSort): string {
  return `${sortKeyLabel(sort.key)} ${sort.desc ? '↓' : '↑'}`;
}

export function sortKeyLabel(key: FilesSortKey): string {
  return key === 'name' ? 'Name' : key === 'type' ? 'Type' : 'Modified';
}

/** The lowercased extension; a dotfile such as `.gitignore` with no other dot has none. */
function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Folders first, then files in `sort` order with ties by name. Folders sort by name, A to Z,
 * whatever the key, except that name descending reverses them too.
 */
export function sortEntries(entries: readonly FileEntry[], sort: FilesSort = DEFAULT_FILES_SORT): FileEntry[] {
  const sign = sort.desc ? -1 : 1;
  const folderSign = sort.key === 'name' && sort.desc ? -1 : 1;
  const folders = entries.filter((e) => e.isDir).sort((a, b) => folderSign * byName(a, b));
  const byKey = (a: FileEntry, b: FileEntry): number => {
    if (sort.key === 'name') return sign * byName(a, b);
    if (sort.key === 'type') return sign * extension(a.name).localeCompare(extension(b.name)) || byName(a, b);
    return sign * (a.modified - b.modified) || byName(a, b);
  };
  const files = entries.filter((e) => !e.isDir).sort(byKey);
  return [...folders, ...files];
}

/** Names containing the text, ignoring case; empty text keeps everything. */
export function filterEntries(entries: readonly FileEntry[], text: string): FileEntry[] {
  const needle = text.toLowerCase();
  if (needle === '') return [...entries];
  return entries.filter((e) => e.name.toLowerCase().includes(needle));
}

function trimSeparators(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

function separatorOf(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

function joinPath(base: string, part: string, sep: string): string {
  return `${trimSeparators(base)}${sep}${part}`;
}

/**
 * The path below `root` with forward slashes (empty for the root itself), or null when `path` is
 * not inside it. Case-insensitive, either separator, trailing separators ignored.
 */
export function relativeWithin(root: string, path: string): string | null {
  const r = trimSeparators(root.replace(/\\/g, '/'));
  const p = trimSeparators(path.replace(/\\/g, '/'));
  const rl = r.toLowerCase();
  const pl = p.toLowerCase();
  if (pl === rl) return '';
  if (pl.startsWith(`${rl}/`)) return p.slice(r.length + 1);
  return null;
}

export interface Crumb {
  name: string;
  path: string;
}

function lastName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/**
 * Segments from `root` down to `folder`, each with the path it navigates to. A folder outside the
 * root gets segments from its own drive (or `/`) instead, so the trail never lies about where
 * the pane is.
 */
export function breadcrumb(root: string, folder: string): Crumb[] {
  const rel = relativeWithin(root, folder);
  if (rel !== null) {
    const sep = separatorOf(root);
    const out: Crumb[] = [{ name: lastName(root), path: root }];
    let at = root;
    for (const part of rel.split('/').filter((s) => s !== '')) {
      at = joinPath(at, part, sep);
      out.push({ name: part, path: at });
    }
    return out;
  }

  const sep = separatorOf(folder);
  const parts = folder.split(/[\\/]+/).filter((s) => s !== '');
  const out: Crumb[] = [];
  let at = '';
  if (parts.length > 0 && /^[A-Za-z]:$/.test(parts[0])) {
    at = `${parts[0]}${sep}`;
    out.push({ name: parts[0], path: at });
    parts.shift();
  } else if (/^[\\/]/.test(folder)) {
    at = '/';
    out.push({ name: '/', path: at });
  }
  for (const part of parts) {
    at = at === '' ? part : at.endsWith(sep) ? `${at}${part}` : joinPath(at, part, sep);
    out.push({ name: part, path: at });
  }
  return out;
}

/** The folder above `folder`, or null at the repo root (or at a drive root outside it). */
export function parentWithin(root: string, folder: string): string | null {
  if (relativeWithin(root, folder) === '') return null;
  const trimmed = trimSeparators(folder);
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return null;
  const head = trimmed.slice(0, idx);
  if (head === '') return '/';
  if (/^[A-Za-z]:$/.test(head)) return `${head}${separatorOf(folder)}`;
  return head;
}

/** Folders a pane has shown; `index` is the current one (-1 when empty). Browser semantics. */
export interface History {
  readonly entries: readonly string[];
  readonly index: number;
}

export const EMPTY_HISTORY: History = { entries: [], index: -1 };

export function currentFolder(h: History): string | null {
  return h.index >= 0 ? h.entries[h.index] : null;
}

/** Visiting after going back drops the forward stack; revisiting the current folder is a no-op. */
export function visit(h: History, folder: string): History {
  const here = currentFolder(h);
  if (here !== null && samePath(here, folder)) return h;
  const entries = [...h.entries.slice(0, h.index + 1), folder];
  return { entries, index: entries.length - 1 };
}

export function canBack(h: History): boolean {
  return h.index > 0;
}

export function canForward(h: History): boolean {
  return h.index >= 0 && h.index < h.entries.length - 1;
}

/** One step back; the same history when there is nowhere to go. */
export function back(h: History): History {
  return canBack(h) ? { entries: h.entries, index: h.index - 1 } : h;
}

export function forward(h: History): History {
  return canForward(h) ? { entries: h.entries, index: h.index + 1 } : h;
}

export type PreviewKind = 'markdown' | 'plain' | 'code' | 'binary';

/**
 * How a file previews: `.md` renders, `.txt` or no extension edits as wrapped plain text, other
 * names edit as code with line numbers, and anything over 2 MiB is binary. A NUL byte also makes a file binary, but only the
 * read can tell.
 */
export function previewKind(name: string, size: number): PreviewKind {
  if (size > MAX_TEXT_BYTES) return 'binary';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'md') return 'markdown';
  if (ext === '' || ext === 'txt') return 'plain';
  return 'code';
}

export interface ListState {
  /** Name of the selected entry. */
  selected: string | null;
  filter: string;
}

export type ListEffect = 'preview' | 'open' | 'up' | 'none';

/**
 * The list's keyboard rules. `names` are the visible entries in order; `key` is
 * `KeyboardEvent.key`. Keys with Ctrl or Alt never reach this (the list leaves them for chords).
 */
export function listKey(
  state: ListState,
  key: string,
  names: readonly string[],
): { state: ListState; effect: ListEffect } {
  const at = state.selected === null ? -1 : names.indexOf(state.selected);
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (names.length === 0) return { state, effect: 'none' };
      const down = key === 'ArrowDown';
      const next =
        at < 0 ? (down ? 0 : names.length - 1) : Math.min(names.length - 1, Math.max(0, at + (down ? 1 : -1)));
      if (names[next] === state.selected) return { state, effect: 'none' };
      return { state: { ...state, selected: names[next] }, effect: 'preview' };
    }
    case 'Enter':
      return { state, effect: at >= 0 ? 'open' : 'none' };
    case 'Backspace':
      if (state.filter === '') return { state, effect: 'up' };
      return { state: { ...state, filter: state.filter.slice(0, -1) }, effect: 'none' };
    case 'Escape':
      return { state: { ...state, filter: '' }, effect: 'none' };
    default:
      if (key.length === 1) return { state: { ...state, filter: state.filter + key }, effect: 'none' };
      return { state, effect: 'none' };
  }
}

/**
 * Why `name` cannot name a file or folder on Windows, or null when it can. `fs_rename` checks
 * the same rules; this one marks the rename field while it is typed.
 */
export function fileNameError(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return 'Not a valid name';
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) return 'A name cannot contain < > : " / \\ | ? *';
  if (/[. ]$/.test(name)) return 'A name cannot end with a dot or a space';
  return null;
}
