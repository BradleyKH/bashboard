import { describe, expect, it } from 'vitest';
import { hiddenNotice, revealTitle, withKeys } from './dashboardRevealModel';

describe('withKeys', () => {
  it('appends the bound keys in parentheses', () => {
    expect(withKeys('Settings', 'Ctrl+,')).toBe('Settings (Ctrl+,)');
  });

  it('leaves the title bare when the action is unbound', () => {
    expect(withKeys('Settings', undefined)).toBe('Settings');
  });
});

describe('revealTitle', () => {
  it('names the bound keys', () => {
    expect(revealTitle('Ctrl+Shift+D')).toBe('Show the dashboard (Ctrl+Shift+D)');
  });

  it('leaves the keys out when the toggle is unbound', () => {
    expect(revealTitle(undefined)).toBe('Show the dashboard');
  });
});

describe('hiddenNotice', () => {
  it('names the keys and the handle on the docked side', () => {
    expect(hiddenNotice('Ctrl+Shift+D', 'right')).toBe(
      "Dashboard hidden. Press Ctrl+Shift+D or click the handle on the window's right edge to bring it back.",
    );
  });

  it('points only at the handle when the toggle is unbound', () => {
    expect(hiddenNotice(undefined, 'left')).toBe(
      "Dashboard hidden. Click the handle on the window's left edge to bring it back.",
    );
  });
});
