import { describe, expect, it } from 'vitest';
import { ACTION_LABELS, HELP_SECTIONS, actionLabel, actionOrder, formatChord, sendInputLabel } from './helpModel';
import { ACTION_NAMES, DEFAULT_KEYBINDINGS, parseChord } from './keymap';

describe('formatChord', () => {
  it('orders modifiers and capitalizes keys', () => {
    expect(formatChord(parseChord('shift+ctrl+f')!)).toBe('Ctrl+Shift+F');
    expect(formatChord(parseChord('alt+pagedown')!)).toBe('Alt+PageDown');
    expect(formatChord(parseChord('f1')!)).toBe('F1');
    expect(formatChord(parseChord('win+right')!)).toBe('Win+Right');
  });
});

describe('actionLabel and actionOrder', () => {
  it('labels actions and directions', () => {
    expect(actionLabel('openPalette')).toBe('Command palette');
    expect(actionLabel('moveFocus', 'left')).toBe('Move focus left');
    expect(actionLabel('resizePane', 'down')).toBe('Resize pane down');
    expect(actionLabel('nope')).toBeUndefined();
  });

  it('lists every action in guide order', () => {
    const order = actionOrder();
    expect(order).toContain('openPalette');
    expect(order).toContain('nextAttention');
  });
});

describe('help coverage of the action list', () => {
  it('puts every action name in exactly one section, with a label unless it is sendInput', () => {
    for (const name of ACTION_NAMES) {
      expect(HELP_SECTIONS.filter((s) => s.actions.includes(name)), name).toHaveLength(1);
      if (name !== 'sendInput') expect(ACTION_LABELS[name], name).toBeTruthy();
    }
  });

  it('labels the Shift+Enter input as the Claude Code newline', () => {
    expect(sendInputLabel(DEFAULT_KEYBINDINGS.find((e) => e.action === 'sendInput')!.input!)).toBe('Claude Code newline');
  });
});
