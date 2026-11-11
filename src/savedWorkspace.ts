import {
  type DashboardElement,
  type DashboardSection,
  DEFAULT_ELEMENT_ORDER,
  parseCollapsedSections,
  parseSectionOrder,
  parseTopElements,
  placeElement,
} from './dashboardSections';
import { type DashboardColumn, parsePinsColumn, parseRightElements } from './dashboardColumns';
import { type Layout, close, leaves } from './layout';
import type { ShipTab } from './shipModel';
import type { GitTab } from './gitBranchModel';
import type { PaneKind } from './paneKinds';
import { normalizeDevtools, type DevtoolsState } from './browserPaneModel';
import { parseFilesSort, type FilesSort } from './filesModel';
import { parseProfileId } from './profiles';
import { type SearchOptions, parseSearchOptions } from './searchOptions';
import { type TextZoom, parseTextZoom } from './textZoomStore';

/** A coding agent Bashboard can resume; absent or unknown in a saved pane reads as Claude. */
export type AgentId = 'claude' | 'codex' | 'copilot';

const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'copilot'];

function parseAgent(v: unknown): AgentId {
  return AGENT_IDS.includes(v as AgentId) ? (v as AgentId) : 'claude';
}

/** One pane (docs/design/workspace.md sections 4.11 and 7). Pane ids do not survive a restart, so entries use saved keys. */
export type SavedPane = { key: string; collapsed: boolean } & (
  | {
      kind: 'terminal';
      cwd: string;
      sessionId: string | null;
      /** The session's last reported permission mode, passed back to `--resume`; absent means default. */
      permissionMode?: string;
      /** The agent that owns `sessionId`; absent means Claude. */
      agent?: AgentId;
      /** The model to pass back on resume, for agents that drop it otherwise; absent means none. */
      resumeModel?: string;
      /** Shell profile id; absent means the default profile. */
      profile?: string;
      /** Names the file holding the terminal's scrollback as the window last closed; absent in layouts. */
      scrollbackId?: string;
    }
  /** null in layouts, which open fresh pads. */
  | { kind: 'scratch'; scratchId: string | null }
  /**
   * `selected` is the previewed file's absolute path. `root` is the repo the pane was opened
   * for, which can be an ancestor of `folder`; absent, it resolves from `folder`. `expanded` is
   * whether the preview filled the pane; absent means false.
   */
  | {
      kind: 'files';
      folder: string;
      selected: string | null;
      root?: string;
      expanded?: boolean;
      sort?: FilesSort;
    }
  /** `root` is the repo root the pane shows; `tab` is the open tab, absent meaning Changes. */
  | { kind: 'git'; root: string; tab?: GitTab }
  /**
   * `root` is the drilled-in target, a local repo root or a `remote:<host>/<owner>/<name>` key;
   * absent means the pane is on Overview. `tab` is the open tab, absent meaning Pipelines;
   * `thisBranch` is whether Pipelines lists only the checked-out branch, absent meaning false;
   * `thisBranchPulls` is the same for Pull requests, matching the source branch;
   * `allPulls` is whether Pull requests lists every state, absent meaning open ones only. The
   * last four mean nothing on Overview.
   */
  | {
      kind: 'ship';
      root?: string;
      tab?: ShipTab;
      thisBranch?: boolean;
      thisBranchPulls?: boolean;
      allPulls?: boolean;
    }
  /** `root` is the repo root the pane searches. */
  | { kind: 'search'; root: string; query: string; options: SearchOptions }
  /** The Containers pane saves no state; its containers come from the engines. */
  | { kind: 'containers' }
  /** The Ports pane saves no state; its ports come from the OS. */
  | { kind: 'ports' }
  /** `url` is the page, null on the start page; `device` is a preset id, with `:rotated` when on its side. */
  | { kind: 'browser'; url: string | null; devtools: DevtoolsState; device: string }
);

export type SavedTerminalPane = Extract<SavedPane, { kind: 'terminal' }>;

export function isTerminalPane(p: SavedPane): p is SavedTerminalPane {
  return p.kind === 'terminal';
}

/** One tab (docs/design/workspace.md sections 4.10 and 7). Layout leaves hold pane keys. */
export interface SavedTab {
  /** A name the user or a layout fixed; null follows the focused pane's title. */
  name: string | null;
  panes: SavedPane[];
  layout: Layout | null;
  focused: string | null;
}

/** workspace.json (docs/design/data.md sections 3.7 and 7), tabs in strip order. */
export interface SavedWorkspace {
  version: 3;
  tabs: SavedTab[];
  /** Index into tabs. */
  activeTab: number;
  /** Dashboard sections collapsed by the user. */
  collapsedSections: DashboardSection[];
  /** The dashboard's width in px as the user last dragged it; absent means the default. */
  dashboardWidth?: number;
  /** The dashboard's element order as last dragged; absent means the default order. */
  dashboardSectionOrder?: DashboardElement[];
  /** The elements in the dashboard's slot above Pins; absent means the clock and Folder. */
  dashboardTopElements?: DashboardElement[];
  /** The elements in the dashboard's right column; absent means not yet split into columns. */
  dashboardRightElements?: DashboardElement[];
  /** The dashboard column holding Pins; absent means the left. */
  dashboardPinsColumn?: DashboardColumn;
  /** Whether the dashboard's Panes cards show folder paths; absent means hidden. */
  showPanePaths?: boolean;
  /** Whether the dashboard's Panes section shows only AI session terminals; absent means every pane. */
  agentPanesOnly?: boolean;
  /** Whether the dashboard's Containers section hides fully stopped groups; absent means shown. */
  hideStoppedContainers?: boolean;
  /** Whether the dashboard's Pins section leaves out global pins, which the top bar's pin menu then lists; absent means shown. */
  hideGlobalPins?: boolean;
  /** Whether hiding the dashboard with × has shown its notice; absent means not yet. */
  dashboardHideNoticeShown?: boolean;
  /** The zoom new Files, Git, Search, Scratch, and Containers panes start at; absent means 1 for each. */
  textZoom?: TextZoom;
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

// Typed into a shell like the session id, so it is held to letters.
const PERMISSION_MODE = /^[A-Za-z]{1,32}$/;

function safeMode(v: unknown): string | undefined {
  return typeof v === 'string' && PERMISSION_MODE.test(v) ? v : undefined;
}

// Typed into a shell like the session id, so it is held to what model names use.
const RESUME_MODEL = /^[A-Za-z0-9._:/-]{1,100}$/;

export function safeModel(v: unknown): string | undefined {
  return typeof v === 'string' && RESUME_MODEL.test(v) ? v : undefined;
}

/**
 * The command restore types to resume a session. Claude resumes in its saved permission mode
 * unless that is the default; Copilot resumes in `model` when one was saved.
 */
export function resumeCommand(
  sessionId: string,
  permissionMode: string | undefined,
  agent: AgentId = 'claude',
  model?: string,
): string {
  switch (agent) {
    case 'codex':
      return `codex resume ${sessionId}`;
    case 'copilot': {
      // Space-separated because `--resume=<id>` exits at once on Windows (github/copilot-cli#3458);
      // `--model` because a resumed session silently falls back to the default model (#4397).
      const m = safeModel(model);
      return m ? `copilot --resume ${sessionId} --model ${m}` : `copilot --resume ${sessionId}`;
    }
    default: {
      const mode = safeMode(permissionMode);
      return mode && mode !== 'default'
        ? `claude --resume ${sessionId} --permission-mode ${mode}`
        : `claude --resume ${sessionId}`;
    }
  }
}

type PaneBase = { key: string; collapsed: boolean };

/** One parser per kind; a kind missing here is dropped on load. */
const PANE_PARSERS: Record<PaneKind, (raw: Record<string, unknown>, base: PaneBase) => SavedPane | null> = {
  terminal: (raw, base) => {
    if (typeof raw.cwd !== 'string') return null;
    const profileId = parseProfileId(raw.profile);
    const sessionId = safeId(raw.sessionId);
    const permissionMode = sessionId ? safeMode(raw.permissionMode) : undefined;
    const scrollbackId = safeId(raw.scrollbackId);
    const agent = parseAgent(raw.agent);
    const resumeModel = sessionId ? safeModel(raw.resumeModel) : undefined;
    return {
      ...base,
      kind: 'terminal',
      cwd: raw.cwd,
      sessionId,
      ...(permissionMode ? { permissionMode } : {}),
      ...(agent !== 'claude' ? { agent } : {}),
      ...(resumeModel ? { resumeModel } : {}),
      ...(profileId ? { profile: profileId } : {}),
      ...(scrollbackId ? { scrollbackId } : {}),
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
      ...(typeof raw.expanded === 'boolean' && { expanded: raw.expanded }),
      ...(raw.sort !== undefined && { sort: parseFilesSort(raw.sort) }),
    };
  },
  git: (raw, base) => {
    if (typeof raw.root !== 'string') return null;
    return {
      ...base,
      kind: 'git',
      root: raw.root,
      ...(raw.tab === 'branches' && { tab: 'branches' as const }),
    };
  },
  ship: (raw, base) => {
    // An empty root is how a pane with no target was once saved, so it reads as Overview too.
    const root = typeof raw.root === 'string' && raw.root !== '' ? raw.root : undefined;
    return {
      ...base,
      kind: 'ship',
      ...(root !== undefined && { root }),
      ...(raw.tab === 'pulls' && { tab: 'pulls' as const }),
      ...(raw.thisBranch === true && { thisBranch: true }),
      ...(raw.thisBranchPulls === true && { thisBranchPulls: true }),
      ...(raw.allPulls === true && { allPulls: true }),
    };
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
  ports: (_raw, base) => ({ ...base, kind: 'ports' }),
  browser: (raw, base) => ({
    ...base,
    kind: 'browser',
    url: typeof raw.url === 'string' && raw.url !== '' ? raw.url : null,
    devtools: normalizeDevtools(isRecord(raw.devtools) ? (raw.devtools as Partial<DevtoolsState>) : null),
    device: typeof raw.device === 'string' ? raw.device : '',
  }),
};

/** `kind` overrides the entry's own, for version 1 and 2 `terminals` entries, which have none. */
function parsePane(raw: unknown, kind?: PaneKind): SavedPane | null {
  if (!isRecord(raw)) return null;
  const { key, collapsed } = raw;
  if (typeof key !== 'string' || key === '' || typeof collapsed !== 'boolean') return null;
  // Ship panes were saved as kind 'forge' before the rename; read them as Ship so layouts survive.
  const k = kind ?? (raw.kind === 'forge' ? 'ship' : raw.kind);
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
  if (raw.dashboardSectionOrder !== undefined) {
    saved.dashboardSectionOrder = parseSectionOrder(raw.dashboardSectionOrder);
  }
  const top = parseTopElements(raw.dashboardTopElements);
  if (top) saved.dashboardTopElements = top;
  // Files saved before any element but the clock could sit in the top slot hold only this flag.
  else if (typeof raw.dashboardClockTop === 'boolean') saved.dashboardTopElements = raw.dashboardClockTop ? ['clock'] : [];
  // Files saved before Launch was an element had its section fixed below the top slot, so it
  // joins the top slot last, where it was. `folder` and `repo` are its earlier names.
  const placed = [raw.dashboardSectionOrder, raw.dashboardTopElements].some(
    (l) => Array.isArray(l) && ['launch', 'folder', 'repo'].some((name) => l.includes(name)),
  );
  if (!placed && saved.dashboardTopElements) {
    const order = saved.dashboardSectionOrder ?? [...DEFAULT_ELEMENT_ORDER];
    const next = placeElement(order, saved.dashboardTopElements, 'launch', 'top', null);
    saved.dashboardSectionOrder = next.order;
    saved.dashboardTopElements = next.top;
  }
  const right = parseRightElements(raw.dashboardRightElements);
  if (right) saved.dashboardRightElements = right;
  const pinsColumn = parsePinsColumn(raw.dashboardPinsColumn);
  if (pinsColumn) saved.dashboardPinsColumn = pinsColumn;
  if (typeof raw.showPanePaths === 'boolean') saved.showPanePaths = raw.showPanePaths;
  if (raw.agentPanesOnly === true) saved.agentPanesOnly = true;
  if (raw.hideStoppedContainers === true) saved.hideStoppedContainers = true;
  if (raw.hideGlobalPins === true) saved.hideGlobalPins = true;
  if (raw.dashboardHideNoticeShown === true) saved.dashboardHideNoticeShown = true;
  if (isRecord(raw.textZoom)) saved.textZoom = parseTextZoom(raw.textZoom);
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
