import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, pruneSelection, selectAll, selectAt, single } from './fileSelection';

const names = ['a', 'b', 'c', 'd', 'e'];

describe('selectAt', () => {
  it('selects just the row on a plain click', () => {
    const sel = selectAt({ cursor: 'a', anchor: 'a', marked: ['a', 'b'] }, 'd', {}, names);
    expect(sel).toEqual({ cursor: 'd', anchor: 'd', marked: ['d'] });
  });

  it('toggles a row with Ctrl, keeping list order', () => {
    let sel = selectAt(single('d'), 'b', { ctrl: true }, names);
    expect(sel).toEqual({ cursor: 'b', anchor: 'b', marked: ['b', 'd'] });
    sel = selectAt(sel, 'd', { ctrl: true }, names);
    expect(sel).toEqual({ cursor: 'd', anchor: 'd', marked: ['b'] });
  });

  it('selects the range from the anchor with Shift, in either direction', () => {
    expect(selectAt(single('b'), 'd', { shift: true }, names).marked).toEqual(['b', 'c', 'd']);
    const back = selectAt(single('d'), 'a', { shift: true }, names);
    expect(back).toEqual({ cursor: 'a', anchor: 'd', marked: ['a', 'b', 'c', 'd'] });
  });

  it('keeps the anchor across Shift clicks, so the range shrinks', () => {
    let sel = selectAt(single('b'), 'e', { shift: true }, names);
    sel = selectAt(sel, 'c', { shift: true }, names);
    expect(sel.marked).toEqual(['b', 'c']);
  });

  it('adds the range to the selection with Ctrl+Shift', () => {
    let sel = selectAt(single('a'), 'c', { ctrl: true }, names);
    sel = selectAt(sel, 'e', { ctrl: true, shift: true }, names);
    expect(sel.marked).toEqual(['a', 'c', 'd', 'e']);
  });

  it('ranges from the clicked row with nothing selected', () => {
    expect(selectAt(EMPTY_SELECTION, 'c', { shift: true }, names).marked).toEqual(['c']);
  });
});

describe('selectAll and pruneSelection', () => {
  it('selects every visible name', () => {
    expect(selectAll(single('c'), names)).toEqual({ cursor: 'c', anchor: 'c', marked: names });
    expect(selectAll(EMPTY_SELECTION, [])).toBe(EMPTY_SELECTION);
  });

  it('drops names that are gone and clears a vanished cursor', () => {
    const sel = { cursor: 'c', anchor: 'b', marked: ['b', 'c', 'd'] };
    expect(pruneSelection(sel, ['a', 'b', 'd'])).toEqual({ cursor: null, anchor: 'b', marked: ['b', 'd'] });
    expect(pruneSelection(sel, names)).toBe(sel);
  });
});
