import { describe, expect, it } from 'vitest';
import { applyDock, dropZones, expandInto, focusAfterRemoval, windowEdgeAt } from './docking';
import type { Layout } from './layout';

const cell = { width: 10, height: 20 };
const wide = { x: 0, y: 0, width: 1000, height: 600 };
const tiny = { x: 0, y: 0, width: 250, height: 120 };

const leaf = (paneId: string): Layout => ({ kind: 'pane', paneId });
const row = (a: Layout, b: Layout): Layout => ({ kind: 'split', dir: 'row', ratio: 0.5, a, b });

describe('dropZones', () => {
  it('gives folders the four edges only', () => {
    expect(dropZones({ kind: 'folder', path: 'C:\\x' }, 'p1')).toEqual(['left', 'right', 'top', 'bottom']);
  });

  it('gives panes all five zones, except on themselves', () => {
    expect(dropZones({ kind: 'pane', paneId: 'p2' }, 'p1')).toHaveLength(5);
    expect(dropZones({ kind: 'pane', paneId: 'p1' }, 'p1')).toEqual([]);
  });
});

describe('windowEdgeAt', () => {
  const rect = { left: 100, top: 50, width: 800, height: 500 };

  it('hits the band along each edge', () => {
    expect(windowEdgeAt(rect, 110, 300)).toBe('left');
    expect(windowEdgeAt(rect, 890, 300)).toBe('right');
    expect(windowEdgeAt(rect, 500, 60)).toBe('top');
    expect(windowEdgeAt(rect, 500, 540)).toBe('bottom');
    expect(windowEdgeAt(rect, 124, 300)).toBe('left');
  });

  it('misses inside the band width and outside the rect', () => {
    expect(windowEdgeAt(rect, 125, 300)).toBeNull();
    expect(windowEdgeAt(rect, 500, 300)).toBeNull();
    expect(windowEdgeAt(rect, 99, 300)).toBeNull();
    expect(windowEdgeAt(rect, 500, 551)).toBeNull();
    expect(windowEdgeAt(rect, 110, 300, 5)).toBeNull();
  });

  it('picks the nearer edge at a corner', () => {
    expect(windowEdgeAt(rect, 105, 70)).toBe('left');
    expect(windowEdgeAt(rect, 120, 55)).toBe('top');
    expect(windowEdgeAt(rect, 895, 545)).toBe('right');
    expect(windowEdgeAt(rect, 880, 548)).toBe('bottom');
  });
});

describe('applyDock', () => {
  it('fills an empty layout on a null target', () => {
    expect(applyDock(null, 'p3', false, null, wide, cell)).toEqual({
      kind: 'ok',
      tree: leaf('p3'),
      displaced: null,
    });
  });

  it('ignores a null target over a non-empty layout and drops onto the dragged pane itself', () => {
    const tree = row(leaf('p1'), leaf('p2'));
    expect(applyDock(tree, 'p3', false, null, wide, cell).kind).toBe('noop');
    expect(applyDock(tree, 'p1', true, { paneId: 'p1', zone: 'left' }, wide, cell).kind).toBe('noop');
  });

  it('moves an expanded pane to an edge after removing it from its old spot', () => {
    const tree = row(leaf('p1'), leaf('p2'));
    const r = applyDock(tree, 'p1', true, { paneId: 'p2', zone: 'bottom' }, wide, cell);
    expect(r).toEqual({
      kind: 'ok',
      tree: { kind: 'split', dir: 'column', ratio: 0.5, a: leaf('p2'), b: leaf('p1') },
      displaced: null,
    });
  });

  it('puts the dragged pane first for left and top', () => {
    const r = applyDock(leaf('p1'), 'p2', false, { paneId: 'p1', zone: 'left' }, wide, cell);
    expect(r).toEqual({ kind: 'ok', tree: row(leaf('p2'), leaf('p1')), displaced: null });
  });

  it('swaps two expanded panes on center', () => {
    const tree = row(leaf('p1'), leaf('p2'));
    const r = applyDock(tree, 'p1', true, { paneId: 'p2', zone: 'center' }, wide, cell);
    expect(r).toEqual({ kind: 'ok', tree: row(leaf('p2'), leaf('p1')), displaced: null });
  });

  it('swaps a collapsed pane in on center and displaces the target', () => {
    const tree = row(leaf('p1'), leaf('p2'));
    const r = applyDock(tree, 'p3', false, { paneId: 'p2', zone: 'center' }, wide, cell);
    expect(r).toEqual({ kind: 'ok', tree: row(leaf('p1'), leaf('p3')), displaced: 'p2' });
  });

  it('reports no room when the target is too small to halve', () => {
    expect(applyDock(leaf('p1'), 'p2', false, { paneId: 'p1', zone: 'right' }, tiny, cell).kind).toBe('noRoom');
  });
});

describe('applyDock at a window edge', () => {
  it('moves an expanded pane out of its old spot and wraps the rest', () => {
    const tree = row(leaf('p1'), leaf('p2'));
    const r = applyDock(tree, 'p1', true, { windowEdge: 'bottom' }, wide, cell);
    expect(r).toEqual({
      kind: 'ok',
      tree: { kind: 'split', dir: 'column', ratio: 1 - (600 - 4) / 3 / (600 - 4), a: leaf('p2'), b: leaf('p1') },
      displaced: null,
    });
  });

  it('wraps the whole tree for a collapsed pane', () => {
    const tree = row(leaf('p1'), leaf('p2'));
    const r = applyDock(tree, 'p3', false, { windowEdge: 'left' }, wide, cell);
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.tree).toMatchObject({ kind: 'split', dir: 'row', a: leaf('p3'), b: tree });
  });

  it('does nothing for a lone dragged pane or with no tree', () => {
    expect(applyDock(leaf('p1'), 'p1', true, { windowEdge: 'right' }, wide, cell).kind).toBe('noop');
    expect(applyDock(null, 'p1', false, { windowEdge: 'right' }, wide, cell).kind).toBe('noop');
  });

  it('reports no room when the rest would fall below the minimum', () => {
    expect(applyDock(leaf('p1'), 'p2', false, { windowEdge: 'right' }, tiny, cell).kind).toBe('noRoom');
  });
});

describe('expandInto', () => {
  it('fills an empty layout', () => {
    expect(expandInto(null, '', 'p2', wide, cell)).toEqual(leaf('p2'));
  });

  it('splits the focused pane in the auto direction with the pane second', () => {
    expect(expandInto(leaf('p1'), 'p1', 'p2', wide, cell)).toEqual(row(leaf('p1'), leaf('p2')));
    const tall = { x: 0, y: 0, width: 600, height: 1000 };
    expect(expandInto(leaf('p1'), 'p1', 'p2', tall, cell)).toEqual({
      kind: 'split',
      dir: 'column',
      ratio: 0.5,
      a: leaf('p1'),
      b: leaf('p2'),
    });
  });

  it('returns null without room or without a focused pane', () => {
    expect(expandInto(leaf('p1'), 'p1', 'p2', tiny, cell)).toBeNull();
    expect(expandInto(leaf('p1'), '', 'p2', wide, cell)).toBeNull();
  });
});

describe('focusAfterRemoval', () => {
  const tree = row(leaf('p1'), row(leaf('p2'), leaf('p3')));

  it('keeps focus when another pane is removed', () => {
    expect(focusAfterRemoval(tree, 'p2', 'p3')).toBe('p3');
  });

  it("moves to the sibling's first leaf", () => {
    expect(focusAfterRemoval(tree, 'p1', 'p1')).toBe('p2');
    expect(focusAfterRemoval(tree, 'p3', 'p3')).toBe('p2');
  });

  it('is empty when the last pane goes', () => {
    expect(focusAfterRemoval(leaf('p1'), 'p1', 'p1')).toBe('');
  });
});
