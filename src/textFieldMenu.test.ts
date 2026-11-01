import { describe, expect, it, vi } from 'vitest';
import { item, type MenuEntry, type MenuItem } from './contextMenuModel';
import { textFieldMenuItems, type TextFieldMenuActions } from './textFieldMenu';

function actions(): TextFieldMenuActions {
  return { undo: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() };
}

function enabledByLabel(entries: MenuEntry[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const e of entries) if (e.kind === 'item') out[e.label] = e.enabled ?? true;
  return out;
}

describe('textFieldMenuItems', () => {
  it('lists Undo, Cut, Copy, Paste, Select all in order', () => {
    const entries = textFieldMenuItems({ hasSelection: true, readOnly: false }, actions());
    expect(entries.map((e) => (e.kind === 'separator' ? '-' : e.label))).toEqual([
      'Undo',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ]);
  });

  it.each([
    [true, false, { Undo: true, Cut: true, Copy: true, Paste: true, 'Select all': true }],
    [false, false, { Undo: true, Cut: false, Copy: false, Paste: true, 'Select all': true }],
    [true, true, { Undo: false, Cut: false, Copy: true, Paste: false, 'Select all': true }],
    [false, true, { Undo: false, Cut: false, Copy: false, Paste: false, 'Select all': true }],
  ])('selection %s, read-only %s', (hasSelection, readOnly, expected) => {
    expect(enabledByLabel(textFieldMenuItems({ hasSelection, readOnly }, actions()))).toEqual(expected);
  });

  it('calls the matching action', () => {
    const a = actions();
    const entries = textFieldMenuItems({ hasSelection: true, readOnly: false }, a);
    for (const e of entries) if (e.kind === 'item') e.run();
    expect(a.undo).toHaveBeenCalledOnce();
    expect(a.cut).toHaveBeenCalledOnce();
    expect(a.copy).toHaveBeenCalledOnce();
    expect(a.paste).toHaveBeenCalledOnce();
    expect(a.selectAll).toHaveBeenCalledOnce();
  });

  it('appends extras after a separator', () => {
    const extra = item('Send', () => {});
    const entries = textFieldMenuItems({ hasSelection: false, readOnly: false }, actions(), [extra]);
    expect(entries).toHaveLength(7);
    expect(entries[5]).toEqual({ kind: 'separator' });
    expect((entries[6] as MenuItem).label).toBe('Send');
  });

  it('adds no separator without extras', () => {
    const entries = textFieldMenuItems({ hasSelection: false, readOnly: false }, actions(), []);
    expect(entries.some((e) => e.kind === 'separator')).toBe(false);
  });
});
