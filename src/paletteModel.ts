import { actionLabel, actionOrder, formatChord } from './helpModel';
import { parseChord, type Action, type Direction, type KeybindingEntry } from './keymap';
import type { Pin } from './repos';

export type PaletteCategory = 'Pane' | 'Tab' | 'Favorite' | 'Layout' | 'Pin' | 'Worktree' | 'Action';

export const CATEGORY_ORDER: readonly PaletteCategory[] = ['Pane', 'Tab', 'Favorite', 'Layout', 'Pin', 'Worktree', 'Action'];

export type PaletteChoice =
  | { kind: 'pane'; paneId: string }
  | { kind: 'tab'; tabId: string }
  | { kind: 'favorite'; path: string }
  | { kind: 'layout'; name: string }
  | { kind: 'pin'; pin: Pin }
  | { kind: 'worktree'; path: string }
  | { kind: 'action'; action: Action }
  | { kind: 'command'; command: PaletteCommand };

export interface PaletteItem {
  /** Stable across opens, so session recents survive a rebuild. */
  id: string;
  category: PaletteCategory;
  label: string;
  detail?: string;
  hint?: string;
  choice: PaletteChoice;
}

export interface PaletteInput {
  panes: { paneId: string; tabId: string; title: string }[];
  tabs: { id: string; title: string }[];
  favorites: { label: string; path: string }[];
  layouts: { name: string; paneCount: number }[];
  pins: { pin: Pin; absolute: string; exists: boolean }[];
  /** `branch` is the branch name, or the short hash when detached. */
  worktrees: { path: string; name: string; branch: string }[];
  keybindings: KeybindingEntry[];
}

/** Palette entries with no keybinding action, so they stay out of the F1 guide and its editor. */
export type PaletteCommand = 'checkForUpdates';

export const PALETTE_COMMANDS: readonly { command: PaletteCommand; label: string }[] = [
  { command: 'checkForUpdates', label: 'Check for updates' },
];

/** Actions that act on terminal text or need a number; tabs are items of their own. */
export const EXCLUDED_ACTIONS: readonly string[] = ['copy', 'paste', 'sendInput', 'switchToTab', 'openPalette'];

const DIRECTIONS: readonly Direction[] = ['left', 'right', 'up', 'down'];

/** Actions the palette lists once per direction; any other argument-taking action stays out. */
export const DIRECTIONAL_ACTIONS: readonly string[] = ['moveFocus', 'resizePane'];

function lastSegment(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

function chordHint(entries: KeybindingEntry[], action: string, direction?: Direction): string | undefined {
  const keys = entries.flatMap((e) => {
    if (e?.action !== action || (direction && e.direction !== direction)) return [];
    const chord = parseChord(String(e.keys ?? ''));
    return chord ? [formatChord(chord)] : [];
  });
  return keys.length > 0 ? keys.join(', ') : undefined;
}

function actionItems(entries: KeybindingEntry[]): PaletteItem[] {
  const items: PaletteItem[] = [];
  for (const name of actionOrder()) {
    if (EXCLUDED_ACTIONS.includes(name)) continue;
    const directions: (Direction | undefined)[] = DIRECTIONAL_ACTIONS.includes(name) ? [...DIRECTIONS] : [undefined];
    for (const direction of directions) {
      const label = actionLabel(name, direction);
      if (label === undefined) continue;
      const action = (direction ? { type: name, direction } : { type: name }) as Action;
      items.push({
        id: direction ? `action:${name}:${direction}` : `action:${name}`,
        category: 'Action',
        label,
        hint: chordHint(entries, name, direction),
        choice: { kind: 'action', action },
      });
    }
  }
  return items;
}

/** Every palette item, in category order. */
export function buildPaletteItems(input: PaletteInput): PaletteItem[] {
  const tabTitles = new Map(input.tabs.map((t) => [t.id, t.title]));
  return [
    ...input.panes.map((p): PaletteItem => ({
      id: `pane:${p.paneId}`,
      category: 'Pane',
      label: p.title,
      detail: tabTitles.get(p.tabId),
      choice: { kind: 'pane', paneId: p.paneId },
    })),
    ...input.tabs.map((t): PaletteItem => ({
      id: `tab:${t.id}`,
      category: 'Tab',
      label: t.title,
      choice: { kind: 'tab', tabId: t.id },
    })),
    ...input.favorites.map((f): PaletteItem => ({
      id: `favorite:${f.path}`,
      category: 'Favorite',
      label: f.label,
      detail: f.path,
      choice: { kind: 'favorite', path: f.path },
    })),
    ...input.layouts.map((l): PaletteItem => ({
      id: `layout:${l.name}`,
      category: 'Layout',
      label: l.name,
      detail: `${l.paneCount} ${l.paneCount === 1 ? 'pane' : 'panes'}`,
      choice: { kind: 'layout', name: l.name },
    })),
    // Opening a missing pin does nothing, so it is not offered.
    // A root pin's path is ".", so its name comes from the absolute path. The folder name is
    // dropped as a detail when it is already the title.
    ...input.pins.filter((p) => p.exists).map((p): PaletteItem => {
      const atRoot = p.pin.path === '.';
      const folder = lastSegment(p.absolute);
      return {
        id: `pin:${p.absolute}`,
        category: 'Pin',
        label: p.pin.label || (atRoot ? folder : lastSegment(p.pin.path)),
        detail: atRoot ? (p.pin.label ? folder : undefined) : p.pin.path,
        choice: { kind: 'pin', pin: p.pin },
      };
    }),
    ...input.worktrees.map((w): PaletteItem => ({
      id: `worktree:${w.path}`,
      category: 'Worktree',
      label: w.name,
      detail: w.branch,
      choice: { kind: 'worktree', path: w.path },
    })),
    ...actionItems(input.keybindings),
    ...PALETTE_COMMANDS.map((c): PaletteItem => ({
      id: `command:${c.command}`,
      category: 'Action',
      label: c.label,
      choice: { kind: 'command', command: c.command },
    })),
  ];
}

const MATCH = 1;
const CONSECUTIVE = 10;
const WORD_START = 8;

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (' -_/\\.'.includes(prev)) return true;
  const cur = text[i];
  return prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Case-insensitive subsequence score of `query` in `text`, or null when a query character is
 * missing. Whitespace in the query is skipped. Picks the best alignment with a small dynamic
 * program, since a greedy earliest match can miss a run of consecutive characters.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (q === '') return 0;
  const lower = text.toLowerCase();
  const n = text.length;
  const bonus = Array.from({ length: n }, (_, j) => MATCH + (isWordStart(text, j) ? WORD_START : 0));
  // prev[j]: best score with the previous query character matched at text index j.
  let prev: (number | null)[] = Array.from({ length: n }, (_, j) => (lower[j] === q[0] ? bonus[j] : null));
  for (let i = 1; i < q.length; i++) {
    const cur: (number | null)[] = new Array(n).fill(null);
    let bestBefore: number | null = null;
    for (let j = 0; j < n; j++) {
      if (lower[j] === q[i]) {
        const consecutive = j > 0 && prev[j - 1] !== null ? (prev[j - 1] as number) + CONSECUTIVE : null;
        const best = Math.max(bestBefore ?? -Infinity, consecutive ?? -Infinity);
        if (best !== -Infinity) cur[j] = best + bonus[j];
      }
      if (prev[j] !== null && (bestBefore === null || (prev[j] as number) > bestBefore)) bestBefore = prev[j];
    }
    prev = cur;
  }
  let result: number | null = null;
  for (const s of prev) if (s !== null && (result === null || s > result)) result = s;
  return result;
}

/**
 * The rows to show for a query. A leading `>` keeps only actions. An empty query lists recents
 * first (most recent first), then everything else in built order; otherwise label matches rank
 * above detail-only matches, each by score, then category, then built order.
 */
export function rankPalette(items: PaletteItem[], query: string, recents: string[]): PaletteItem[] {
  let q = query.trim();
  let pool = items;
  if (q.startsWith('>')) {
    q = q.slice(1).trim();
    pool = items.filter((i) => i.category === 'Action');
  }
  if (q === '') {
    const byId = new Map(pool.map((i) => [i.id, i]));
    const first = recents.flatMap((id) => {
      const item = byId.get(id);
      byId.delete(id);
      return item ? [item] : [];
    });
    const taken = new Set(first.map((i) => i.id));
    return [...first, ...pool.filter((i) => !taken.has(i.id))];
  }
  const scored = pool.flatMap((item, index) => {
    const label = fuzzyScore(q, item.label);
    if (label !== null) return [{ item, index, tier: 0, score: label }];
    const detail = item.detail === undefined ? null : fuzzyScore(q, item.detail);
    return detail !== null ? [{ item, index, tier: 1, score: detail }] : [];
  });
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.score - a.score ||
      CATEGORY_ORDER.indexOf(a.item.category) - CATEGORY_ORDER.indexOf(b.item.category) ||
      a.index - b.index,
  );
  return scored.map((s) => s.item);
}

/** `recents` with `id` first and any older copy removed, capped at `max`. */
export function pushRecent(recents: string[], id: string, max = 10): string[] {
  return [id, ...recents.filter((r) => r !== id)].slice(0, max);
}
