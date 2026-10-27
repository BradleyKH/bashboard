import { describe, expect, it } from 'vitest';
import {
  absolutePath,
  applyBatch,
  emptyResults,
  flatten,
  footerText,
  highlightSegments,
  initialQuery,
  stepSelection,
  toggleGroup,
  withError,
  type SearchResults,
} from './searchModel';
import type { LineMatch } from './searchApi';

const m = (line: number, text = 'x', ranges: [number, number][] = []): LineMatch => ({ line, text, ranges });

function sample(): SearchResults {
  let s = emptyResults();
  s = applyBatch(s, { type: 'names', paths: ['a/foo.ts'] });
  s = applyBatch(s, { type: 'file', path: 'a.ts', matches: [m(1), m(2)] });
  s = applyBatch(s, { type: 'file', path: 'b.ts', matches: [m(7)] });
  return s;
}

describe('applyBatch', () => {
  it('applies batches in order and counts as they arrive', () => {
    const s = sample();
    expect(s.names).toEqual(['a/foo.ts']);
    expect(s.groups.map((g) => g.path)).toEqual(['a.ts', 'b.ts']);
    expect(s.matches).toBe(3);
    expect(s.files).toBe(2);
    expect(s.done).toBe(false);
  });

  it('takes the final totals from done', () => {
    const s = applyBatch(sample(), { type: 'done', files: 2, matches: 3, truncated: true });
    expect(s).toMatchObject({ done: true, truncated: true, matches: 3, files: 2 });
  });

  it('does not mutate the previous state', () => {
    const before = sample();
    applyBatch(before, { type: 'file', path: 'c.ts', matches: [m(1)] });
    expect(before.groups).toHaveLength(2);
  });
});

describe('withError', () => {
  it('records the message and ends the search', () => {
    expect(withError(emptyResults(), 'bad regex')).toMatchObject({ error: 'bad regex', done: true });
  });
});

describe('flatten and toggleGroup', () => {
  it('lists names first, then each group matches', () => {
    const items = flatten(sample());
    expect(items.map((i) => (i.kind === 'name' ? i.path : `${i.path}:${i.match.line}`))).toEqual([
      'a/foo.ts',
      'a.ts:1',
      'a.ts:2',
      'b.ts:7',
    ]);
  });

  it('skips the matches of a collapsed group', () => {
    const s = toggleGroup(sample(), 'a.ts');
    expect(s.groups[0].collapsed).toBe(true);
    expect(flatten(s)).toHaveLength(2);
    expect(flatten(toggleGroup(s, 'a.ts'))).toHaveLength(4);
  });
});

describe('stepSelection', () => {
  const items = flatten(sample());
  it('starts at the first item from no selection', () => {
    expect(stepSelection(items, null, 1)).toBe(0);
    expect(stepSelection(items, null, -1)).toBe(0);
  });
  it('clamps at both ends', () => {
    expect(stepSelection(items, 3, 1)).toBe(3);
    expect(stepSelection(items, 0, -1)).toBe(0);
    expect(stepSelection(items, 1, 1)).toBe(2);
  });
  it('returns null for an empty list', () => {
    expect(stepSelection([], null, 1)).toBeNull();
  });
});

describe('highlightSegments', () => {
  it('splits around ranges', () => {
    expect(highlightSegments('abcdef', [[1, 3]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'def', hit: false },
    ]);
  });
  it('handles adjacent ranges and both edges', () => {
    expect(highlightSegments('abcd', [[0, 2], [2, 4]])).toEqual([
      { text: 'ab', hit: true },
      { text: 'cd', hit: true },
    ]);
  });
  it('returns the whole line with no ranges and nothing for empty text', () => {
    expect(highlightSegments('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(highlightSegments('', [])).toEqual([]);
  });
  it('clamps ranges past the end and ignores empty ones', () => {
    expect(highlightSegments('abc', [[2, 9], [1, 1]])).toEqual([
      { text: 'ab', hit: false },
      { text: 'c', hit: true },
    ]);
  });
});

describe('footerText', () => {
  it('is blank before anything arrives and says No results when done empty', () => {
    expect(footerText(emptyResults())).toBe('');
    expect(footerText({ ...emptyResults(), done: true })).toBe('No results');
  });
  it('counts results and files', () => {
    const s = applyBatch(sample(), { type: 'done', files: 2, matches: 3, truncated: false });
    expect(footerText(s)).toBe('3 results in 2 files, 1 file name');
    const one = applyBatch(
      applyBatch(emptyResults(), { type: 'file', path: 'a', matches: [m(1)] }),
      { type: 'done', files: 1, matches: 1, truncated: false },
    );
    expect(footerText(one)).toBe('1 result in 1 file');
  });
  it('says the results stop at the first 5,000 when truncated', () => {
    const s = applyBatch(sample(), { type: 'done', files: 2, matches: 5000, truncated: true });
    expect(footerText(s)).toContain('first 5,000');
  });
  it('trails with an ellipsis while running and is blank on error', () => {
    expect(footerText(sample()).endsWith('...')).toBe(true);
    expect(footerText(withError(emptyResults(), 'x'))).toBe('');
  });
});

describe('absolutePath', () => {
  it('uses backslashes for a drive root', () => {
    expect(absolutePath('C:\\repo', 'src/a/b.ts')).toBe('C:\\repo\\src\\a\\b.ts');
    expect(absolutePath('C:\\repo\\', 'a.ts')).toBe('C:\\repo\\a.ts');
    expect(absolutePath('C:/repo', 'a.ts')).toBe('C:\\repo\\a.ts');
  });
  it('uses forward slashes otherwise', () => {
    expect(absolutePath('/home/me/repo', 'src/a.ts')).toBe('/home/me/repo/src/a.ts');
    expect(absolutePath('/home/me/repo/', 'a.ts')).toBe('/home/me/repo/a.ts');
  });
});

describe('initialQuery', () => {
  it('trims a single line', () => {
    expect(initialQuery('  foo bar \n')).toBe('foo bar');
  });
  it('rejects empty and multi-line selections', () => {
    expect(initialQuery('')).toBe('');
    expect(initialQuery('   ')).toBe('');
    expect(initialQuery('a\nb')).toBe('');
    expect(initialQuery('a\r\nb')).toBe('');
  });
});
