import { describe, expect, it } from 'vitest';
import { DEFAULT_SEARCH_OPTIONS, parseSearchOptions } from './searchOptions';

describe('parseSearchOptions', () => {
  it('returns the defaults for an empty object', () => {
    expect(parseSearchOptions({})).toEqual(DEFAULT_SEARCH_OPTIONS);
    expect(DEFAULT_SEARCH_OPTIONS).toEqual({ caseSensitive: false, wholeWord: false, regex: false, include: '' });
  });

  it('keeps a full valid object', () => {
    const o = { caseSensitive: true, wholeWord: true, regex: true, include: '*.ts, src/**' };
    expect(parseSearchOptions(o)).toEqual(o);
  });

  it('falls back per field for partial and garbage input', () => {
    expect(parseSearchOptions({ caseSensitive: true, wholeWord: 'yes', regex: 1, include: 5 })).toEqual({
      ...DEFAULT_SEARCH_OPTIONS,
      caseSensitive: true,
    });
  });

  it('returns the defaults for a non-object', () => {
    for (const raw of [null, undefined, 'x', 3, true, []]) {
      expect(parseSearchOptions(raw)).toEqual(DEFAULT_SEARCH_OPTIONS);
    }
  });

  it('returns a fresh object each time', () => {
    expect(parseSearchOptions(null)).not.toBe(DEFAULT_SEARCH_OPTIONS);
  });
});
