import { describe, expect, it } from 'vitest';
import { isBackdropVisible } from './backdropVisibility';

describe('isBackdropVisible', () => {
  it('is visible only when the document is visible and the window is not minimized', () => {
    expect(isBackdropVisible(true, false)).toBe(true);
    expect(isBackdropVisible(false, false)).toBe(false);
    expect(isBackdropVisible(true, true)).toBe(false);
    expect(isBackdropVisible(false, true)).toBe(false);
  });
});
