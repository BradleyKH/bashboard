import { describe, expect, it } from 'vitest';
import { findMatches, matchAtOrAfter, matchCountText, stepMatch } from './previewFindModel';

describe('findMatches', () => {
  it('ignores case and returns offsets in order', () => {
    expect(findMatches('Foo bar FOO foo', 'foo').ranges).toEqual([
      [0, 3],
      [8, 11],
      [12, 15],
    ]);
  });

  it('treats the query literally', () => {
    expect(findMatches('a.b axb (x)', '.').ranges).toEqual([[1, 2]]);
    expect(findMatches('a.b axb (x)', '(x)').ranges).toEqual([[8, 11]]);
  });

  it('does not overlap matches', () => {
    expect(findMatches('aaaa', 'aa').ranges).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('finds nothing for an empty query', () => {
    expect(findMatches('abc', '')).toEqual({ ranges: [], capped: false });
  });

  it('stops at the limit', () => {
    const found = findMatches('xxxxx', 'x', 3);
    expect(found.ranges).toHaveLength(3);
    expect(found.capped).toBe(true);
    expect(findMatches('xxx', 'x', 3).capped).toBe(false);
  });
});

describe('matchAtOrAfter', () => {
  const ranges: [number, number][] = [
    [2, 4],
    [10, 12],
  ];

  it('picks the first match at or after the offset', () => {
    expect(matchAtOrAfter(ranges, 0)).toBe(0);
    expect(matchAtOrAfter(ranges, 10)).toBe(1);
  });

  it('wraps to the first match past the last', () => {
    expect(matchAtOrAfter(ranges, 11)).toBe(0);
  });

  it('is -1 with no matches', () => {
    expect(matchAtOrAfter([], 0)).toBe(-1);
  });
});

describe('stepMatch', () => {
  it('wraps in both directions', () => {
    expect(stepMatch(2, 3, 'next')).toBe(0);
    expect(stepMatch(0, 3, 'previous')).toBe(2);
    expect(stepMatch(1, 3, 'next')).toBe(2);
  });

  it('starts from an end when nothing is current', () => {
    expect(stepMatch(-1, 3, 'next')).toBe(0);
    expect(stepMatch(-1, 3, 'previous')).toBe(2);
    expect(stepMatch(-1, 0, 'next')).toBe(-1);
  });
});

describe('matchCountText', () => {
  it('reads like the terminal find bar', () => {
    expect(matchCountText('', -1, { ranges: [], capped: false })).toBe('');
    expect(matchCountText('x', -1, { ranges: [], capped: false })).toBe('No results');
    expect(matchCountText('x', 1, { ranges: [[0, 1], [2, 3]], capped: false })).toBe('2 of 2');
    expect(matchCountText('x', 0, { ranges: [[0, 1]], capped: true })).toBe('1+ matches');
  });
});
