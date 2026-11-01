import { describe, expect, it } from 'vitest';
import { selectionAfterRefresh } from './pickerSelection';

describe('selectionAfterRefresh', () => {
  it('follows the selected value to its new index', () => {
    expect(selectionAfterRefresh('b', 1, ['x', 'a', 'y', 'b'])).toBe(3);
  });
  it('clamps the old index when the value is gone', () => {
    expect(selectionAfterRefresh('b', 5, ['a', 'c'])).toBe(1);
    expect(selectionAfterRefresh('b', 1, ['a', 'c', 'd'])).toBe(1);
  });
  it('returns 0 for an empty list or no prior selection', () => {
    expect(selectionAfterRefresh('b', 3, [])).toBe(0);
    expect(selectionAfterRefresh(undefined, 0, ['a'])).toBe(0);
  });
});
