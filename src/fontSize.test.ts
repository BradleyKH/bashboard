import { describe, expect, it } from 'vitest';
import { DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE, stepFontSize } from './fontSize';

describe('stepFontSize', () => {
  it('steps by one pixel', () => {
    expect(stepFontSize(14, 1)).toBe(15);
    expect(stepFontSize(14, -1)).toBe(13);
  });
  it('clamps to the settings range', () => {
    expect(stepFontSize(MAX_FONT_SIZE, 1)).toBe(MAX_FONT_SIZE);
    expect(stepFontSize(MIN_FONT_SIZE, -1)).toBe(MIN_FONT_SIZE);
    expect(stepFontSize(100, 1)).toBe(MAX_FONT_SIZE);
    expect(stepFontSize(1, -1)).toBe(MIN_FONT_SIZE);
  });
  it('rounds fractional sizes to whole pixels', () => {
    expect(stepFontSize(13.5, 1)).toBe(15);
    expect(stepFontSize(13.4, 1)).toBe(14);
  });
  it('defaults to 14', () => {
    expect(DEFAULT_FONT_SIZE).toBe(14);
  });
});
