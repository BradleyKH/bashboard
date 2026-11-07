import { describe, expect, it } from 'vitest';
import type { Listener } from './ports';
import {
  RecentUrls,
  isBookmarked,
  isLoopbackUrl,
  normalizeInput,
  suggestions,
  toggleBookmark,
  type Bookmark,
} from './localBrowserModel';

const APP = 'http://localhost:1420';

function ok(text: string, app: string | null = APP): string {
  const r = normalizeInput(text, app);
  if (!r.ok) throw new Error(`expected ok for "${text}": ${r.reason}`);
  return r.url;
}

function refused(text: string, app: string | null = APP): string {
  const r = normalizeInput(text, app);
  if (r.ok) throw new Error(`expected refusal for "${text}", got ${r.url}`);
  return r.reason;
}

describe('normalizeInput', () => {
  it('expands port shorthands', () => {
    expect(ok('5173')).toBe('http://localhost:5173/');
    expect(ok(':8080')).toBe('http://localhost:8080/');
    expect(ok('  3000  ')).toBe('http://localhost:3000/');
  });

  it('adds http to host forms', () => {
    expect(ok('localhost:3000/x')).toBe('http://localhost:3000/x');
    expect(ok('localhost')).toBe('http://localhost/');
    expect(ok('127.0.0.1:5199/p1')).toBe('http://127.0.0.1:5199/p1');
  });

  it('keeps full loopback URLs, query and hash included', () => {
    expect(ok('http://localhost:3000/a?b=1#c')).toBe('http://localhost:3000/a?b=1#c');
    expect(ok('HTTP://LOCALHOST:3000')).toBe('http://localhost:3000/');
  });

  it('refuses empty input, bad ports, and spaces', () => {
    refused('');
    refused('0');
    refused('70000');
    refused('local host');
  });

  it('refuses non-loopback hosts', () => {
    refused('example.com');
    refused('http://example.com');
    refused('localhost.evil.com');
    refused('http://localhost.evil.com:3000');
    refused('http://127.0.0.2:3000');
    refused('http://0.0.0.0:3000');
  });

  it('refuses *.localhost and the app origin host', () => {
    refused('app.localhost:3000');
    refused('http://tauri.localhost');
  });

  it('refuses IPv6 loopback, which the frame cannot load', () => {
    refused('[::1]:4000');
    refused('http://[::1]:4000/');
  });

  it('refuses https and other schemes, with an https-specific reason', () => {
    expect(refused('https://localhost:3000')).toMatch(/https/);
    refused('ftp://localhost');
    refused('file:///C:/x');
    refused('javascript:alert(1)');
  });

  it('refuses credentials', () => {
    refused('http://user:pw@localhost:3000');
    refused('http://localhost@evil.com');
  });

  it('refuses the app origin, including by port shorthand', () => {
    refused('1420');
    refused('http://localhost:1420/anything');
    refused('127.0.0.1:1420');
    expect(ok('1421')).toBe('http://localhost:1421/');
  });

  it('accepts anything loopback when the app origin is unknown', () => {
    expect(ok('1420', null)).toBe('http://localhost:1420/');
  });
});

describe('isLoopbackUrl', () => {
  it('matches the policy', () => {
    expect(isLoopbackUrl('http://localhost:3000/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(false);
    expect(isLoopbackUrl('https://localhost:3000')).toBe(false);
    expect(isLoopbackUrl('http://a.localhost')).toBe(false);
    expect(isLoopbackUrl('nonsense')).toBe(false);
  });
});

describe('bookmarks', () => {
  const marks: Bookmark[] = [{ name: 'Vite', url: 'http://localhost:5173/' }];

  it('isBookmarked ignores a missing trailing slash', () => {
    expect(isBookmarked(marks, 'http://localhost:5173')).toBe(true);
    expect(isBookmarked(marks, 'http://localhost:5174')).toBe(false);
  });

  it('toggleBookmark adds, then removes, without mutating', () => {
    const added = toggleBookmark(marks, 'http://localhost:3000/docs', 'Docs');
    expect(added).toEqual([...marks, { name: 'Docs', url: 'http://localhost:3000/docs' }]);
    expect(marks.length).toBe(1);
    expect(toggleBookmark(added, 'http://localhost:3000/docs', 'Docs')).toEqual(marks);
  });

  it('falls back to the host for a blank title', () => {
    expect(toggleBookmark([], 'http://localhost:3000/', '  ')[0].name).toBe('localhost:3000');
  });
});

describe('RecentUrls', () => {
  it('keeps most recent first and de-duplicates', () => {
    const r = new RecentUrls();
    r.add('a');
    r.add('b');
    r.add('a');
    expect(r.list()).toEqual(['a', 'b']);
  });

  it('caps at 50', () => {
    const r = new RecentUrls();
    for (let i = 0; i < 60; i++) r.add(`http://localhost:${3000 + i}/`);
    expect(r.list().length).toBe(50);
    expect(r.list()[0]).toBe('http://localhost:3059/');
  });

  it('cleans an initial list', () => {
    expect(new RecentUrls(['a', 'b', 'a'], 2).list()).toEqual(['a', 'b']);
    expect(new RecentUrls(['a', 'b', 'c'], 2).list()).toEqual(['a', 'b']);
  });
});

function listener(over: Partial<Listener> = {}): Listener {
  return {
    port: 5173,
    addresses: ['127.0.0.1'],
    pid: 100,
    startedAt: 1,
    name: 'node.exe',
    command: '',
    cwd: null,
    ptyId: null,
    fromShell: false,
    system: false,
    own: false,
    ...over,
  };
}

describe('suggestions', () => {
  const bookmarks: Bookmark[] = [{ name: 'Docs', url: 'http://localhost:3000/docs' }];
  const recent = ['http://localhost:5173/', 'http://localhost:8080/app'];
  const listeners = [listener(), listener({ port: 445, name: 'System', system: true }), listener({ port: 1420, own: true })];

  it('lists bookmarks, then ports, then recents, de-duplicated by URL', () => {
    const s = suggestions('', { bookmarks, listeners, recent });
    expect(s.map((x) => [x.source, x.url])).toEqual([
      ['bookmark', 'http://localhost:3000/docs'],
      ['port', 'http://localhost:5173'],
      ['recent', 'http://localhost:8080/app'],
    ]);
    expect(s[1].label).toBe('localhost:5173 (node)');
  });

  it('skips system and own listeners', () => {
    const s = suggestions('', { bookmarks: [], listeners, recent: [] });
    expect(s.map((x) => x.url)).toEqual(['http://localhost:5173']);
  });

  it('filters by query and ranks prefix matches first', () => {
    const s = suggestions('docs', { bookmarks, listeners, recent });
    expect(s.map((x) => x.source)).toEqual(['bookmark']);

    const t = suggestions('5173', { bookmarks: [], listeners: [], recent: ['http://localhost:15173/', 'http://localhost:5173/x'] });
    expect(t.map((x) => x.url)).toEqual(['http://localhost:5173/x', 'http://localhost:15173/']);
  });

  it('matches case-insensitively and returns nothing for no match', () => {
    expect(suggestions('NODE', { bookmarks: [], listeners, recent: [] }).length).toBe(1);
    expect(suggestions('zzz', { bookmarks, listeners, recent })).toEqual([]);
  });

  it('collapses a port shared by several processes', () => {
    const s = suggestions('', { bookmarks: [], listeners: [listener(), listener({ pid: 101, addresses: ['::1'] })], recent: [] });
    expect(s.length).toBe(1);
  });
});
