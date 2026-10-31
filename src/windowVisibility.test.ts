import { describe, expect, it } from 'vitest';
import { isWindowVisible } from './windowVisibility';

describe('isWindowVisible', () => {
  it('is visible only when the document is visible and the window is not minimized', () => {
    expect(isWindowVisible(true, false)).toBe(true);
    expect(isWindowVisible(false, false)).toBe(false);
    expect(isWindowVisible(true, true)).toBe(false);
    expect(isWindowVisible(false, true)).toBe(false);
  });
});
