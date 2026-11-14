import { describe, expect, it } from 'vitest';
import { tourParagraph } from './helpTour';
import { ACTION_NAMES, DEFAULT_KEYBINDINGS } from './keymap';
import { advance, panesToClose, TOUR_STEPS } from './tourModel';

describe('advance', () => {
  it('moves on when the step sees what it waits for', () => {
    expect(advance(0, { type: 'paneOpened', kind: 'terminal' })).toBe(1);
    expect(advance(1, { type: 'action', action: 'moveFocus' })).toBe(2);
    expect(advance(2, { type: 'paneOpened', kind: 'files' })).toBe(3);
    expect(advance(2, { type: 'launched', kind: 'files' })).toBe(3);
    expect(advance(2, { type: 'action', action: 'openFiles' })).toBe(3);
    expect(advance(3, { type: 'action', action: 'openPalette' })).toBe(4);
    expect(advance(4, { type: 'saved' })).toBe(5);
    expect(advance(6, { type: 'dialog', tab: 'settings' })).toBe(7);
  });

  it('stays put on anything else', () => {
    expect(advance(0, { type: 'action', action: 'splitRight' })).toBe(0);
    expect(advance(2, { type: 'paneOpened', kind: 'git' })).toBe(2);
    expect(advance(6, { type: 'dialog', tab: 'help' })).toBe(6);
  });

  it('leaves a reading step for Next', () => {
    expect(advance(5, { type: 'action', action: 'toggleDashboard' })).toBe(5);
  });

  it('ignores signals past the end', () => {
    expect(advance(TOUR_STEPS.length, { type: 'saved' })).toBe(TOUR_STEPS.length);
  });
});

describe('panesToClose', () => {
  it('closes only the tour’s panes', () => {
    expect(panesToClose(['a', 'b', 'c'], new Set(['b', 'c', 'gone']))).toEqual(['b', 'c']);
  });

  it('keeps one pane when all of them are the tour’s', () => {
    expect(panesToClose(['b', 'c'], new Set(['b', 'c']))).toEqual(['c']);
  });
});

describe('TOUR_STEPS', () => {
  it('names only actions bound by default', () => {
    for (const step of TOUR_STEPS) {
      for (const part of tourParagraph(step.text, DEFAULT_KEYBINDINGS)) {
        expect(part).not.toHaveProperty('unbound');
      }
    }
  });

  it('names only real actions', () => {
    for (const step of TOUR_STEPS) {
      for (const m of step.text.matchAll(/\{(\w+)/g)) expect(ACTION_NAMES).toContain(m[1]);
    }
  });
});
