import type { LineMatch, SearchBatch } from './searchApi';

export interface FileGroup {
  path: string;
  matches: LineMatch[];
  collapsed: boolean;
}

export interface SearchResults {
  /** Relative paths whose file name matched. */
  names: string[];
  groups: FileGroup[];
  matches: number;
  files: number;
  truncated: boolean;
  done: boolean;
  error: string | null;
}

/** The core stops a search after this many line matches. */
export const MAX_RESULTS = 5000;

export type SearchItem =
  | { kind: 'name'; path: string }
  | { kind: 'match'; path: string; match: LineMatch };

export interface Segment {
  text: string;
  hit: boolean;
}

const BACKSLASH = String.fromCharCode(92);

export function emptyResults(): SearchResults {
  return { names: [], groups: [], matches: 0, files: 0, truncated: false, done: false, error: null };
}

export function applyBatch(state: SearchResults, batch: SearchBatch): SearchResults {
  switch (batch.type) {
    case 'names':
      return { ...state, names: batch.paths };
    case 'file': {
      const group: FileGroup = { path: batch.path, matches: batch.matches, collapsed: false };
      return {
        ...state,
        groups: [...state.groups, group],
        files: state.groups.length + 1,
        matches: state.matches + batch.matches.length,
      };
    }
    case 'done':
      return { ...state, files: batch.files, matches: batch.matches, truncated: batch.truncated, done: true };
  }
}

export function withError(state: SearchResults, message: string): SearchResults {
  return { ...state, error: message, done: true };
}

export function toggleGroup(state: SearchResults, path: string): SearchResults {
  return {
    ...state,
    groups: state.groups.map((g) => (g.path === path ? { ...g, collapsed: !g.collapsed } : g)),
  };
}

/** The selectable rows in display order: file-name hits, then each expanded group's matches. */
export function flatten(state: SearchResults): SearchItem[] {
  const items: SearchItem[] = state.names.map((path) => ({ kind: 'name', path }));
  for (const g of state.groups) {
    if (g.collapsed) continue;
    for (const match of g.matches) items.push({ kind: 'match', path: g.path, match });
  }
  return items;
}

/** Index of the next selection, clamped to the list; from no selection it is the first item. */
export function stepSelection(items: readonly SearchItem[], current: number | null, delta: number): number | null {
  if (items.length === 0) return null;
  if (current === null) return 0;
  return Math.min(items.length - 1, Math.max(0, current + delta));
}

/** Splits a line into alternating plain and hit pieces; ranges are clamped and may arrive unsorted. */
export function highlightSegments(text: string, ranges: readonly [number, number][]): Segment[] {
  const out: Segment[] = [];
  let pos = 0;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (const [rawStart, rawEnd] of sorted) {
    const start = Math.max(pos, Math.min(rawStart, text.length));
    const end = Math.min(rawEnd, text.length);
    if (end <= start) continue;
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

export function footerText(state: SearchResults): string {
  if (state.error) return '';
  const hasAny = state.matches > 0 || state.names.length > 0;
  if (!hasAny) return state.done ? 'No results' : '';
  const parts: string[] = [];
  if (state.matches > 0) parts.push(`${plural(state.matches, 'result', 'results')} in ${plural(state.files, 'file', 'files')}`);
  if (state.names.length > 0) parts.push(plural(state.names.length, 'file name', 'file names'));
  let text = parts.join(', ');
  if (!state.done) text += '...';
  if (state.truncated) text += `. Results stop at the first ${MAX_RESULTS.toLocaleString('en-US')}; narrow the search to see the rest.`;
  return text;
}

/** Joins a root-relative path (forward slashes) onto `root` in the root's own separator style. */
export function absolutePath(root: string, relative: string): string {
  const windows = root.includes(BACKSLASH) || /^[A-Za-z]:/.test(root);
  const sep = windows ? BACKSLASH : '/';
  let base = root;
  while (base.endsWith('/') || base.endsWith(BACKSLASH)) base = base.slice(0, -1);
  const rel = windows ? relative.split('/').join(BACKSLASH) : relative;
  if (windows) base = base.split('/').join(BACKSLASH);
  return `${base}${sep}${rel}`;
}

/** The terminal selection as a starting query: only a single non-empty line qualifies. */
export function initialQuery(selection: string): string {
  const trimmed = selection.trim();
  return trimmed !== '' && !/[\r\n]/.test(trimmed) ? trimmed : '';
}
