import { describe, expect, it } from 'vitest';
import type { Layout } from './layout';
import { EMPTY_WORKSPACE, parseSavedTab, parseSavedWorkspace, pruneLayout, remapLayout } from './savedWorkspace';

const pane = (paneId: string): Layout => ({ kind: 'pane', paneId });
const row = (a: Layout, b: Layout, ratio = 0.5): Layout => ({ kind: 'split', dir: 'row', ratio, a, b });
const term = (key: string, collapsed = false, sessionId: string | null = null) => ({
  key,
  kind: 'terminal' as const,
  cwd: `/c/${key}`,
  collapsed,
  sessionId,
});
const scratch = (key: string, collapsed = false, scratchId: string | null = null) => ({
  key,
  kind: 'scratch' as const,
  collapsed,
  scratchId,
});
const files = (key: string, collapsed = false, selected: string | null = null) => ({
  key,
  kind: 'files' as const,
  collapsed,
  folder: `/c/${key}`,
  selected,
});
/** A version 1 or 2 `terminals` entry, which has no kind. */
const legacy = (key: string, collapsed = false, sessionId: string | null = null) => ({
  key,
  cwd: `/c/${key}`,
  collapsed,
  sessionId,
});

describe('parseSavedTab', () => {
  it('round-trips a valid tab of both kinds', () => {
    const tab = {
      name: 'Dev',
      panes: [term('a'), scratch('b', false, 'f1e2-d3c4'), term('c', true, 'abc-123'), scratch('d', true)],
      layout: row(pane('a'), pane('b'), 0.3),
      focused: 'b',
    };
    expect(parseSavedTab(tab)).toEqual(tab);
  });

  it('round-trips a Files pane, defaulting selected to null', () => {
    const tab = {
      name: null,
      panes: [files('a', false, '/c/a/readme.md'), files('b', true)],
      layout: pane('a'),
      focused: 'a',
    };
    expect(parseSavedTab(tab)).toEqual(tab);
    const { selected: _s, ...noSel } = files('a');
    expect(parseSavedTab({ panes: [{ ...noSel, selected: 3 }], layout: pane('a'), focused: 'a' })?.panes[0]).toEqual(
      files('a'),
    );
  });

  it('keeps a Files pane root only when it is a string', () => {
    const withRoot = { ...files('a'), folder: '/c/a/sub', root: '/c/a' };
    expect(parseSavedTab({ panes: [withRoot], layout: pane('a'), focused: 'a' })?.panes[0]).toEqual(withRoot);
    expect(parseSavedTab({ panes: [{ ...files('a'), root: 7 }], layout: pane('a'), focused: 'a' })?.panes[0]).toEqual(
      files('a'),
    );
  });

  it('drops a Files pane with no folder', () => {
    const { folder: _f, ...bad } = files('b');
    const r = parseSavedTab({ panes: [term('a'), bad], layout: row(pane('a'), pane('b')), focused: 'a' });
    expect(r?.panes).toEqual([term('a')]);
    expect(r?.layout).toEqual(pane('a'));
  });

  it('round-trips a Git pane and drops one with no root', () => {
    const tab = {
      name: null,
      panes: [{ key: 'a', kind: 'git' as const, collapsed: false, root: '/c/a' }, term('b')],
      layout: row(pane('a'), pane('b')),
      focused: 'a',
    };
    expect(parseSavedTab(tab)).toEqual(tab);
    const r = parseSavedTab({
      panes: [term('a'), { key: 'b', kind: 'git', collapsed: false }],
      layout: row(pane('a'), pane('b')),
      focused: 'a',
    });
    expect(r?.panes).toEqual([term('a')]);
    expect(r?.layout).toEqual(pane('a'));
  });

  it('round-trips a Search pane, defaulting bad options and a missing query, and drops one with no root', () => {
    const search = {
      key: 'a',
      kind: 'search' as const,
      collapsed: false,
      root: '/c/a',
      query: 'todo',
      options: { caseSensitive: true, wholeWord: true, regex: false, include: '*.ts' },
    };
    const tab = { name: null, panes: [search, term('b')], layout: row(pane('a'), pane('b')), focused: 'a' };
    expect(parseSavedTab(tab)).toEqual(tab);

    const loose = parseSavedTab({
      ...tab,
      panes: [{ ...search, query: 7, options: 'bad' }, term('b')],
    });
    expect(loose?.panes[0]).toEqual({
      ...search,
      query: '',
      options: { caseSensitive: false, wholeWord: false, regex: false, include: '' },
    });

    const { root: _r, ...noRoot } = search;
    const r = parseSavedTab({ ...tab, panes: [noRoot, term('b')] });
    expect(r?.panes).toEqual([term('b')]);
    expect(r?.layout).toEqual(pane('b'));
  });

  it('round-trips a Containers pane', () => {
    const tab = {
      name: null,
      panes: [{ key: 'a', kind: 'containers' as const, collapsed: false }, term('b')],
      layout: row(pane('a'), pane('b')),
      focused: 'a',
    };
    expect(parseSavedTab(tab)).toEqual(tab);
  });

  it('reads a version 2 tab of terminals as terminal panes', () => {
    const r = parseSavedTab({
      name: null,
      terminals: [legacy('a'), legacy('b', true, 'abc-1')],
      layout: pane('a'),
      focused: 'a',
    });
    expect(r?.panes).toEqual([term('a'), term('b', true, 'abc-1')]);
  });

  it('rejects a non-object or missing panes and terminals', () => {
    expect(parseSavedTab(null)).toBeNull();
    expect(parseSavedTab([])).toBeNull();
    expect(parseSavedTab({ terminals: 'no' })).toBeNull();
    expect(parseSavedTab({ panes: 'no' })).toBeNull();
    expect(parseSavedTab({ layout: null })).toBeNull();
  });

  it('treats a blank or non-string name as null', () => {
    const base = { panes: [term('a')], layout: pane('a'), focused: 'a' };
    expect(parseSavedTab({ ...base, name: '  ' })?.name).toBeNull();
    expect(parseSavedTab({ ...base, name: 3 })?.name).toBeNull();
    expect(parseSavedTab({ ...base, name: ' Dev ' })?.name).toBe('Dev');
  });

  it('drops malformed and duplicate panes', () => {
    const r = parseSavedTab({
      panes: [
        term('a'),
        { key: 'b', kind: 'terminal' },
        7,
        { ...term('a'), cwd: '/other' },
        { ...term('c'), key: '' },
        { ...scratch('d'), collapsed: 'no' },
      ],
      layout: null,
      focused: null,
    });
    expect(r?.panes).toEqual([{ ...term('a'), collapsed: true }]);
  });

  it('drops a pane of unknown or missing kind and prunes its leaf', () => {
    const r = parseSavedTab({
      panes: [term('a'), { key: 'b', kind: 'telescope', collapsed: false }, legacy('c'), term('d')],
      layout: row(pane('a'), row(pane('b'), row(pane('c'), pane('d')))),
      focused: 'b',
    });
    expect(r?.panes.map((p) => p.key)).toEqual(['a', 'd']);
    expect(r?.layout).toEqual(row(pane('a'), pane('d')));
    expect(r?.focused).toBe('a');
  });

  it('drops a kind named only by an inherited property', () => {
    const r = parseSavedTab({ panes: [{ key: 'a', kind: 'toString', collapsed: false }], layout: null, focused: null });
    expect(r?.panes).toEqual([]);
  });

  it('drops layout leaves with unknown keys and collapses the tree', () => {
    const r = parseSavedTab({
      panes: [term('a'), term('b')],
      layout: row(pane('a'), row(pane('ghost'), pane('b'))),
      focused: 'a',
    });
    expect(r?.layout).toEqual(row(pane('a'), pane('b')));
  });

  it('keeps one leaf for a duplicated key', () => {
    const r = parseSavedTab({
      panes: [term('a'), term('b')],
      layout: row(pane('a'), row(pane('b'), pane('a'))),
      focused: null,
    });
    expect(r?.layout).toEqual(row(pane('b'), pane('a')));
  });

  it('yields a null layout when every leaf is unknown', () => {
    const r = parseSavedTab({
      panes: [term('a')],
      layout: pane('ghost'),
      focused: 'ghost',
    });
    expect(r?.layout).toBeNull();
    expect(r?.focused).toBeNull();
    expect(r?.panes[0].collapsed).toBe(true);
  });

  it('collapses panes absent from the layout and expands those in it', () => {
    const r = parseSavedTab({
      panes: [term('a', false), scratch('b', true), scratch('c', false)],
      layout: pane('b'),
      focused: 'b',
    });
    expect(r?.panes).toEqual([term('a', true), scratch('b', false), scratch('c', true)]);
  });

  it('moves focus to the first leaf unless it names an expanded pane', () => {
    const base = {
      panes: [term('a'), term('b'), term('c', true)],
      layout: row(pane('a'), pane('b')),
    };
    expect(parseSavedTab({ ...base, focused: 'b' })?.focused).toBe('b');
    expect(parseSavedTab({ ...base, focused: 'c' })?.focused).toBe('a');
    expect(parseSavedTab({ ...base, focused: 'zzz' })?.focused).toBe('a');
    expect(parseSavedTab({ ...base, focused: 5 })?.focused).toBe('a');
  });

  it('treats malformed layouts as null without throwing', () => {
    const panes = [term('a'), term('b')];
    const bad: unknown[] = [
      { kind: 'split', dir: 'diagonal', ratio: 0.5, a: pane('a'), b: pane('b') },
      { kind: 'split', dir: 'row', ratio: 1.5, a: pane('a'), b: pane('b') },
      { kind: 'split', dir: 'row', ratio: 0, a: pane('a'), b: pane('b') },
      { kind: 'split', dir: 'row', ratio: 'x', a: pane('a'), b: pane('b') },
      { kind: 'split', dir: 'row', ratio: 0.5, a: pane('a') },
      { kind: 'pane' },
      { kind: 'pane', paneId: 3 },
      { kind: 'blob' },
      'layout',
    ];
    for (const layout of bad) {
      const r = parseSavedTab({ panes, layout, focused: 'a' });
      expect(r?.layout).toBeNull();
      expect(r?.panes.every((p) => p.collapsed)).toBe(true);
    }
  });

  const ids: [unknown, string | null][] = [
    ['0a1B-2c', '0a1B-2c'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['a'.repeat(65), null],
    ['', null],
    ['abc; rm -rf /', null],
    ['abc\n', null],
    ['../x', null],
    ['a b', null],
    [42, null],
    [null, null],
    [undefined, null],
  ];

  it('filters sessionId to the safe alphabet', () => {
    for (const [input, expected] of ids) {
      const r = parseSavedTab({ panes: [{ ...term('a'), sessionId: input }], layout: null, focused: null });
      expect(r?.panes[0]).toMatchObject({ kind: 'terminal', sessionId: expected });
    }
  });

  it('filters scratchId to the same alphabet, keeping the pad', () => {
    for (const [input, expected] of ids) {
      const r = parseSavedTab({ panes: [{ ...scratch('a'), scratchId: input }], layout: null, focused: null });
      expect(r?.panes[0]).toEqual({ ...scratch('a', true), scratchId: expected });
    }
  });
});

describe('remapLayout', () => {
  it('renames leaves and keeps the split structure', () => {
    const layout: Layout = {
      kind: 'split',
      dir: 'column',
      ratio: 0.4,
      a: pane('a'),
      b: row(pane('b'), pane('c'), 0.7),
    };
    const map = new Map([
      ['a', 'p1'],
      ['b', 'p2'],
      ['c', 'p3'],
    ]);
    expect(remapLayout(layout, map)).toEqual({
      kind: 'split',
      dir: 'column',
      ratio: 0.4,
      a: pane('p1'),
      b: row(pane('p2'), pane('p3'), 0.7),
    });
  });

  it('leaves unmapped ids alone and does not mutate the input', () => {
    const layout = row(pane('a'), pane('b'));
    const out = remapLayout(layout, new Map([['a', 'x']]));
    expect(out).toEqual(row(pane('x'), pane('b')));
    expect(layout).toEqual(row(pane('a'), pane('b')));
  });
});

describe('terminal profile', () => {
  const make = (profile: unknown) => ({
    panes: [{ ...term('a'), profile }],
    layout: { kind: 'pane', paneId: 'a' },
    focused: 'a',
  });

  it('keeps a well-formed profile id', () => {
    expect(parseSavedTab(make('pwsh'))?.panes[0]).toMatchObject({ profile: 'pwsh' });
  });

  it('keeps a version 2 terminal profile', () => {
    const r = parseSavedTab({ terminals: [{ ...legacy('a'), profile: 'cmd' }], layout: pane('a'), focused: 'a' });
    expect(r?.panes[0]).toEqual({ ...term('a'), profile: 'cmd' });
  });

  it('drops malformed profile values', () => {
    for (const bad of ['', 'has space', 'x'.repeat(33), 3]) {
      expect(parseSavedTab(make(bad))?.panes[0]).not.toHaveProperty('profile');
    }
  });
});

describe('parseSavedWorkspace', () => {
  const tab = (name: string | null, ...keys: string[]) => ({
    name,
    panes: keys.map((k) => term(k)),
    layout: keys.length === 1 ? pane(keys[0]) : row(pane(keys[0]), pane(keys[1])),
    focused: keys[0],
  });
  const v2tab = (name: string | null, ...keys: string[]) => {
    const { panes: _, ...rest } = tab(name, ...keys);
    return { ...rest, terminals: keys.map((k) => legacy(k)) };
  };
  const v3 = (tabs: unknown[], activeTab: unknown = 0, collapsedSections: unknown = []) => ({
    version: 3,
    tabs,
    activeTab,
    collapsedSections,
  });

  it('round-trips a version 3 workspace with both kinds, names, the active tab, and collapsed sections', () => {
    const ws = {
      version: 3 as const,
      tabs: [
        {
          name: null,
          panes: [term('a', false, 'abc-1'), scratch('b', false, '0f9e-8d7c'), scratch('c', true)],
          layout: row(pane('a'), pane('b')),
          focused: 'b',
        },
        tab('Logs', 'd'),
      ],
      activeTab: 1,
      collapsedSections: ['panes' as const, 'external' as const],
    };
    expect(parseSavedWorkspace(ws)).toEqual(ws);
  });

  it('round-trips a version 3 workspace mixing terminal, scratch, and Files panes', () => {
    const ws = {
      version: 3 as const,
      tabs: [
        {
          name: null,
          panes: [term('a'), scratch('b'), files('c', false, '/c/c/x.txt')],
          layout: row(pane('a'), row(pane('b'), pane('c'))),
          focused: 'c',
        },
      ],
      activeTab: 0,
      collapsedSections: [],
    };
    expect(parseSavedWorkspace(ws)).toEqual(ws);
  });

  it('loads a version 2 workspace as terminal panes with no collapsed sections', () => {
    const r = parseSavedWorkspace({
      version: 2,
      tabs: [v2tab(null, 'a', 'b'), v2tab('Logs', 'c')],
      activeTab: 1,
      collapsedSections: ['panes'],
    });
    expect(r).toEqual({
      version: 3,
      tabs: [tab(null, 'a', 'b'), tab('Logs', 'c')],
      activeTab: 1,
      collapsedSections: [],
    });
  });

  it('keeps a positive dashboard width and drops anything else', () => {
    expect(parseSavedWorkspace({ ...v3([]), dashboardWidth: 420 })?.dashboardWidth).toBe(420);
    for (const bad of [0, -5, 'wide', Number.NaN, null]) {
      expect(parseSavedWorkspace({ ...v3([]), dashboardWidth: bad })).not.toHaveProperty('dashboardWidth');
    }
  });

  it('accepts the empty workspace', () => {
    expect(parseSavedWorkspace(EMPTY_WORKSPACE)).toEqual(EMPTY_WORKSPACE);
  });

  it('rejects unknown versions and wrong shapes', () => {
    expect(parseSavedWorkspace(null)).toBeNull();
    expect(parseSavedWorkspace('x')).toBeNull();
    expect(parseSavedWorkspace([])).toBeNull();
    expect(parseSavedWorkspace({ version: 4, tabs: [], activeTab: 0 })).toBeNull();
    expect(parseSavedWorkspace({ version: '3', tabs: [], activeTab: 0 })).toBeNull();
    expect(parseSavedWorkspace({ version: 3, tabs: 'no', activeTab: 0 })).toBeNull();
    expect(parseSavedWorkspace({ version: 2, tabs: 'no', activeTab: 0 })).toBeNull();
    expect(parseSavedWorkspace({ version: 1, terminals: 'no' })).toBeNull();
  });

  it('filters collapsed sections and defaults them when absent', () => {
    expect(parseSavedWorkspace(v3([tab(null, 'a')], 0, ['repo', 'bogus', 'repo', 7]))?.collapsedSections).toEqual([
      'repo',
    ]);
    expect(parseSavedWorkspace(v3([tab(null, 'a')], 0, 'panes'))?.collapsedSections).toEqual([]);
    expect(parseSavedWorkspace({ version: 3, tabs: [], activeTab: 0 })?.collapsedSections).toEqual([]);
  });

  it('loads a version 1 file as one unnamed tab', () => {
    const v1 = { version: 1, terminals: [legacy('a'), legacy('b', true)], layout: pane('a'), focused: 'a' };
    expect(parseSavedWorkspace(v1)).toEqual({
      version: 3,
      tabs: [{ name: null, panes: [term('a'), term('b', true)], layout: pane('a'), focused: 'a' }],
      activeTab: 0,
      collapsedSections: [],
    });
  });

  it('loads an empty version 1 file as no tabs', () => {
    expect(parseSavedWorkspace({ version: 1, terminals: [], layout: null, focused: null })).toEqual(EMPTY_WORKSPACE);
  });

  it('keeps keys unique across tabs and kinds, dropping later duplicates and their leaves', () => {
    const second = { name: null, panes: [scratch('b'), term('c')], layout: row(pane('b'), pane('c')), focused: 'b' };
    const r = parseSavedWorkspace(v3([tab(null, 'a', 'b'), second]));
    expect(r?.tabs[1]).toEqual({ name: null, panes: [term('c')], layout: pane('c'), focused: 'c' });
  });

  it('keeps a tab of only scratch pads', () => {
    const pads = { name: null, panes: [scratch('a')], layout: pane('a'), focused: 'a' };
    expect(parseSavedWorkspace(v3([pads]))?.tabs).toEqual([pads]);
  });

  it('drops malformed and emptied tabs, keeping the active tab where it can', () => {
    const r = parseSavedWorkspace(
      v3([7, tab(null, 'a'), { name: 'x', panes: [] }, { name: 'y', panes: [{ key: 'z', kind: 'nope', collapsed: false }] }, tab('Keep', 'b')], 4),
    );
    expect(r?.tabs.map((t) => t.panes[0].key)).toEqual(['a', 'b']);
    expect(r?.activeTab).toBe(1);
  });

  it('clamps or defaults a bad activeTab', () => {
    const tabs = [tab(null, 'a'), tab(null, 'b')];
    expect(parseSavedWorkspace(v3(tabs, 9))?.activeTab).toBe(1);
    expect(parseSavedWorkspace(v3(tabs, -2))?.activeTab).toBe(0);
    expect(parseSavedWorkspace(v3(tabs, 0.5))?.activeTab).toBe(0);
    expect(parseSavedWorkspace(v3(tabs, '1'))?.activeTab).toBe(0);
    expect(parseSavedWorkspace({ version: 3, tabs })?.activeTab).toBe(0);
  });

  it('falls back to the previous tab when the active one is dropped', () => {
    const r = parseSavedWorkspace(v3([tab(null, 'a'), { name: null, panes: [] }, tab(null, 'b')], 1));
    expect(r?.activeTab).toBe(0);
  });
});

describe('pruneLayout', () => {
  it('keeps a layout whose keys are all known and drops leaves with unknown keys', () => {
    expect(pruneLayout(row(pane('a'), pane('b')), new Set(['a', 'b']))).toEqual(row(pane('a'), pane('b')));
    expect(pruneLayout(row(pane('a'), pane('b')), new Set(['a']))).toEqual(pane('a'));
  });
});
