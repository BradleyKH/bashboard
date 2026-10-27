import { describe, expect, it } from 'vitest';
import type { Layout } from './layout';
import { restoredTab, snapshotTabs } from './savedTabs';
import type { SavedPane, SavedTab } from './savedWorkspace';
import type { TabsState } from './tabs';

const pane = (paneId: string): Layout => ({ kind: 'pane', paneId });
const row = (a: Layout, b: Layout): Layout => ({ kind: 'split', dir: 'row', ratio: 0.5, a, b });
const term = (key: string, collapsed = false): SavedPane => ({
  key,
  kind: 'terminal',
  cwd: `/c/${key}`,
  collapsed,
  sessionId: null,
});
const scratch = (key: string, collapsed = false): SavedPane => ({ key, kind: 'scratch', collapsed, scratchId: null });

describe('restoredTab', () => {
  const saved: SavedTab = {
    name: 'Dev',
    panes: [term('a'), term('b', true), scratch('c')],
    layout: row(pane('a'), pane('c')),
    focused: 'c',
  };

  it('rebuilds the tree, collapsed list, order, and focus around new ids', () => {
    let n = 10;
    const { tab, ids } = restoredTab(saved, 't3', 'Dev', () => `p${n++}`);
    expect([...ids]).toEqual([
      ['a', 'p10'],
      ['b', 'p11'],
      ['c', 'p12'],
    ]);
    expect(tab).toEqual({
      id: 't3',
      name: 'Dev',
      tree: row(pane('p10'), pane('p12')),
      focusedId: 'p12',
      collapsed: ['p11'],
      panes: ['p10', 'p11', 'p12'],
    });
  });

  it('hands each pane to takeId, so ids can differ by kind', () => {
    let p = 1;
    let v = 1;
    const { tab } = restoredTab(saved, 't1', null, (s) => (s.kind === 'terminal' ? `p${p++}` : `v${v++}`));
    expect(tab.panes).toEqual(['p1', 'p2', 'v1']);
    expect(tab.tree).toEqual(row(pane('p1'), pane('v1')));
    expect(tab.focusedId).toBe('v1');
  });

  it('focuses the first leaf without a saved focus, and nothing without a layout', () => {
    let n = 1;
    const next = () => `p${n++}`;
    expect(restoredTab({ ...saved, focused: null }, 't1', null, next).tab.focusedId).toBe('p1');
    const allCollapsed = { ...saved, layout: null, panes: saved.panes.map((p) => ({ ...p, collapsed: true })) };
    expect(restoredTab(allCollapsed, 't2', null, next).tab.focusedId).toBe('');
  });
});

describe('snapshotTabs', () => {
  const state: TabsState = {
    tabs: [
      { id: 't1', name: null, tree: row(pane('p1'), pane('v1')), focusedId: 'p1', collapsed: ['p2'], panes: ['p1', 'p2', 'v1'] },
      { id: 't2', name: 'Gone', tree: pane('p3'), focusedId: 'p3', collapsed: [], panes: ['p3'] },
      { id: 't3', name: 'Logs', tree: null, focusedId: '', collapsed: ['p4'], panes: ['p4'] },
    ],
    activeId: 't3',
  };
  const live = new Set(['p1', 'p2', 'p4', 'v1']);
  const save = (id: string, collapsed: boolean): SavedPane | null =>
    !live.has(id)
      ? null
      : id.startsWith('v')
        ? { key: id, kind: 'scratch', collapsed, scratchId: `s-${id}` }
        : { key: id, kind: 'terminal', cwd: `/c/${id}`, collapsed, sessionId: null };

  it('saves every tab in order with its name, layout, and focus, skipping gone panes and empty tabs', () => {
    expect(snapshotTabs(state, save, ['favorites'])).toEqual({
      version: 3,
      tabs: [
        {
          name: null,
          panes: [
            { key: 'p1', kind: 'terminal', cwd: '/c/p1', collapsed: false, sessionId: null },
            { key: 'p2', kind: 'terminal', cwd: '/c/p2', collapsed: true, sessionId: null },
            { key: 'v1', kind: 'scratch', collapsed: false, scratchId: 's-v1' },
          ],
          layout: row(pane('p1'), pane('v1')),
          focused: 'p1',
        },
        {
          name: 'Logs',
          panes: [{ key: 'p4', kind: 'terminal', cwd: '/c/p4', collapsed: true, sessionId: null }],
          layout: null,
          focused: null,
        },
      ],
      activeTab: 1,
      collapsedSections: ['favorites'],
    });
  });

  it('prunes the layout and focus of a pane the callback skips', () => {
    const shell: TabsState = {
      tabs: [{ id: 't1', name: null, tree: row(pane('p1'), pane('p9')), focusedId: 'p9', collapsed: [], panes: ['p1', 'p9'] }],
      activeId: 't1',
    };
    const saved = snapshotTabs(shell, (id, collapsed) => (id === 'p9' ? null : save(id, collapsed)));
    expect(saved.tabs[0].layout).toEqual(pane('p1'));
    expect(saved.tabs[0].focused).toBe('p1');
  });

  it('saves no layout when every laid-out pane is skipped but a collapsed one remains', () => {
    const shell: TabsState = {
      tabs: [{ id: 't1', name: null, tree: pane('p9'), focusedId: 'p9', collapsed: ['p1'], panes: ['p1', 'p9'] }],
      activeId: 't1',
    };
    const saved = snapshotTabs(shell, (id, collapsed) => (id === 'p9' ? null : save(id, collapsed)));
    expect(saved.tabs[0]).toMatchObject({ layout: null, focused: null });
  });

  it('saves an empty workspace when nothing is left', () => {
    expect(snapshotTabs(state, () => null)).toEqual({ version: 3, tabs: [], activeTab: 0, collapsedSections: [] });
  });
});
