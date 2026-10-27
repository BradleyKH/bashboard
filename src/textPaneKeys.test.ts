import { describe, expect, it } from 'vitest';
import type { Action } from './keymap';
import { textFieldOwns } from './textPaneKeys';

describe('textFieldOwns', () => {
  it('claims copy, paste, send input, and find for the pane', () => {
    expect(textFieldOwns({ type: 'copy' })).toBe(true);
    expect(textFieldOwns({ type: 'paste' })).toBe(true);
    expect(textFieldOwns({ type: 'sendInput', input: '\r' })).toBe(true);
    expect(textFieldOwns({ type: 'find' })).toBe(true);
  });

  it('leaves workspace actions to dispatch', () => {
    const others: Action[] = [
      { type: 'splitRight' },
      { type: 'splitDown' },
      { type: 'splitAuto' },
      { type: 'closePane' },
      { type: 'moveFocus', direction: 'left' },
      { type: 'resizePane', direction: 'left' },
      { type: 'toggleDashboard' },
      { type: 'cycleScrim' },
    ];
    for (const action of others) {
      expect(textFieldOwns(action), action.type).toBe(false);
    }
  });
});
