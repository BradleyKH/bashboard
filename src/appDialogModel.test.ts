import { describe, expect, it } from 'vitest';
import { DIALOG_TABS, DIALOG_TAB_FOR_ACTION, DIALOG_TAB_LABELS, stepTab } from './appDialogModel';
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
