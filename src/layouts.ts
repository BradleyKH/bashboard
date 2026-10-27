import { type SavedPane, type SavedTab, type SavedWorkspace, parseSavedTab } from './savedWorkspace';

/** layouts.json (docs/design.md section 7): one tab, with no Claude session ids and empty scratch pads. */
export interface NamedLayout {
  name: string;
  /** Its name is ignored, since a tab opened from a layout takes the layout's name. */
  tab: SavedTab;
}

function forLayoutPane(p: SavedPane): SavedPane {
  switch (p.kind) {
    case 'terminal':
      return { ...p, sessionId: null };
    case 'scratch':
      return { ...p, scratchId: null };
    case 'files':
    case 'git':
    case 'search':
    case 'containers':
      return p;
  }
}

/** Design 4.11: a layout opens fresh shells and fresh pads. */
function forLayout(tab: SavedTab): SavedTab {
  return { ...tab, name: null, panes: tab.panes.map(forLayoutPane) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** An entry's `tab` (version 2 or 3 shape), or the single tab of a version 1 `workspace` it was saved with. */
function parseEntryTab(entry: Record<string, unknown>): SavedTab | null {
  if (entry.tab !== undefined) return parseSavedTab(entry.tab);
  const ws = entry.workspace;
  return isRecord(ws) && ws.version === 1 ? parseSavedTab(ws) : null;
}

export function parseLayouts(raw: unknown): NamedLayout[] {
  if (!Array.isArray(raw)) return [];
  const out: NamedLayout[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { name } = item;
    if (typeof name !== 'string' || name.trim() === '') continue;
    const trimmed = name.trim();
    if (out.some((l) => l.name.toLowerCase() === trimmed.toLowerCase())) continue;
    const tab = parseEntryTab(item);
    if (!tab) continue;
    out.push({ name: trimmed, tab: forLayout(tab) });
  }
  return out;
}

/** Saves the snapshot's active tab. */
export function layoutFromSnapshot(name: string, snapshot: SavedWorkspace): NamedLayout {
  const tab = snapshot.tabs[snapshot.activeTab] ?? { name: null, panes: [], layout: null, focused: null };
  return { name, tab: forLayout(structuredClone(tab)) };
}

/** Replaces a same-named entry in place (case-insensitive), else appends. */
export function upsertLayout(list: NamedLayout[], layout: NamedLayout): NamedLayout[] {
  const i = list.findIndex((l) => l.name.toLowerCase() === layout.name.toLowerCase());
  if (i < 0) return [...list, layout];
  const out = [...list];
  out[i] = layout;
  return out;
}
