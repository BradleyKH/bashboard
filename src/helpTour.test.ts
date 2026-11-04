import { describe, expect, it } from 'vitest';
import { tourActions, tourParagraph, tourSections } from './helpTour';
import { ACTION_NAMES, DEFAULT_KEYBINDINGS, type KeybindingEntry } from './keymap';

describe('tourParagraph', () => {
  it('resolves tokens to the live keys', () => {
    const entries = [{ keys: 'ctrl+shift+d', action: 'toggleDashboard' }];
    expect(tourParagraph('Press {toggleDashboard} now.', entries)).toEqual([
      { text: 'Press ' },
      { keys: ['Ctrl+Shift+D'] },
      { text: ' now.' },
    ]);
  });

  it('lists every chord bound to the action', () => {
    const entries = [
      { keys: 'ctrl+=', action: 'increaseFontSize' },
      { keys: 'ctrl++', action: 'increaseFontSize' },
    ];
    expect(tourParagraph('{increaseFontSize}', entries)).toEqual([{ keys: ['Ctrl+=', 'Ctrl++'] }]);
  });

  it('marks an action with no keys', () => {
    expect(tourParagraph('{openLayout}', [])).toEqual([{ unbound: 'openLayout' }]);
  });

  it('honors a direction', () => {
    const entries: KeybindingEntry[] = [
      { keys: 'alt+left', action: 'moveFocus', direction: 'left' },
      { keys: 'alt+right', action: 'moveFocus', direction: 'right' },
    ];
    expect(tourParagraph('{moveFocus:left}', entries)).toEqual([{ keys: ['Alt+Left'] }]);
  });
});

describe('the tour', () => {
  it('names only real actions', () => {
    for (const a of tourActions()) expect(ACTION_NAMES).toContain(a);
  });

  it('has a default key for every action it names', () => {
    for (const s of tourSections(DEFAULT_KEYBINDINGS)) {
      for (const p of s.paragraphs) expect(p.some((part) => 'unbound' in part)).toBe(false);
    }
  });
});
