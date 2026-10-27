import { describe, expect, it } from 'vitest';
import { moveItem, parseFavorites, recentFolders, samePath } from './favorites';
import type { Session } from './sessions';

function session(cwd: string, statusChangedAt: number): Session {
  return {
    sessionId: `s${statusChangedAt}`,
    pid: 1,
    name: null,
    cwd,
    status: 'idle',
    statusChangedAt,
    startedAt: 0,
    version: null,
    paneId: null,
  };
}

describe('parseFavorites', () => {
  it('keeps valid entries in order', () => {
    expect(
      parseFavorites([
        { label: 'App', path: 'C:/src/app' },
        { label: 'Docs', path: '/c/docs' },
      ]),
    ).toEqual([
      { label: 'App', path: 'C:/src/app' },
      { label: 'Docs', path: '/c/docs' },
    ]);
  });

  it('defaults an empty or missing label to the last folder', () => {
    expect(parseFavorites([{ label: '  ', path: '/c/src/app/' }, { path: '/c/docs' }])).toEqual([
      { label: 'app', path: '/c/src/app/' },
      { label: 'docs', path: '/c/docs' },
    ]);
  });

  it('drops invalid entries and non-arrays', () => {
    expect(
      parseFavorites([null, 3, 'x', {}, { label: 'a' }, { label: 'a', path: '' }, { path: 5 }]),
    ).toEqual([]);
    expect(parseFavorites({ path: 'x' })).toEqual([]);
    expect(parseFavorites(null)).toEqual([]);
  });
});

describe('samePath', () => {
  it('ignores case, separator style, and trailing separators', () => {
    expect(samePath('C:' + String.fromCharCode(92) + 'Src', 'c:/src/')).toBe(true);
    expect(samePath('/c/a/b' + String.fromCharCode(92), '/C/A/B')).toBe(true);
    expect(samePath('/c/a', '/c/b')).toBe(false);
    expect(samePath('/c/a', '/c/a/b')).toBe(false);
  });
});

describe('recentFolders', () => {
  it('orders by most recent status change and dedupes', () => {
    const sessions = [session('/a', 1), session('/b', 5), session('/A/', 9), session('/c', 3)];
    expect(recentFolders(sessions, [])).toEqual(['/A/', '/b', '/c']);
  });

  it('excludes favorites', () => {
    const sessions = [session('C:/x', 2), session('/y', 1)];
    expect(recentFolders(sessions, [{ label: 'x', path: 'c:/X/' }])).toEqual(['/y']);
  });

  it('honors the limit and defaults to 5', () => {
    const sessions = Array.from({ length: 8 }, (_, i) => session(`/d${i}`, i));
    expect(recentFolders(sessions, [])).toHaveLength(5);
    expect(recentFolders(sessions, [], 2)).toEqual(['/d7', '/d6']);
  });

  it('does not mutate the input', () => {
    const sessions = [session('/a', 1), session('/b', 2)];
    recentFolders(sessions, []);
    expect(sessions[0].cwd).toBe('/a');
  });
});

describe('moveItem', () => {
  it('moves forward and backward', () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
    expect(moveItem([1, 2, 3, 4], 3, 1)).toEqual([1, 4, 2, 3]);
  });

  it('returns an unchanged copy for same or out-of-range indices', () => {
    const list = [1, 2, 3];
    expect(moveItem(list, 1, 1)).toEqual([1, 2, 3]);
    expect(moveItem(list, -1, 1)).toEqual([1, 2, 3]);
    expect(moveItem(list, 0, 3)).toEqual([1, 2, 3]);
    expect(moveItem(list, 0, 2)).not.toBe(list);
    expect(list).toEqual([1, 2, 3]);
  });
});

describe('parseFavorites profile', () => {
  it('keeps a well-formed profile id and drops bad ones', () => {
    const out = parseFavorites([
      { path: '/a', profile: 'cmd' },
      { path: '/b', profile: 'not valid' },
      { path: '/c' },
    ]);
    expect(out[0].profile).toBe('cmd');
    expect(out[1]).not.toHaveProperty('profile');
    expect(out[2]).not.toHaveProperty('profile');
  });
});
