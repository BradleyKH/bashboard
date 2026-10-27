import { describe, expect, it } from 'vitest';
import type { Layout } from './layout';
import { TabStore } from './tabStore';

const pane = (paneId: string): Layout => ({ kind: 'pane', paneId });
const row = (a: Layout, b: Layout): Layout => ({ kind: 'split', dir: 'row', ratio: 0.5, a, b });

/** Two tabs: t1 holds p1 and p2 side by side plus collapsed p3; t2 (active) holds p4. */
function twoTabs(): TabStore {
  const store = new TabStore();
  store.state = {
    tabs: [
      { id: 't1', name: null, tree: row(pane('p1'), pane('p2')), focusedId: 'p2', collapsed: ['p3'], panes: ['p1', 'p2', 'p3'] },
      { id: 't2', name: null, tree: pane('p4'), focusedId: 'p4', collapsed: [], panes: ['p4'] },
    ],
    activeId: 't2',
  };
  return store;
}

describe('TabStore', () => {
  it('starts with one empty active tab', () => {
    const store = new TabStore();
    expect(store.state.tabs).toHaveLength(1);
    expect(store.active).toMatchObject({ tree: null, focusedId: '', panes: [] });
  });

  it('reads and writes the active tab through tree and focusedId', () => {
    const store = twoTabs();
    store.tree = null;
    store.focusedId = '';
    expect(store.find('t2')).toMatchObject({ tree: null, focusedId: '' });
    expect(store.find('t1')?.tree).toEqual(row(pane('p1'), pane('p2')));
  });

  it('records new panes in the active tab only', () => {
    const store = twoTabs();
    store.addToActive('p5', true);
    expect(store.find('t2')).toMatchObject({ panes: ['p4', 'p5'], collapsed: ['p5'] });
  });

  it('tracks collapsed panes per tab', () => {
    const store = twoTabs();
    expect(store.isCollapsed('p3')).toBe(true);
    store.setCollapsed('p3', false);
    store.setCollapsed('p1', true);
    expect(store.find('t1')?.collapsed).toEqual(['p1']);
  });

  it('removes a leaf from a background tab and moves that tab focus', () => {
    const store = twoTabs();
    expect(store.removeFromTree('p2')).toBe(true);
    expect(store.find('t1')).toMatchObject({ tree: pane('p1'), focusedId: 'p1' });
    expect(store.removeFromTree('p3')).toBe(false);
  });

  it('moves a docked pane from another tab into the active one', () => {
    const store = twoTabs();
    store.moveToActive('p1');
    expect(store.find('t1')).toMatchObject({ tree: pane('p2'), focusedId: 'p2', panes: ['p2', 'p3'] });
    expect(store.find('t2')).toMatchObject({ panes: ['p4', 'p1'], collapsed: [] });
  });

  it('closes a source tab that a move empties', () => {
    const store = twoTabs();
    store.state = { ...store.state, activeId: 't1' };
    store.moveToActive('p4');
    expect(store.state.tabs.map((t) => t.id)).toEqual(['t1']);
    expect(store.find('t1')?.panes).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('reports the last pane of the last tab without changing state', () => {
    const store = new TabStore();
    store.addToActive('p1', false);
    const before = store.state;
    expect(store.removePane('p1')).toBe(false);
    expect(store.state).toBe(before);
  });

  it('replaces a pane in place in its own tab', () => {
    const store = twoTabs();
    store.replacePane('p2', 'v1');
    expect(store.find('t1')).toMatchObject({ tree: row(pane('p1'), pane('v1')), focusedId: 'v1', panes: ['p1', 'v1', 'p3'] });
    expect(store.find('t2')?.panes).toEqual(['p4']);
  });
});
