import { describe, expect, it } from 'vitest';
import { restoreIndex, stepIndex } from './dashboardNavModel';

describe('stepIndex', () => {
  it('moves down and up one row', () => {
    expect(stepIndex(5, 2, 'next')).toBe(3);
    expect(stepIndex(5, 2, 'prev')).toBe(1);
  });

  it('stops at the ends instead of wrapping', () => {
    expect(stepIndex(5, 4, 'next')).toBe(4);
    expect(stepIndex(5, 0, 'prev')).toBe(0);
  });

  it('jumps to the first and last row', () => {
    expect(stepIndex(5, 2, 'first')).toBe(0);
    expect(stepIndex(5, 2, 'last')).toBe(4);
  });

  it('starts at the top going down and the bottom going up with no current row', () => {
    expect(stepIndex(5, -1, 'next')).toBe(0);
    expect(stepIndex(5, -1, 'prev')).toBe(4);
  });

  it('returns -1 for an empty list', () => {
    expect(stepIndex(0, -1, 'next')).toBe(-1);
    expect(stepIndex(0, 0, 'first')).toBe(-1);
  });
});

describe('restoreIndex', () => {
  it('finds the same row after a rebuild, wherever it moved', () => {
    expect(restoreIndex(['a', 'b', 'c'], 'c', 0)).toBe(2);
  });

  it('falls back to the old position when the row is gone', () => {
    expect(restoreIndex(['a', 'c', 'd'], 'b', 1)).toBe(1);
  });

  it('clamps the old position to the shorter list', () => {
    expect(restoreIndex(['a'], 'z', 3)).toBe(0);
  });

  it('returns -1 for an empty list', () => {
    expect(restoreIndex([], 'a', 0)).toBe(-1);
  });
});
