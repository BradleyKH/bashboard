import { describe, expect, it } from 'vitest';
import {
  type Layout,
  type Rect,
  DIVIDER_PX,
  autoDir,
  clampRatio,
  close,
  computeDividers,
  computeRects,
  dockZoneAt,
  insertAtEdge,
  insertAtRootEdge,
  leaves,
  minExtent,
  neighbor,
  replaceLeaf,
  resizePane,
  setRatio,
  split,
  swap,
} from './layout';

// 10x20 px cells: a pane needs at least 200 px wide and 100 px tall.
const cell = { width: 10, height: 20 };
const box: Rect = { x: 0, y: 0, width: 1004, height: 604 };

const pane = (paneId: string): Layout => ({ kind: 'pane', paneId });
const row = (a: Layout, b: Layout, ratio = 0.5): Layout => ({ kind: 'split', dir: 'row', ratio, a, b });
const col = (a: Layout, b: Layout, ratio = 0.5): Layout => ({ kind: 'split', dir: 'column', ratio, a, b });

const grid = row(col(pane('p1'), pane('p3')), col(pane('p2'), pane('p4')));

describe('split', () => {
  it('splits row with the original pane first', () => {
    expect(split(pane('p1'), 'p1', 'p2', 'row', box, cell)).toEqual(row(pane('p1'), pane('p2')));
  });

  it('splits column with the original pane first', () => {
    expect(split(pane('p1'), 'p1', 'p2', 'column', box, cell)).toEqual(col(pane('p1'), pane('p2')));
  });

  it('splits a nested leaf in place', () => {
    const t = row(pane('p1'), pane('p2'));
    expect(split(t, 'p2', 'p3', 'column', box, cell)).toEqual(row(pane('p1'), col(pane('p2'), pane('p3'))));
  });

  it('refuses when the halves would be too small, returning the same tree', () => {
    const narrow: Rect = { x: 0, y: 0, width: 400, height: 600 };
    const t = pane('p1');
    expect(split(t, 'p1', 'p2', 'row', narrow, cell)).toBe(t);
    expect(split(t, 'p1', 'p2', 'row', { ...narrow, width: 404 }, cell)).not.toBe(t);
    const short: Rect = { x: 0, y: 0, width: 1000, height: 200 };
    expect(split(t, 'p1', 'p2', 'column', short, cell)).toBe(t);
  });

  it('refuses based on the target pane rect, not the container', () => {
    const t = row(pane('p1'), pane('p2'), 0.25); // p1 is 250 px wide
    expect(split(t, 'p1', 'p3', 'row', box, cell)).toBe(t);
    expect(split(t, 'p2', 'p3', 'row', box, cell)).not.toBe(t);
  });

  it('returns the same tree for an unknown pane', () => {
    const t = pane('p1');
    expect(split(t, 'nope', 'p2', 'row', box, cell)).toBe(t);
  });
});

describe('insertAtEdge', () => {
  it('puts the new leaf on the requested side', () => {
    const t = pane('p1');
    expect(insertAtEdge(t, 'p1', 'n', 'left', box, cell)).toEqual(row(pane('n'), pane('p1')));
    expect(insertAtEdge(t, 'p1', 'n', 'right', box, cell)).toEqual(row(pane('p1'), pane('n')));
    expect(insertAtEdge(t, 'p1', 'n', 'top', box, cell)).toEqual(col(pane('n'), pane('p1')));
    expect(insertAtEdge(t, 'p1', 'n', 'bottom', box, cell)).toEqual(col(pane('p1'), pane('n')));
  });

  it('wraps a nested leaf in place', () => {
    const t = row(pane('p1'), pane('p2'));
    expect(insertAtEdge(t, 'p2', 'n', 'top', box, cell)).toEqual(row(pane('p1'), col(pane('n'), pane('p2'))));
  });

  it('refuses when the halves would be too small, returning the same tree', () => {
    const t = pane('p1');
    const narrow: Rect = { x: 0, y: 0, width: 400, height: 600 };
    expect(insertAtEdge(t, 'p1', 'n', 'left', narrow, cell)).toBe(t);
    expect(insertAtEdge(t, 'p1', 'n', 'right', { ...narrow, width: 404 }, cell)).not.toBe(t);
    const short: Rect = { x: 0, y: 0, width: 1000, height: 200 };
    expect(insertAtEdge(t, 'p1', 'n', 'bottom', short, cell)).toBe(t);
    expect(insertAtEdge(t, 'p1', 'n', 'right', short, cell)).not.toBe(t);
  });

  it('returns the same tree for an unknown target', () => {
    const t = pane('p1');
    expect(insertAtEdge(t, 'nope', 'n', 'left', box, cell)).toBe(t);
  });

  it('supports the remove-then-insert move of a docking drag', () => {
    const t = row(pane('p1'), col(pane('p2'), pane('p3')));
    const without = close(t, 'p1');
    expect(without).toEqual(col(pane('p2'), pane('p3')));
    expect(insertAtEdge(without as Layout, 'p3', 'p1', 'right', box, cell)).toEqual(
      col(pane('p2'), row(pane('p3'), pane('p1'))),
    );
  });
});

describe('insertAtRootEdge', () => {
  const t = row(pane('p1'), pane('p2'));

  it('wraps the whole tree with the new leaf on the requested side', () => {
    expect(insertAtRootEdge(t, 'n', 'left', box, cell)).toMatchObject({ dir: 'row', a: pane('n'), b: t });
    expect(insertAtRootEdge(t, 'n', 'right', box, cell)).toMatchObject({ dir: 'row', a: t, b: pane('n') });
    expect(insertAtRootEdge(t, 'n', 'top', box, cell)).toMatchObject({ dir: 'column', a: pane('n'), b: t });
    expect(insertAtRootEdge(t, 'n', 'bottom', box, cell)).toMatchObject({ dir: 'column', a: t, b: pane('n') });
  });

  it('takes a third of the container in a roomy one', () => {
    const left = insertAtRootEdge(t, 'n', 'left', box, cell);
    const right = insertAtRootEdge(t, 'n', 'right', box, cell);
    const top = insertAtRootEdge(t, 'n', 'top', box, cell);
    expect(left).toMatchObject({ ratio: 1 / 3 });
    expect(right.kind === 'split' && right.ratio).toBeCloseTo(2 / 3);
    expect(top).toMatchObject({ ratio: 1 / 3 });
    expect(computeRects(left, box).get('n')?.width).toBeCloseTo((box.width - DIVIDER_PX) / 3);
  });

  it('grows the share to the minimum in a narrow container', () => {
    const one = pane('p1');
    const narrow: Rect = { x: 0, y: 0, width: 504, height: 600 }; // a third is 166 px, under 200
    const r = insertAtRootEdge(one, 'n', 'left', narrow, cell);
    expect(r).toMatchObject({ ratio: 200 / 500 });
    const rr = insertAtRootEdge(one, 'n', 'right', narrow, cell);
    expect(rr.kind === 'split' && rr.ratio).toBeCloseTo(300 / 500);
  });

  it('refuses when the rest would drop below the minimum, returning the same tree', () => {
    const one = pane('p1');
    expect(insertAtRootEdge(one, 'n', 'left', { x: 0, y: 0, width: 403, height: 600 }, cell)).toBe(one);
    expect(insertAtRootEdge(one, 'n', 'left', { x: 0, y: 0, width: 404, height: 600 }, cell)).not.toBe(one);
    expect(insertAtRootEdge(one, 'n', 'top', { x: 0, y: 0, width: 1000, height: 203 }, cell)).toBe(one);
    expect(insertAtRootEdge(t, 'n', 'right', { x: 0, y: 0, width: 600, height: 600 }, cell)).toBe(t);
  });

  it('refuses when the container is too thin across for the new leaf', () => {
    expect(insertAtRootEdge(t, 'n', 'top', { x: 0, y: 0, width: 150, height: 900 }, cell)).toBe(t);
  });

  it('accounts for an uneven nested same-axis split', () => {
    // The 0.2 side of the inner split needs 200 px, so the inner split needs 1000 px.
    const uneven = row(pane('p1'), pane('p2'), 0.2);
    const need = 1000 + DIVIDER_PX;
    const wideEnough: Rect = { x: 0, y: 0, width: need * 1.5 + 2 * DIVIDER_PX, height: 600 };
    expect(insertAtRootEdge(uneven, 'n', 'right', wideEnough, cell)).not.toBe(uneven);
    const tooNarrow: Rect = { ...wideEnough, width: wideEnough.width - 10 };
    expect(insertAtRootEdge(uneven, 'n', 'right', tooNarrow, cell)).toBe(uneven);
    // The plain minimum sum (404) would have allowed this container.
    expect(minExtent(uneven, 'x', cell)).toBe(404);
  });
});

describe('swap', () => {
  it('exchanges siblings', () => {
    expect(swap(row(pane('p1'), pane('p2'), 0.3), 'p1', 'p2')).toEqual(row(pane('p2'), pane('p1'), 0.3));
  });

  it('exchanges distant leaves and keeps the shape', () => {
    expect(swap(grid, 'p1', 'p4')).toEqual(row(col(pane('p4'), pane('p3')), col(pane('p2'), pane('p1'))));
  });

  it('is a no-op for the same or unknown ids', () => {
    expect(swap(grid, 'p1', 'p1')).toBe(grid);
    expect(swap(grid, 'p1', 'nope')).toBe(grid);
  });
});

describe('replaceLeaf', () => {
  it('swaps in a new id at the old position', () => {
    expect(replaceLeaf(grid, 'p3', 'x')).toEqual(row(col(pane('p1'), pane('x')), col(pane('p2'), pane('p4'))));
    expect(replaceLeaf(pane('p1'), 'p1', 'x')).toEqual(pane('x'));
  });

  it('returns the same tree for an unknown id', () => {
    expect(replaceLeaf(grid, 'nope', 'x')).toBe(grid);
  });
});

describe('dockZoneAt', () => {
  const r = { left: 100, top: 50, width: 400, height: 200 };

  it('treats the middle 50% box as center', () => {
    expect(dockZoneAt(r, 300, 150)).toBe('center');
    expect(dockZoneAt(r, 210, 100)).toBe('center');
    expect(dockZoneAt(r, 390, 200)).toBe('center');
  });

  it('picks the nearest edge outside the center box', () => {
    expect(dockZoneAt(r, 110, 150)).toBe('left');
    expect(dockZoneAt(r, 490, 150)).toBe('right');
    expect(dockZoneAt(r, 300, 55)).toBe('top');
    expect(dockZoneAt(r, 300, 245)).toBe('bottom');
  });

  it('resolves corners by the nearer edge in proportion to the pane size', () => {
    expect(dockZoneAt(r, 105, 60)).toBe('left'); // 1.25% from left, 5% from top
    expect(dockZoneAt(r, 150, 52)).toBe('top'); // 1% from top, 12.5% from left
    expect(dockZoneAt(r, 495, 245)).toBe('right');
    expect(dockZoneAt(r, 450, 248)).toBe('bottom');
  });
});

describe('autoDir', () => {
  it('picks row when wider than tall, column otherwise', () => {
    expect(autoDir({ x: 0, y: 0, width: 800, height: 600 })).toBe('row');
    expect(autoDir({ x: 0, y: 0, width: 600, height: 800 })).toBe('column');
    expect(autoDir({ x: 0, y: 0, width: 500, height: 500 })).toBe('column');
  });
});

describe('close', () => {
  it('promotes the sibling', () => {
    expect(close(row(pane('p1'), pane('p2')), 'p1')).toEqual(pane('p2'));
    expect(close(row(pane('p1'), pane('p2')), 'p2')).toEqual(pane('p1'));
  });

  it('promotes a sibling subtree in a nested tree', () => {
    const t = row(pane('p1'), col(pane('p2'), row(pane('p3'), pane('p4'), 0.3)));
    expect(close(t, 'p2')).toEqual(row(pane('p1'), row(pane('p3'), pane('p4'), 0.3)));
    expect(close(t, 'p1')).toEqual(col(pane('p2'), row(pane('p3'), pane('p4'), 0.3)));
  });

  it('returns null when the last pane closes', () => {
    expect(close(pane('p1'), 'p1')).toBeNull();
  });
});

describe('computeRects / computeDividers', () => {
  it('excludes the divider from the ratio space', () => {
    const rects = computeRects(row(pane('p1'), pane('p2'), 0.25), { x: 10, y: 20, width: 404, height: 300 });
    expect(rects.get('p1')).toEqual({ x: 10, y: 20, width: 100, height: 300 });
    expect(rects.get('p2')).toEqual({ x: 114, y: 20, width: 300, height: 300 });
  });

  it('lays out a 2x2 grid', () => {
    const rects = computeRects(grid, box);
    expect(rects.get('p1')).toEqual({ x: 0, y: 0, width: 500, height: 300 });
    expect(rects.get('p3')).toEqual({ x: 0, y: 304, width: 500, height: 300 });
    expect(rects.get('p2')).toEqual({ x: 504, y: 0, width: 500, height: 300 });
    expect(rects.get('p4')).toEqual({ x: 504, y: 304, width: 500, height: 300 });
  });

  it('reports each divider with its path', () => {
    const divs = computeDividers(grid, box);
    expect(divs).toEqual([
      { path: [], dir: 'row', rect: { x: 500, y: 0, width: DIVIDER_PX, height: 604 } },
      { path: ['a'], dir: 'column', rect: { x: 0, y: 300, width: 500, height: DIVIDER_PX } },
      { path: ['b'], dir: 'column', rect: { x: 504, y: 300, width: 500, height: DIVIDER_PX } },
    ]);
  });

  it('lists leaves in visual order', () => {
    expect(leaves(grid)).toEqual(['p1', 'p3', 'p2', 'p4']);
  });
});

describe('minExtent', () => {
  it('sums along the split axis and maxes across it', () => {
    const t = row(pane('p1'), col(pane('p2'), pane('p3')));
    expect(minExtent(t, 'x', cell)).toBe(200 + 200 + DIVIDER_PX);
    expect(minExtent(t, 'y', cell)).toBe(100 + 100 + DIVIDER_PX);
  });

  it('adds per-pane padding to every leaf', () => {
    const t = row(pane('p1'), col(pane('p2'), pane('p3')));
    const padded = { ...cell, padX: 16, padY: 2 };
    expect(minExtent(t, 'x', padded)).toBe(216 + 216 + DIVIDER_PX);
    expect(minExtent(t, 'y', padded)).toBe(102 + 102 + DIVIDER_PX);
  });

  it('makes split and clampRatio honor the padding', () => {
    const narrow: Rect = { x: 0, y: 0, width: 420, height: 604 };
    const padded = { ...cell, padX: 16 };
    expect(split(pane('p1'), 'p1', 'p2', 'row', narrow, cell)).not.toEqual(pane('p1'));
    expect(split(pane('p1'), 'p1', 'p2', 'row', narrow, padded)).toEqual(pane('p1'));
    const t = row(pane('p1'), pane('p2'));
    expect(clampRatio(t, [], 0, box, padded)).toBeCloseTo(216 / (box.width - DIVIDER_PX));
  });
});

describe('clampRatio', () => {
  it('clamps a simple split to the leaf minimums', () => {
    const t = row(pane('p1'), pane('p2'));
    expect(clampRatio(t, [], 0.01, box, cell)).toBeCloseTo(200 / 1000);
    expect(clampRatio(t, [], 0.99, box, cell)).toBeCloseTo(800 / 1000);
    expect(clampRatio(t, [], 0.4, box, cell)).toBe(0.4);
  });

  it('accounts for a nested same-axis split', () => {
    const t = row(row(pane('p1'), pane('p2')), pane('p3'));
    // Left side needs 200 + 4 + 200 = 404 px of the 1000 px available.
    expect(clampRatio(t, [], 0.1, box, cell)).toBeCloseTo(404 / 1000);
  });

  it('keeps the small side of an uneven nested split at its minimum', () => {
    const t = row(row(pane('p1'), pane('p2'), 0.25), pane('p3'));
    // Inner ratio 0.25 needs 200 / 0.25 = 800 px plus the divider.
    expect(clampRatio(t, [], 0.1, box, cell)).toBeCloseTo(804 / 1000);
  });

  it('ignores cross-axis nesting', () => {
    const t = row(col(pane('p1'), pane('p2')), pane('p3'));
    expect(clampRatio(t, [], 0.05, box, cell)).toBeCloseTo(200 / 1000);
  });

  it('clamps an inner split within its own rect', () => {
    const t = row(pane('p1'), row(pane('p2'), pane('p3')), 0.4); // inner rect is 600 px wide
    expect(clampRatio(t, ['b'], 0.05, box, cell)).toBeCloseTo(200 / 596);
    expect(clampRatio(t, ['b'], 0.95, box, cell)).toBeCloseTo(1 - 200 / 596);
  });

  it('returns a proportional ratio without throwing when space is short', () => {
    const t = row(row(pane('p1'), pane('p2')), pane('p3'));
    const tight: Rect = { x: 0, y: 0, width: 300, height: 600 };
    expect(clampRatio(t, [], 0.9, tight, cell)).toBeCloseTo(404 / 604);
  });
});

describe('setRatio', () => {
  it('updates immutably', () => {
    const t = row(pane('p1'), col(pane('p2'), pane('p3')));
    const next = setRatio(t, ['b'], 0.3);
    expect(next).toEqual(row(pane('p1'), col(pane('p2'), pane('p3'), 0.3)));
    expect(t).toEqual(row(pane('p1'), col(pane('p2'), pane('p3'))));
    expect(next.kind === 'split' && t.kind === 'split' && next.a === t.a).toBe(true);
  });
});

describe('resizePane', () => {
  it('moves the nearest matching-axis divider in the given direction', () => {
    expect(resizePane(row(pane('p1'), pane('p2')), 'p1', 'right', box, cell)).toEqual(
      row(pane('p1'), pane('p2'), 0.55),
    );
    expect(resizePane(row(pane('p1'), pane('p2')), 'p2', 'left', box, cell)).toEqual(
      row(pane('p1'), pane('p2'), 0.45),
    );
  });

  it('skips cross-axis ancestors', () => {
    const next = resizePane(grid, 'p3', 'right', box, cell);
    expect(next).toEqual(row(col(pane('p1'), pane('p3')), col(pane('p2'), pane('p4')), 0.55));
    const down = resizePane(grid, 'p4', 'down', box, cell);
    expect(down).toEqual(row(col(pane('p1'), pane('p3')), col(pane('p2'), pane('p4'), 0.55)));
  });

  it('picks the nearest of several same-axis ancestors', () => {
    const t = row(pane('p1'), row(pane('p2'), pane('p3')), 0.3);
    expect(resizePane(t, 'p3', 'left', box, cell)).toEqual(row(pane('p1'), row(pane('p2'), pane('p3'), 0.45), 0.3));
  });

  it('clamps and returns the same tree when it cannot move', () => {
    const t = row(pane('p1'), pane('p2'), 0.78);
    expect(resizePane(t, 'p1', 'right', box, cell)).toEqual(row(pane('p1'), pane('p2'), 0.8));
    const atLimit = row(pane('p1'), pane('p2'), 0.8);
    expect(resizePane(atLimit, 'p1', 'right', box, cell)).toBe(atLimit);
  });

  it('returns the same tree when no matching split exists', () => {
    const t = col(pane('p1'), pane('p2'));
    expect(resizePane(t, 'p1', 'right', box, cell)).toBe(t);
    const single = pane('p1');
    expect(resizePane(single, 'p1', 'up', box, cell)).toBe(single);
  });
});

describe('neighbor', () => {
  it('moves around a 2x2 grid', () => {
    expect(neighbor(grid, 'p1', 'right', box)).toBe('p2');
    expect(neighbor(grid, 'p1', 'down', box)).toBe('p3');
    expect(neighbor(grid, 'p4', 'left', box)).toBe('p3');
    expect(neighbor(grid, 'p4', 'up', box)).toBe('p2');
    expect(neighbor(grid, 'p1', 'left', box)).toBeNull();
    expect(neighbor(grid, 'p1', 'up', box)).toBeNull();
  });

  it('prefers the largest overlap in uneven splits', () => {
    // p1 full height on the left; right column split 0.8 / 0.2.
    const t = row(pane('p1'), col(pane('p2'), pane('p3'), 0.8));
    expect(neighbor(t, 'p1', 'right', box)).toBe('p2');
    expect(neighbor(t, 'p3', 'left', box)).toBe('p1');
  });

  it('skips panes that are not adjacent', () => {
    const three = row(pane('p1'), row(pane('p2'), pane('p3')), 0.33);
    expect(neighbor(three, 'p1', 'right', box)).toBe('p2');
    expect(neighbor(three, 'p3', 'left', box)).toBe('p2');
  });

  it('prefers an adjacent pane over a farther one with more overlap', () => {
    const t = row(pane('p1'), row(col(pane('p2'), pane('p3')), pane('p4')), 0.3);
    expect(neighbor(t, 'p1', 'right', box)).toBe('p2');
  });
});

describe('immutability', () => {
  it('never mutates the input tree', () => {
    const t = row(pane('p1'), col(pane('p2'), pane('p3')));
    const snapshot = JSON.parse(JSON.stringify(t));
    split(t, 'p2', 'p4', 'row', box, cell);
    close(t, 'p3');
    setRatio(t, [], 0.7);
    resizePane(t, 'p2', 'down', box, cell);
    clampRatio(t, [], 0.01, box, cell);
    neighbor(t, 'p1', 'right', box);
    expect(t).toEqual(snapshot);
  });
});
