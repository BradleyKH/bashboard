import { type DashboardSection, parseCollapsedSections } from './dashboardSections';
import { type Layout, close, leaves } from './layout';
import type { PaneKind } from './paneKinds';
import { parseProfileId } from './profiles';
import { type SearchOptions, parseSearchOptions } from './searchOptions';

/** One pane (docs/design.md sections 4.11 and 7). Pane ids do not survive a restart, so entries use saved keys. */
export type SavedPane = { key: string; collapsed: boolean } & (
  | {
      kind: 'terminal';
      cwd: string;
      sessionId: string | null;
      /** Shell profile id; absent means the default profile. */
      profile?: string;
    }
  /** null in layouts, which open fresh pads. */
  | { kind: 'scratch'; scratchId: string | null }
  /**
   * `selected` is the previewed file's absolute path. `root` is the repo the pane was opened
   * for, which can be an ancestor of `folder`; absent, it resolves from `folder`.
   */
  | { kind: 'files'; folder: string; selected: string | null; root?: string }
  /** `root` is the repo root the pane shows. */
  | { kind: 'git'; root: string }
  /** `root` is the repo root the pane searches. */
  | { kind: 'search'; root: string; query: string; options: SearchOptions }
  /** The Containers pane saves no state; its containers come from the engines. */
  | { kind: 'containers' }
);

export type SavedTerminalPane = Extract<SavedPane, { kind: 'terminal' }>;

export function isTerminalPane(p: SavedPane): p is SavedTerminalPane {
  return p.kind === 'terminal';
}

/** One tab (docs/design.md sections 4.10 and 7). Layout leaves hold pane keys. */
export interface SavedTab {
  /** A name the user or a layout fixed; null follows the focused pane's title. */
  name: string | null;
  panes: SavedPane[];
  layout: Layout | null;
  focused: string | null;
}

/** workspace.json (docs/design.md sections 3.7 and 7), tabs in strip order. */
export interface SavedWorkspace {
  version: 3;
  tabs: SavedTab[];
  /** Index into tabs. */
  activeTab: number;
  /** Dashboard sections collapsed by the user. */
  collapsedSections: DashboardSection[];
  /** The dashboard's width in px as the user last dragged it; absent means the default. */
  dashboardWidth?: number;
}

export const EMPTY_WORKSPACE: SavedWorkspace = { version: 3, tabs: [], activeTab: 0, collapsedSections: [] };

// Restore types the id into a shell, so anything beyond this alphabet is dropped. Scratch ids
// name files in the core, so they share it.
const SESSION_ID = /^[0-9A-Za-z-]{1,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeId(v: unknown): string | null {
  return typeof v === 'string' && SESSION_ID.test(v) ? v : null;
}

type PaneBase = { key: string; collapsed: boolean };

/** One parser per kind; a kind missing here is dropped on load. */
const PANE_PARSERS: Record<PaneKind, (raw: Record<string, unknown>, base: PaneBase) => SavedPane | null> = {
  terminal: (raw, base) => {
    if (typeof raw.cwd !== 'string') return null;
    const profileId = parseProfileId(raw.profile);
    return {
      ...base,
      kind: 'terminal',
      cwd: raw.cwd,
      sessionId: safeId(raw.sessionId),
      ...(profileId ? { profile: profileId } : {}),
    };
  },
  scratch: (raw, base) => ({ ...base, kind: 'scratch', scratchId: safeId(raw.scratchId) }),
  files: (raw, base) => {
    if (typeof raw.folder !== 'string') return null;
    return {
      ...base,
      kind: 'files',
      folder: raw.folder,
      selected: typeof raw.selected === 'string' ? raw.selected : null,
      ...(typeof raw.root === 'string' && { root: raw.root }),
    };
  },
  git: (raw, base) => {
    if (typeof raw.root !== 'string') return null;
    return { ...base, kind: 'git', root: raw.root };
  },
  search: (raw, base) => {
    if (typeof raw.root !== 'string') return null;
    return {
      ...base,
      kind: 'search',
      root: raw.root,
      query: typeof raw.query === 'string' ? raw.query : '',
      options: parseSearchOptions(raw.options),
    };
  },
  containers: (_raw, base) => ({ ...base, kind: 'containers' }),
};

/** `kind` overrides the entry's own, for version 1 and 2 `terminals` entries, which have none. */
function parsePane(raw: unknown, kind?: PaneKind): SavedPane | null {
  if (!isRecord(raw)) return null;
  const { key, collapsed } = raw;
  if (typeof key !== 'string' || key === '' || typeof collapsed !== 'boolean') return null;
  const k = kind ?? raw.kind;
  if (typeof k !== 'string' || !Object.prototype.hasOwnProperty.call(PANE_PARSERS, k)) return null;
  return PANE_PARSERS[k as PaneKind](raw, { key, collapsed });
}

function parseLayout(raw: unknown): Layout | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === 'pane') {
    return typeof raw.paneId === 'string' ? { kind: 'pane', paneId: raw.paneId } : null;
  }
  if (raw.kind !== 'split') return null;
  const { dir, ratio } = raw;
  if (dir !== 'row' && dir !== 'column') return null;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return null;
  const a = parseLayout(raw.a);
  const b = parseLayout(raw.b);
  return a && b ? { kind: 'split', dir, ratio, a, b } : null;
}

/** Drops leaves naming unknown keys, and all but one leaf per duplicated key. */
export function pruneLayout(layout: Layout, keys: Set<string>): Layout | null {
  let tree: Layout | null = layout;
  for (;;) {
    if (!tree) return null;
    const ls = leaves(tree);
    const bad = ls.find((k, i) => !keys.has(k) || ls.indexOf(k) !== i);
    if (bad === undefined) return tree;
    tree = close(tree, bad);
  }
}

/**
 * Repairs one tab: a version 3 tab's `panes`, or the `terminals` of a version 2 tab or of a
 * version 1 file's top level, as terminal panes. Keys already in `taken` are dropped, so keys
 * stay unique across tabs; the tab's keys are added to it. Null only for a non-object or one
 * with neither array.
 */
export function parseSavedTab(raw: unknown, taken: Set<string> = new Set()): SavedTab | null {
  if (!isRecord(raw)) return null;
  const v3 = Array.isArray(raw.panes);
  const items: unknown = v3 ? raw.panes : raw.terminals;
  if (!Array.isArray(items)) return null;
  const kind: PaneKind | undefined = v3 ? undefined : 'terminal';

  const panes: SavedPane[] = [];
  const keys = new Set<string>();
  for (const item of items) {
    const p = parsePane(item, kind);
    if (!p || keys.has(p.key) || taken.has(p.key)) continue;
    keys.add(p.key);
    panes.push(p);
  }
  for (const k of keys) taken.add(k);

  const parsed = raw.layout == null ? null : parseLayout(raw.layout);
  const layout = parsed ? pruneLayout(parsed, keys) : null;
  const inLayout = new Set(layout ? leaves(layout) : []);
  const repaired = panes.map((p) => ({ ...p, collapsed: !inLayout.has(p.key) }));

  const focused =
    typeof raw.focused === 'string' && inLayout.has(raw.focused)
      ? raw.focused
      : layout
        ? leaves(layout)[0]
        : null;

  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null;
  return { name, panes: repaired, layout, focused };
}

/**
 * Repairs what it can; null only for an unknown version or a non-object. Versions 1 and 2 load
 * as version 3, with no collapsed sections; a version 1 file loads as one unnamed tab. Tabs
 * with no panes are dropped, and `activeTab` follows its tab through the drops or is clamped
 * into range.
 */
export function parseSavedWorkspace(raw: unknown): SavedWorkspace | null {
  if (!isRecord(raw)) return null;
  if (raw.version === 1) {
    const tab = parseSavedTab({ ...raw, name: null });
    if (!tab) return null;
    return { version: 3, tabs: tab.panes.length > 0 ? [tab] : [], activeTab: 0, collapsedSections: [] };
  }
  if ((raw.version !== 2 && raw.version !== 3) || !Array.isArray(raw.tabs)) return null;

  const wanted =
    typeof raw.activeTab === 'number' && Number.isInteger(raw.activeTab) ? raw.activeTab : 0;
  const taken = new Set<string>();
  const tabs: SavedTab[] = [];
  let activeTab = 0;
  raw.tabs.forEach((item, i) => {
    const tab = parseSavedTab(item, taken);
    if (!tab || tab.panes.length === 0) return;
    if (i <= wanted) activeTab = tabs.length;
    tabs.push(tab);
  });
  const collapsedSections = raw.version === 3 ? parseCollapsedSections(raw.collapsedSections) : [];
  const saved: SavedWorkspace = { version: 3, tabs, activeTab, collapsedSections };
  if (typeof raw.dashboardWidth === 'number' && Number.isFinite(raw.dashboardWidth) && raw.dashboardWidth > 0) {
    saved.dashboardWidth = raw.dashboardWidth;
  }
  return saved;
}

/** Renames every leaf by `map`; leaves missing from the map keep their id. */
export function remapLayout(layout: Layout, map: Map<string, string>): Layout {
  if (layout.kind === 'pane') return { kind: 'pane', paneId: map.get(layout.paneId) ?? layout.paneId };
  return {
    ...layout,
    a: remapLayout(layout.a, map),
    b: remapLayout(layout.b, map),
  };
}
