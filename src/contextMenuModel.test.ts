import { describe, expect, it } from 'vitest';
import {
  isKeyboardContextMenu,
  isMenuKey,
  item,
  type MenuEntry,
  nextEnabled,
  placeMenu,
  placeSubmenu,
  separator,
  submenu,
  tidySeparators,
} from './contextMenuModel';

const VIEW = { width: 800, height: 600 };
const SIZE = { width: 200, height: 100 };
const noop = () => {};

describe('placeMenu', () => {
  it('opens at the pointer when it fits', () => {
    expect(placeMenu(SIZE, { x: 100, y: 50 }, VIEW)).toEqual({ left: 100, top: 50, maxHeight: 100 });
  });

  it('shifts left from the right edge', () => {
    expect(placeMenu(SIZE, { x: 750, y: 50 }, VIEW).left).toBe(800 - 4 - 200);
  });

  it('flips above the pointer near the bottom edge', () => {
    expect(placeMenu(SIZE, { x: 100, y: 580 }, VIEW).top).toBe(480);
  });

  it('clamps to the margin at the top-left corner', () => {
    expect(placeMenu(SIZE, { x: -10, y: -10 }, VIEW)).toEqual({ left: 4, top: 4, maxHeight: 100 });
  });

  it('clamps a flip that would leave the top edge', () => {
    const pos = placeMenu({ width: 200, height: 400 }, { x: 10, y: 300 }, VIEW);
    expect(pos.top).toBe(600 - 4 - 400);
  });

  it('opens below an anchor, left aligned', () => {
    const anchor = { left: 100, top: 20, right: 140, bottom: 40 };
    expect(placeMenu(SIZE, { anchor, align: 'left' }, VIEW)).toEqual({ left: 100, top: 42, maxHeight: 100 });
  });

  it('aligns its right edge with a right-aligned anchor', () => {
    const anchor = { left: 300, top: 20, right: 340, bottom: 40 };
    expect(placeMenu(SIZE, { anchor, align: 'right' }, VIEW).left).toBe(140);
  });

  it('flips above an anchor at the bottom right and stays inside', () => {
    const anchor = { left: 760, top: 570, right: 800, bottom: 590 };
    expect(placeMenu(SIZE, { anchor, align: 'left' }, VIEW)).toEqual({ left: 596, top: 468, maxHeight: 100 });
  });

  it('caps maxHeight for a menu taller than the window', () => {
    const pos = placeMenu({ width: 200, height: 900 }, { x: 10, y: 300 }, VIEW);
    expect(pos).toEqual({ left: 10, top: 4, maxHeight: 592 });
  });
});

describe('placeSubmenu', () => {
  const parent = { left: 100, top: 50, right: 300, bottom: 70 };

  it('opens to the right of the parent item', () => {
    expect(placeSubmenu(SIZE, parent, VIEW)).toEqual({ left: 300, top: 50, maxHeight: 100 });
  });

  it('flips to the left when there is no room on the right', () => {
    const near = { left: 500, top: 50, right: 700, bottom: 70 };
    expect(placeSubmenu(SIZE, near, VIEW).left).toBe(300);
  });

  it('clamps vertically', () => {
    const low = { left: 100, top: 560, right: 300, bottom: 580 };
    expect(placeSubmenu(SIZE, low, VIEW).top).toBe(496);
  });
});

describe('tidySeparators', () => {
  it('drops leading, trailing, and doubled separators', () => {
    const a = item('A', noop);
    const b = item('B', noop);
    const out = tidySeparators([separator(), a, separator(), separator(), b, separator()]);
    expect(out.map((e) => e.kind)).toEqual(['item', 'separator', 'item']);
  });

  it('returns nothing for only separators', () => {
    expect(tidySeparators([separator(), separator()])).toEqual([]);
  });

  it('tidies a submenu and disables one with no enabled items', () => {
    const out = tidySeparators([
      submenu('Empty', [separator()]),
      submenu('Off', [item('X', noop, { enabled: false })]),
      submenu('On', [separator(), item('Y', noop), separator()]),
    ]);
    expect(out.map((e) => e.kind === 'submenu' && e.enabled)).toEqual([false, false, true]);
    const on = out[2];
    expect(on.kind === 'submenu' && on.items.map((e) => e.kind)).toEqual(['item']);
  });
});

describe('nextEnabled', () => {
  const entries: MenuEntry[] = [
    item('A', noop),
    separator(),
    item('B', noop, { enabled: false }),
    item('C', noop),
    submenu('D', [item('E', noop)], { enabled: false }),
  ];

  it('skips separators and disabled entries', () => {
    expect(nextEnabled(entries, 0, 1)).toBe(3);
    expect(nextEnabled(entries, 3, -1)).toBe(0);
  });

  it('wraps at both ends', () => {
    expect(nextEnabled(entries, 3, 1)).toBe(0);
    expect(nextEnabled(entries, 0, -1)).toBe(3);
  });

  it('starts from either end with a negative index', () => {
    expect(nextEnabled(entries, -1, 1)).toBe(0);
    expect(nextEnabled(entries, -1, -1)).toBe(3);
  });

  it('returns -1 with nothing enabled', () => {
    expect(nextEnabled([separator(), item('X', noop, { enabled: false })], -1, 1)).toBe(-1);
    expect(nextEnabled([], -1, 1)).toBe(-1);
  });
});

describe('isKeyboardContextMenu', () => {
  it('treats button 0 with no pointer type as the keyboard', () => {
    expect(isKeyboardContextMenu({ button: 0, pointerType: '' })).toBe(true);
    expect(isKeyboardContextMenu({ button: 0 })).toBe(true);
  });

  it('treats a right-click as the pointer', () => {
    expect(isKeyboardContextMenu({ button: 2, pointerType: 'mouse' })).toBe(false);
    expect(isKeyboardContextMenu({ button: 2, pointerType: '' })).toBe(false);
    expect(isKeyboardContextMenu({ button: 0, pointerType: 'pen' })).toBe(false);
  });
});

describe('isKeyboardContextMenu with a menu keydown', () => {
  const mouseLike = { button: -1, pointerType: 'mouse' };
  it('treats a contextmenu right after a menu key as keyboard even with mouse-like fields', () => {
    expect(isKeyboardContextMenu({ ...mouseLike, timeStamp: 1100 }, 1000)).toBe(true);
    expect(isKeyboardContextMenu({ ...mouseLike, timeStamp: 1000 }, 1000)).toBe(true);
  });
  it('ignores a menu key that is too old, in the future, or absent', () => {
    expect(isKeyboardContextMenu({ ...mouseLike, timeStamp: 1501 }, 1000)).toBe(false);
    expect(isKeyboardContextMenu({ ...mouseLike, timeStamp: 900 }, 1000)).toBe(false);
    expect(isKeyboardContextMenu({ ...mouseLike, timeStamp: 1100 }, null)).toBe(false);
  });
  it('never calls a right-click keyboard', () => {
    expect(isKeyboardContextMenu({ button: 2, pointerType: 'mouse', timeStamp: 1100 }, 1000)).toBe(false);
  });
  it('falls back to the field heuristic', () => {
    expect(isKeyboardContextMenu({ button: 0, pointerType: '', timeStamp: 5000 }, 1000)).toBe(true);
  });
});

describe('isMenuKey', () => {
  const k = (key: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
    isMenuKey({ key, shiftKey: false, ctrlKey: false, altKey: false, ...mods });
  it('accepts ContextMenu and Shift+F10', () => {
    expect(k('ContextMenu')).toBe(true);
    expect(k('F10', { shiftKey: true })).toBe(true);
  });
  it('rejects plain F10, extra modifiers, and other keys', () => {
    expect(k('F10')).toBe(false);
    expect(k('F10', { shiftKey: true, ctrlKey: true })).toBe(false);
    expect(k('a', { shiftKey: true })).toBe(false);
  });
});
