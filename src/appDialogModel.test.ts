import { describe, expect, it } from 'vitest';
import {
  DIALOG_TABS,
  DIALOG_TAB_FOR_ACTION,
  DIALOG_TAB_LABELS,
  dialogScrollDelta,
  SCROLL_LINE_PX,
  SCROLL_PAGE_OVERLAP_PX,
  stepTab,
} from './appDialogModel';
import { ACTION_NAMES } from './keymap';

describe('stepTab', () => {
  it('moves to the neighboring tab', () => {
    expect(stepTab('help', 1)).toBe('settings');
    expect(stepTab('settings', 1)).toBe('accounts');
    expect(stepTab('accounts', 1)).toBe('shortcuts');
    expect(stepTab('accounts', -1)).toBe('settings');
  });

  it('wraps at both ends', () => {
    expect(stepTab('about', 1)).toBe('help');
    expect(stepTab('help', -1)).toBe('about');
  });
});

describe('DIALOG_TAB_LABELS', () => {
  it('labels every tab', () => {
    for (const tab of DIALOG_TABS) expect(DIALOG_TAB_LABELS[tab]).toBeTruthy();
  });
});

describe('DIALOG_TAB_FOR_ACTION', () => {
  it('opens every tab from one real action', () => {
    expect(new Set(Object.values(DIALOG_TAB_FOR_ACTION))).toEqual(new Set(DIALOG_TABS));
    for (const action of Object.keys(DIALOG_TAB_FOR_ACTION)) expect(ACTION_NAMES).toContain(action);
  });
});

describe('dialogScrollDelta', () => {
  const plain = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  const box = { tag: 'div' };

  it('scrolls a line for the arrows and a page for Page Up and Page Down', () => {
    expect(dialogScrollDelta({ ...plain, key: 'ArrowDown' }, box, 500)).toBe(SCROLL_LINE_PX);
    expect(dialogScrollDelta({ ...plain, key: 'ArrowUp' }, box, 500)).toBe(-SCROLL_LINE_PX);
    expect(dialogScrollDelta({ ...plain, key: 'PageDown' }, box, 500)).toBe(500 - SCROLL_PAGE_OVERLAP_PX);
    expect(dialogScrollDelta({ ...plain, key: 'PageUp' }, box, 500)).toBe(-(500 - SCROLL_PAGE_OVERLAP_PX));
  });

  it('leaves chords and other keys alone', () => {
    expect(dialogScrollDelta({ ...plain, ctrlKey: true, key: 'PageDown' }, box, 500)).toBe(0);
    expect(dialogScrollDelta({ ...plain, shiftKey: true, key: 'ArrowDown' }, box, 500)).toBe(0);
    expect(dialogScrollDelta({ ...plain, key: 'ArrowLeft' }, box, 500)).toBe(0);
  });

  it('leaves the keys to controls that use them', () => {
    const down = { ...plain, key: 'ArrowDown' };
    expect(dialogScrollDelta(down, { tag: 'INPUT', type: 'number' }, 500)).toBe(0);
    expect(dialogScrollDelta(down, { tag: 'INPUT', type: 'range' }, 500)).toBe(0);
    expect(dialogScrollDelta(down, { tag: 'SELECT' }, 500)).toBe(0);
    expect(dialogScrollDelta(down, { tag: 'TEXTAREA' }, 500)).toBe(0);
    expect(dialogScrollDelta(down, { tag: 'div', editable: true }, 500)).toBe(0);
    expect(dialogScrollDelta(down, { tag: 'div', role: 'listbox' }, 500)).toBe(0);
  });

  it('scrolls from buttons, checkboxes, tab buttons, and one-line text fields', () => {
    const down = { ...plain, key: 'ArrowDown' };
    expect(dialogScrollDelta(down, { tag: 'BUTTON' }, 500)).toBe(SCROLL_LINE_PX);
    expect(dialogScrollDelta(down, { tag: 'INPUT', type: 'checkbox' }, 500)).toBe(SCROLL_LINE_PX);
    expect(dialogScrollDelta(down, { tag: 'BUTTON', role: 'tab' }, 500)).toBe(SCROLL_LINE_PX);
    expect(dialogScrollDelta(down, { tag: 'INPUT', type: 'search' }, 500)).toBe(SCROLL_LINE_PX);
  });
});
