import { describe, expect, it } from 'vitest';
import { layoutFromSnapshot, parseLayouts, upsertLayout } from './layouts';
import type { SavedTab, SavedWorkspace } from './savedWorkspace';

const tab = (sessionId: string | null = null, profile?: string, key = 'a'): SavedTab => ({
  name: null,
  panes: [
    { key, kind: 'terminal', cwd: `/c/${key}`, collapsed: false, sessionId, ...(profile ? { profile } : {}) },
  ],
  layout: { kind: 'pane', paneId: key },
  focused: key,
});

/** A tab holding a terminal beside a scratch pad. */
const mixed = (sessionId: string | null, scratchId: string | null): SavedTab => ({
  name: null,
  panes: [
    { key: 'a', kind: 'terminal', cwd: '/c/a', collapsed: false, sessionId },
    { key: 'b', kind: 'scratch', collapsed: false, scratchId },
  ],
  layout: { kind: 'split', dir: 'row', ratio: 0.5, a: { kind: 'pane', paneId: 'a' }, b: { kind: 'pane', paneId: 'b' } },
  focused: 'b',
});

/** The version 2 shape of `tab()`: `terminals` entries with no kind. */
const v2tab = (sessionId: string | null = null, profile?: string) => ({
  name: null,
  terminals: [{ key: 'a', cwd: '/c/a', collapsed: false, sessionId, ...(profile ? { profile } : {}) }],
  layout: { kind: 'pane', paneId: 'a' },
  focused: 'a',
});

const v1 = (sessionId: string | null = null) => ({ version: 1, ...v2tab(sessionId), name: undefined });

describe('parseLayouts', () => {
  it('keeps a Files pane folder and selection', () => {
    const t: SavedTab = {
      name: null,
      panes: [{ key: 'a', kind: 'files', collapsed: false, folder: '/c/a', selected: '/c/a/x.md' }],
      layout: { kind: 'pane', paneId: 'a' },
      focused: 'a',
    };
    expect(parseLayouts([{ name: 'Dev', tab: t }])).toEqual([{ name: 'Dev', tab: t }]);
  });

  it('keeps a Git pane root', () => {
    const t: SavedTab = {
      name: null,
      panes: [{ key: 'a', kind: 'git', collapsed: false, root: '/c/a' }],
      layout: { kind: 'pane', paneId: 'a' },
      focused: 'a',
    };
    expect(parseLayouts([{ name: 'Dev', tab: t }])).toEqual([{ name: 'Dev', tab: t }]);
  });

  it('keeps a Search pane root, query, and options', () => {
    const t: SavedTab = {
      name: null,
      panes: [
        {
          key: 'a',
          kind: 'search',
          collapsed: false,
          root: '/c/a',
          query: 'todo',
          options: { caseSensitive: true, wholeWord: false, regex: true, include: '*.ts' },
        },
      ],
      layout: { kind: 'pane', paneId: 'a' },
      focused: 'a',
    };
    expect(parseLayouts([{ name: 'Dev', tab: t }])).toEqual([{ name: 'Dev', tab: t }]);
  });

  it('keeps a Containers pane as is', () => {
    const t: SavedTab = {
      name: null,
      panes: [{ key: 'a', kind: 'containers', collapsed: false }],
      layout: { kind: 'pane', paneId: 'a' },
      focused: 'a',
    };
    expect(parseLayouts([{ name: 'Dev', tab: t }])).toEqual([{ name: 'Dev', tab: t }]);
  });

  it('returns [] for non-arrays', () => {
    expect(parseLayouts(null)).toEqual([]);
    expect(parseLayouts({})).toEqual([]);
  });

  it('keeps valid entries and the profile, and forces sessionId to null', () => {
    const out = parseLayouts([{ name: 'Dev', tab: tab('abc-1', 'pwsh') }]);
    expect(out).toEqual([{ name: 'Dev', tab: tab(null, 'pwsh') }]);
  });

  it('keeps scratch pads empty', () => {
    const out = parseLayouts([{ name: 'Dev', tab: mixed('abc-1', 'f00d-1') }]);
    expect(out).toEqual([{ name: 'Dev', tab: mixed(null, null) }]);
  });

  it('reads a version 2 tab of terminals', () => {
    const out = parseLayouts([{ name: 'Dev', tab: v2tab('abc-1', 'cmd') }]);
    expect(out).toEqual([{ name: 'Dev', tab: tab(null, 'cmd') }]);
  });

  it('ignores a saved tab name, since the tab takes the layout name', () => {
    const out = parseLayouts([{ name: 'Dev', tab: { ...tab(), name: 'Other' } }]);
    expect(out[0].tab.name).toBeNull();
  });

  it('loads a legacy entry whose workspace is version 1 as that one tab', () => {
    const out = parseLayouts([{ name: 'Old', workspace: v1('abc-1') }]);
    expect(out).toEqual([{ name: 'Old', tab: tab() }]);
  });

  it('drops blank names and rejected tabs or workspaces', () => {
    const out = parseLayouts([
      { name: '  ', tab: tab() },
      { name: 'Bad', workspace: { version: 2, tabs: [], activeTab: 0 } },
      { name: 'BadTab', tab: { terminals: 'no' } },
      { name: 'BadPanes', tab: { panes: 'no' } },
      { name: 'NoTab' },
      'junk',
      { name: 'Ok', tab: tab() },
    ]);
    expect(out.map((l) => l.name)).toEqual(['Ok']);
  });

  it('keeps the first of duplicate names, case-insensitively', () => {
    const out = parseLayouts([
      { name: 'Dev', tab: tab(null, 'cmd') },
      { name: 'dev', tab: tab() },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].tab.panes[0]).toMatchObject({ profile: 'cmd' });
  });
});

describe('layoutFromSnapshot', () => {
  const snap = (): SavedWorkspace => ({
    version: 3,
    tabs: [{ ...tab(null, undefined, 'a'), name: 'First' }, mixed('abc-1', 'f00d-1')],
    activeTab: 1,
    collapsedSections: [],
  });

  it('saves the active tab, emptying session and scratch ids without touching the snapshot', () => {
    const s = snap();
    const layout = layoutFromSnapshot('Dev', s);
    expect(layout.tab).toEqual(mixed(null, null));
    expect(s.tabs[1]).toEqual(mixed('abc-1', 'f00d-1'));
    expect(layout.tab).not.toBe(s.tabs[1]);
  });

  it('drops the tab name', () => {
    const s = { ...snap(), activeTab: 0 };
    expect(layoutFromSnapshot('Dev', s).tab.name).toBeNull();
  });

  it('saves an empty tab when the snapshot has none', () => {
    const s: SavedWorkspace = { version: 3, tabs: [], activeTab: 0, collapsedSections: [] };
    expect(layoutFromSnapshot('Dev', s).tab).toEqual({ name: null, panes: [], layout: null, focused: null });
  });
});

describe('upsertLayout', () => {
  const a = { name: 'A', tab: tab() };
  const b = { name: 'B', tab: tab() };

  it('appends a new name', () => {
    expect(upsertLayout([a], b)).toEqual([a, b]);
  });

  it('replaces a same-named entry in place', () => {
    const a2 = { name: 'a', tab: tab(null, 'cmd') };
    expect(upsertLayout([a, b], a2)).toEqual([a2, b]);
  });
});
