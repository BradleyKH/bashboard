import { describe, expect, it } from 'vitest';
import {
  addTab,
  addPane,
  closeTab,
  combinedStatus,
  nextTab,
  removePane,
  replacePane,
  renameTab,
  reorderTab,
  switchTab,
  tabAt,
  tabOf,
  tabTitle,
  type TabsState,
  type TabState,
} from './tabs';

function tab(id: string, panes: string[] = [`${id}-p1`]): TabState {
  return {
    id,
    name: null,
    tree: panes.length ? { kind: 'pane', paneId: panes[0] } : null,
    focusedId: panes[0] ?? '',
    collapsed: [],
    panes,
  };
}

function state(ids: string[], activeId = ids[0]): TabsState {
  return { tabs: ids.map((id) => tab(id)), activeId };
}

const ids = (s: TabsState) => s.tabs.map((t) => t.id);

describe('addTab', () => {
  it('appends and activates', () => {
    const s = addTab(state(['a', 'b']), tab('c'));
    expect(ids(s)).toEqual(['a', 'b', 'c']);
    expect(s.activeId).toBe('c');
  });
});

describe('closeTab', () => {
  it('activates the right neighbor', () => {
    const s = closeTab(state(['a', 'b', 'c'], 'b'), 'b')!;
    expect(ids(s)).toEqual(['a', 'c']);
    expect(s.activeId).toBe('c');
  });
  it('activates the left neighbor when last', () => {
    expect(closeTab(state(['a', 'b', 'c'], 'c'), 'c')!.activeId).toBe('b');
  });
  it('keeps the active tab when another closes', () => {
    expect(closeTab(state(['a', 'b', 'c'], 'c'), 'a')!.activeId).toBe('c');
  });
  it('returns null when the last tab closes', () => {
    expect(closeTab(state(['a']), 'a')).toBeNull();
  });
  it('ignores an unknown id', () => {
    const s = state(['a', 'b']);
    expect(closeTab(s, 'zzz')).toBe(s);
  });
});

describe('reorderTab', () => {
  it('moves a tab and keeps the active one', () => {
    const s = reorderTab(state(['a', 'b', 'c'], 'b'), 0, 2);
    expect(ids(s)).toEqual(['b', 'c', 'a']);
    expect(s.activeId).toBe('b');
  });
  it('ignores out-of-range indexes', () => {
    const s = state(['a', 'b']);
    expect(reorderTab(s, 0, 5)).toBe(s);
  });
});

describe('switching', () => {
  it('switches to a known tab only', () => {
    const s = state(['a', 'b']);
    expect(switchTab(s, 'b').activeId).toBe('b');
    expect(switchTab(s, 'nope')).toBe(s);
  });
  it('wraps forward and backward', () => {
    expect(nextTab(state(['a', 'b', 'c'], 'c'), 1).activeId).toBe('a');
    expect(nextTab(state(['a', 'b', 'c'], 'a'), -1).activeId).toBe('c');
    expect(nextTab(state(['a', 'b', 'c'], 'a'), -4).activeId).toBe('c');
  });
});

describe('tabAt', () => {
  const s = state(['a', 'b', 'c']);
  it('looks up by 1-based index', () => {
    expect(tabAt(s, 1)?.id).toBe('a');
    expect(tabAt(s, 3)?.id).toBe('c');
    expect(tabAt(s, 4)).toBeNull();
  });
  it('treats 9 as the last tab', () => {
    expect(tabAt(s, 9)?.id).toBe('c');
    expect(tabAt(state(['a']), 9)?.id).toBe('a');
  });
});

describe('panes', () => {
  it('finds the tab of a pane', () => {
    expect(tabOf(state(['a', 'b']), 'b-p1')?.id).toBe('b');
    expect(tabOf(state(['a']), 'x')).toBeNull();
  });
  it('adds panes, tracking collapsed ones', () => {
    let s = addPane(state(['a']), 'a', 'p2', false);
    s = addPane(s, 'a', 'p3', true);
    expect(s.tabs[0].panes).toEqual(['a-p1', 'p2', 'p3']);
    expect(s.tabs[0].collapsed).toEqual(['p3']);
  });
  it('removes a pane from panes and collapsed', () => {
    let s = addPane(state(['a']), 'a', 'p2', true);
    s = removePane(s, 'p2')!;
    expect(s.tabs[0].panes).toEqual(['a-p1']);
    expect(s.tabs[0].collapsed).toEqual([]);
  });
  it('closes a tab emptied by moving its last pane out', () => {
    const s = removePane(state(['a', 'b'], 'a'), 'a-p1')!;
    expect(ids(s)).toEqual(['b']);
    expect(s.activeId).toBe('b');
  });
  it('returns null when the last pane of the last tab leaves', () => {
    expect(removePane(state(['a']), 'a-p1')).toBeNull();
  });
});

describe('replacePane', () => {
  const row = (a: string, b: string) => ({
    kind: 'split' as const,
    dir: 'row' as const,
    ratio: 0.3,
    a: { kind: 'pane' as const, paneId: a },
    b: { kind: 'pane' as const, paneId: b },
  });
  const two = (): TabsState => ({
    tabs: [
      tab('a'),
      { id: 'b', name: 'Dev', tree: row('p1', 'p2'), focusedId: 'p2', collapsed: ['p3'], panes: ['p1', 'p2', 'p3'] },
    ],
    activeId: 'a',
  });

  it('swaps the tree leaf, keeping the split, and the same place in panes', () => {
    const s = replacePane(two(), 'p1', 'v1');
    expect(s.tabs[1].tree).toEqual(row('v1', 'p2'));
    expect(s.tabs[1].panes).toEqual(['v1', 'p2', 'p3']);
    expect(s.tabs[1].focusedId).toBe('p2');
    expect(s.tabs[0]).toEqual(two().tabs[0]);
  });
  it('moves focus with the focused pane', () => {
    const s = replacePane(two(), 'p2', 'v1');
    expect(s.tabs[1].focusedId).toBe('v1');
    expect(s.tabs[1].tree).toEqual(row('p1', 'v1'));
  });
  it('swaps a collapsed pane in the collapsed list', () => {
    const s = replacePane(two(), 'p3', 'v1');
    expect(s.tabs[1].collapsed).toEqual(['v1']);
    expect(s.tabs[1].panes).toEqual(['p1', 'p2', 'v1']);
    expect(s.tabs[1].tree).toEqual(row('p1', 'p2'));
  });
  it('ignores an unknown id', () => {
    const s = two();
    expect(replacePane(s, 'zzz', 'v1')).toBe(s);
  });
});

describe('names', () => {
  it('follows the focused title until renamed', () => {
    const s = state(['a']);
    expect(tabTitle(s.tabs[0], 'proj')).toBe('proj');
    const named = renameTab(s, 'a', '  work ');
    expect(named.tabs[0].name).toBe('work');
    expect(tabTitle(named.tabs[0], 'proj')).toBe('work');
  });
  it('returns to following on an empty rename', () => {
    const named = renameTab(state(['a']), 'a', 'work');
    expect(renameTab(named, 'a', '').tabs[0].name).toBeNull();
    expect(renameTab(named, 'a', '   ').tabs[0].name).toBeNull();
  });
});

describe('combinedStatus', () => {
  it('orders waiting over working over idle', () => {
    expect(combinedStatus(['idle', 'working', 'waiting'])).toBe('waiting');
    expect(combinedStatus(['idle', 'working'])).toBe('working');
    expect(combinedStatus(['idle', 'idle'])).toBe('idle');
    expect(combinedStatus([])).toBe('idle');
  });

  it('orders done over working and idle, under waiting', () => {
    expect(combinedStatus(['idle', 'done', 'working'])).toBe('done');
    expect(combinedStatus(['done', 'idle'])).toBe('done');
    expect(combinedStatus(['done', 'waiting', 'working'])).toBe('waiting');
  });
});
