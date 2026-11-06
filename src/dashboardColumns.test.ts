import { describe, expect, it } from 'vitest';
import {
  columnCount,
  dropInOneColumn,
  parsePinsColumn,
  parseRightElements,
  placeInColumns,
  slotElements,
  type ColumnPlacement,
} from './dashboardColumns';

// Left top: launch. Right top: clock. Left list: panes, ship. Right list: system, ports.
const base: ColumnPlacement = {
  order: ['launch', 'clock', 'panes', 'ship', 'system', 'ports'],
  top: ['launch', 'clock'],
  right: ['clock', 'system', 'ports'],
};

describe('columnCount', () => {
  it('switches at a higher width than it switches back', () => {
    expect(columnCount(599, 1)).toBe(1);
    expect(columnCount(600, 1)).toBe(2);
    expect(columnCount(580, 2)).toBe(2);
    expect(columnCount(568, 2)).toBe(2);
    expect(columnCount(567, 2)).toBe(1);
  });
});

describe('parsing', () => {
  it('reads a saved right column and pins column', () => {
    expect(parseRightElements(['clock', 'nope', 'clock', 'wave'])).toEqual(['clock', 'wave']);
    expect(parseRightElements([])).toEqual([]);
    expect(parseRightElements(undefined)).toBeNull();
    expect(parsePinsColumn('right')).toBe('right');
    expect(parsePinsColumn('middle')).toBeNull();
  });
});

describe('slotElements', () => {
  it('lists one column and slot in order', () => {
    expect(slotElements(base, 'left', 'top')).toEqual(['launch']);
    expect(slotElements(base, 'right', 'top')).toEqual(['clock']);
    expect(slotElements(base, 'left', 'list')).toEqual(['panes', 'ship']);
    expect(slotElements(base, 'right', 'list')).toEqual(['system', 'ports']);
  });
});

describe('placeInColumns', () => {
  it('moves an element across columns before a named element', () => {
    const p = placeInColumns(base, 'panes', 'list', 'right', 'ports');
    expect(slotElements(p, 'left', 'list')).toEqual(['ship']);
    expect(slotElements(p, 'right', 'list')).toEqual(['system', 'panes', 'ports']);
    expect(p.right).toContain('panes');
  });

  it('puts a null-before drop last in its slot', () => {
    const p = placeInColumns(base, 'system', 'top', 'left', null);
    expect(slotElements(p, 'left', 'top')).toEqual(['launch', 'system']);
    expect(p.top).toContain('system');
    expect(p.right).not.toContain('system');
  });

  it('keeps the order sorted into the four groups', () => {
    const scrambled = { ...base, order: ['ports', 'panes', 'clock', 'system', 'launch', 'ship'] as ColumnPlacement['order'] };
    const p = placeInColumns(scrambled, 'ship', 'list', 'left', null);
    expect(p.order).toEqual(['launch', 'clock', 'panes', 'ship', 'ports', 'system']);
  });

  it('ends last in its own group when before sits in a later group', () => {
    const p = placeInColumns(base, 'ports', 'top', 'left', 'clock');
    expect(slotElements(p, 'left', 'top')).toEqual(['launch', 'ports']);
    expect(p.order.slice(0, 3)).toEqual(['launch', 'ports', 'clock']);
  });
});

describe('dropInOneColumn', () => {
  // The one-column lower list: panes, ship (left), then system, ports (right).
  const list = ['panes', 'ship', 'system', 'ports'] as const;

  it('joins the column of the element just above the drop', () => {
    const p = dropInOneColumn(base, list, 'panes', 'list', 'ports');
    expect(slotElements(p, 'right', 'list')).toEqual(['system', 'panes', 'ports']);
    const q = dropInOneColumn(base, list, 'ports', 'list', 'system');
    // Above the drop is ship, so ports goes left, last in the left list.
    expect(slotElements(q, 'left', 'list')).toEqual(['panes', 'ship', 'ports']);
    expect(slotElements(q, 'right', 'list')).toEqual(['system']);
  });

  it('joins the column of the element below at the slot top edge', () => {
    const p = dropInOneColumn(base, list, 'system', 'list', 'panes');
    expect(slotElements(p, 'left', 'list')).toEqual(['system', 'panes', 'ship']);
  });

  it('joins the last element at the slot bottom', () => {
    const p = dropInOneColumn(base, list, 'panes', 'list', null);
    expect(slotElements(p, 'right', 'list')).toEqual(['system', 'ports', 'panes']);
  });

  it('changes nothing when dropped where it already was', () => {
    // system is first of the right run; the gap below it still has ship above, which is left.
    expect(dropInOneColumn(base, list, 'system', 'list', 'system')).toEqual(base);
    expect(dropInOneColumn(base, list, 'system', 'list', 'ports')).toEqual(base);
    expect(dropInOneColumn(base, list, 'ports', 'list', null)).toEqual(base);
  });

  it('keeps its own column in an otherwise empty slot', () => {
    const p = dropInOneColumn(base, ['launch', 'clock'], 'system', 'top', null);
    // Above the drop is clock, which is right.
    expect(slotElements(p, 'right', 'top')).toEqual(['clock', 'system']);
    const empty = { order: base.order, top: [], right: base.right };
    const q = dropInOneColumn(empty, [], 'ports', 'top', null);
    expect(slotElements(q, 'right', 'top')).toEqual(['ports']);
  });
});
