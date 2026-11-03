import { describe, expect, it } from 'vitest';
import { hiddenNotice, revealTitle } from './dashboardRevealModel';

describe('revealTitle', () => {
  it('names the bound keys', () => {
    expect(revealTitle('Ctrl+Shift+S')).toBe('Show the dashboard (Ctrl+Shift+S)');
  });

  it('leaves the keys out when the toggle is unbound', () => {
    expect(revealTitle(undefined)).toBe('Show the dashboard');
  });
});

describe('hiddenNotice', () => {
  it('names the keys and the handle on the docked side', () => {
    expect(hiddenNotice('Ctrl+Shift+S', 'right')).toBe(
      "Dashboard hidden. Press Ctrl+Shift+S or click the handle on the window's right edge to bring it back.",
    );
  });

  it('points only at the handle when the toggle is unbound', () => {
    expect(hiddenNotice(undefined, 'left')).toBe(
      "Dashboard hidden. Click the handle on the window's left edge to bring it back.",
    );
  });
});
