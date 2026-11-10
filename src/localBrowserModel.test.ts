import { describe, expect, it } from 'vitest';
import type { Listener } from './ports';
import {
  RecentUrls,
  fileUrlToPath,
  hostLabel,
  isBookmarked,
  isLoopbackUrl,
  normalizeInput,
  pathToFileUrl,
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

const HOME = 'C:\\Users\\brad';

function file(text: string, home: string | null = HOME): { url: string; path: string } {
  const r = normalizeInput(text, APP, home);
  if (!r.ok) throw new Error(`expected ok for "${text}": ${r.reason}`);
  if (!r.file) throw new Error(`expected a file result for "${text}"`);
  return { url: r.url, path: r.path };
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
    expect(ok('https://localhost:7001/a')).toBe('https://localhost:7001/a');
    expect(ok('https://127.0.0.1:5001')).toBe('https://127.0.0.1:5001/');
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

  it('refuses other schemes and https off loopback', () => {
    refused('https://example.com');
    refused('https://app.localhost:7001');
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
    refused('https://localhost:1420');
    expect(ok('1421')).toBe('http://localhost:1421/');
  });

  it('accepts anything loopback when the app origin is unknown', () => {
    expect(ok('1420', null)).toBe('http://localhost:1420/');
  });
});

describe('normalizeInput with files', () => {
  const A = { url: 'file:///C:/notes/a.html', path: 'C:\\notes\\a.html' };

  it('marks loopback results as not files', () => {
    expect(normalizeInput('5173', APP)).toEqual({ ok: true, url: 'http://localhost:5173/', file: false });
  });

  it('accepts Windows paths with either slash', () => {
    expect(file('C:\\notes\\a.html')).toEqual(A);
    expect(file('C:/notes/a.html')).toEqual(A);
    expect(file('c:\\notes/a.HTM')).toEqual({ url: 'file:///C:/notes/a.HTM', path: 'C:\\notes\\a.HTM' });
  });

  it('accepts Git Bash paths', () => {
    expect(file('/c/notes/a.html')).toEqual(A);
    expect(file('/d/x/y.htm').url).toBe('file:///D:/x/y.htm');
  });

  it('expands ~/ against the home folder', () => {
    expect(file('~/reports/a.html')).toEqual({
      url: 'file:///C:/Users/brad/reports/a.html',
      path: 'C:\\Users\\brad\\reports\\a.html',
    });
    expect(file('~\\a.html', 'C:/Users/brad/').url).toBe('file:///C:/Users/brad/a.html');
    expect(refused('~/a.html', null)).toContain('home folder');
  });

  it('accepts file:/// URLs, decoding them', () => {
    expect(file('file:///C:/notes/a.html')).toEqual(A);
    expect(file('file:///c:/notes/a%20b.html')).toEqual({ url: 'file:///C:/notes/a%20b.html', path: 'C:\\notes\\a b.html' });
    expect(file('FILE://localhost/C:/notes/a.html')).toEqual(A);
  });

  it('keeps spaces in a path, encoded in the URL', () => {
    expect(file('C:\\My Notes\\q1 report.html')).toEqual({
      url: 'file:///C:/My%20Notes/q1%20report.html',
      path: 'C:\\My Notes\\q1 report.html',
    });
    expect(file('"C:\\My Notes\\a.html"').path).toBe('C:\\My Notes\\a.html');
  });

  it('encodes reserved characters in the URL', () => {
    expect(file('C:\\a#b\\100%.html')).toEqual({ url: 'file:///C:/a%23b/100%25.html', path: 'C:\\a#b\\100%.html' });
    expect(file('C:\\caf\u00e9\\a.html').url).toBe('file:///C:/caf%C3%A9/a.html');
  });

  it('resolves dot segments without leaving the drive', () => {
    expect(file('C:\\notes\\..\\x\\.\\a.html').url).toBe('file:///C:/x/a.html');
    expect(file('C:\\..\\a.html').url).toBe('file:///C:/a.html');
  });

  it('refuses files that are not .html or .htm', () => {
    expect(refused('C:\\notes\\a.txt')).toContain('.html');
    expect(refused('/c/notes/a.js')).toContain('.html');
    expect(refused('file:///C:/x')).toContain('.html');
    expect(refused('C:\\notes\\')).toContain('.html');
    expect(refused('C:\\a.html.exe')).toContain('.html');
  });

  it('refuses relative paths, which have no working folder to resolve against', () => {
    expect(refused('notes\\a.html')).toContain('full path');
    expect(refused('.\\a.html')).toContain('full path');
    expect(refused('../a.html')).toContain('full path');
    expect(refused('notes/a.html')).toContain('full path');
    expect(refused('a.html')).toContain('full path');
  });

  it('refuses network paths, alternate data streams, and illegal characters', () => {
    expect(refused('\\\\server\\share\\a.html')).toContain('Network');
    expect(refused('file://server/share/a.html')).toContain('Network');
    expect(refused('C:\\notes\\a.html:stream')).toContain('not a valid');
    expect(refused('C:\\no*tes\\a.html')).toContain('not a valid');
    expect(refused('/usr/lib/a.html')).toContain('not a valid');
  });

  it('keeps loopback html URLs as loopback', () => {
    expect(ok('localhost:3000/index.html')).toBe('http://localhost:3000/index.html');
    expect(refused('example.com/index.html')).toContain('full path');
  });

  it('names loopback addresses and local HTML files in the refusal', () => {
    expect(refused('example.com')).toBe('Only loopback addresses and local HTML files open.');
  });
});

describe('pathToFileUrl and fileUrlToPath', () => {
  it('round-trips awkward names', () => {
    const paths = ['C:\\a b\\c.html', 'C:\\a#b\\100%.html', 'D:\\caf\u00e9\\\u30c6\u30b9\u30c8.htm', "C:\\it's (1)\\a&b=c+d.html"];
    for (const path of paths) {
      const url = pathToFileUrl(path);
      expect(url).not.toBeNull();
      // Everything outside the unreserved set is percent-encoded, so nothing can be read as a query or hash.
      expect(url).toMatch(/^file:\/\/\/[A-Z]:\/[A-Za-z0-9%/._~!*'()-]+$/);
      expect(fileUrlToPath(url as string)).toBe(path);
    }
  });

  it('refuses what is not a local drive path', () => {
    expect(pathToFileUrl('notes\\a.html')).toBeNull();
    expect(pathToFileUrl('/c/a.html')).toBeNull();
    expect(fileUrlToPath('http://localhost/a.html')).toBeNull();
    expect(fileUrlToPath('file://server/share/a.html')).toBeNull();
    expect(fileUrlToPath('file:///usr/a.html')).toBeNull();
    expect(fileUrlToPath('file:///C:/a%zz.html')).toBeNull();
    expect(fileUrlToPath('nonsense')).toBeNull();
  });
});

describe('hostLabel', () => {
  it('shows the host and path for loopback URLs', () => {
    expect(hostLabel('http://localhost:5173/')).toBe('localhost:5173');
    expect(hostLabel('http://localhost:3000/a?b=1')).toBe('localhost:3000/a?b=1');
  });

  it('shows the file name for a file URL', () => {
    expect(hostLabel('file:///C:/notes/a%20b.html')).toBe('a b.html');
    expect(hostLabel('nonsense')).toBe('nonsense');
  });
});

describe('isLoopbackUrl', () => {
  it('matches the policy', () => {
    expect(isLoopbackUrl('http://localhost:3000/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000')).toBe(false);
    expect(isLoopbackUrl('https://localhost:3000')).toBe(true);
    expect(isLoopbackUrl('https://u@localhost:3000')).toBe(false);
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
