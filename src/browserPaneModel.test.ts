import { describe, expect, it } from 'vitest';
import {
  base64Size,
  blockedNotice,
  clampDrawerHeight,
  DEFAULT_DEVTOOLS,
  deviceLabel,
  devicePreset,
  DRAWER_MIN,
  formatDevice,
  formatDuration,
  hostOnly,
  unreachableMessage,
  isBlankUrl,
  isErrorPageUrl,
  clampSplitRatio,
  normalizeDevtools,
  parseDevice,
  prettyBody,
  urlPath,
  filePageStep,
  MOUNTS_PER_PANE,
  rememberMount,
  servedPath,
  shownUrl,
  displayText,
  isHtmlFile,
} from './browserPaneModel';

describe('normalizeDevtools', () => {
  it('fills defaults and clamps the height', () => {
    expect(normalizeDevtools(undefined)).toEqual(DEFAULT_DEVTOOLS);
    expect(normalizeDevtools({ open: true, tab: 'network', height: 10 })).toEqual({
      ...DEFAULT_DEVTOOLS,
      open: true,
      tab: 'network',
      height: DRAWER_MIN,
    });
    expect(normalizeDevtools({ tab: 'bogus' as never, height: Number.NaN }).tab).toBe('console');
    expect(normalizeDevtools({ height: Number.NaN }).height).toBe(DEFAULT_DEVTOOLS.height);
  });
});

describe('split drawer', () => {
  it('keeps the split flag and clamps the ratio', () => {
    expect(normalizeDevtools({ split: true, splitRatio: 0.3 })).toMatchObject({ split: true, splitRatio: 0.3 });
    expect(normalizeDevtools({ split: false }).split).toBe(false);
    expect(normalizeDevtools({ split: 'yes' as never }).split).toBe(true);
    expect(clampSplitRatio(0.01)).toBe(0.15);
    expect(clampSplitRatio(2)).toBe(0.85);
    expect(clampSplitRatio(Number.NaN)).toBe(DEFAULT_DEVTOOLS.splitRatio);
    expect(clampSplitRatio('0.4')).toBe(DEFAULT_DEVTOOLS.splitRatio);
  });
});

describe('clampDrawerHeight', () => {
  it('keeps room for the page and never drops below the minimum', () => {
    expect(clampDrawerHeight(500, 400)).toBe(340);
    expect(clampDrawerHeight(20, 400)).toBe(DRAWER_MIN);
    expect(clampDrawerHeight(300, 50)).toBe(DRAWER_MIN);
  });
});

describe('device state', () => {
  it('round-trips ids and rotation', () => {
    expect(parseDevice('phone')).toEqual({ id: 'phone', rotated: false });
    expect(parseDevice('phone:rotated')).toEqual({ id: 'phone', rotated: true });
    expect(formatDevice({ id: 'tablet', rotated: true })).toBe('tablet:rotated');
  });

  it('falls back to Responsive, which never rotates', () => {
    expect(parseDevice('gone')).toEqual({ id: 'responsive', rotated: false });
    expect(parseDevice(undefined).id).toBe('responsive');
    expect(parseDevice('responsive:rotated').rotated).toBe(false);
  });

  it('rotates the preset and labels it', () => {
    expect(devicePreset({ id: 'phone', rotated: true }).width).toBe(844);
    expect(deviceLabel({ id: 'phone', rotated: false })).toBe('390x844');
    expect(deviceLabel({ id: 'responsive', rotated: false })).toBe('Responsive');
  });
});

describe('url helpers', () => {
  it('recognizes error and blank pages', () => {
    expect(isErrorPageUrl('chrome-error://chromewebdata/')).toBe(true);
    expect(isErrorPageUrl('http://localhost:1/')).toBe(false);
    expect(isBlankUrl(null)).toBe(true);
    expect(isBlankUrl('about:blank')).toBe(true);
    expect(isBlankUrl('http://localhost:1/')).toBe(false);
  });

  it('extracts the host and path', () => {
    expect(hostOnly('http://localhost:5173/a')).toBe('localhost:5173');
    expect(urlPath('http://localhost:5173/a/b?x=1#h')).toBe('/a/b?x=1');
    expect(urlPath('data:' + 'x'.repeat(200))).toHaveLength(83);
  });

  it('words the unreachable overlay by the TLS probe', () => {
    expect(unreachableMessage('http://localhost:5173/', null).heading).toBe('Nothing is listening on localhost:5173');
    expect(unreachableMessage('https://localhost:7001/', 'refused').heading).toBe('Nothing is listening on localhost:7001');
    expect(unreachableMessage('https://localhost:7001/', 'other').command).toBeUndefined();
    const cert = unreachableMessage('https://localhost:7001/', 'untrusted');
    expect(cert.heading).toContain('not trusted');
    expect(cert.command).toBe('dotnet dev-certs https --trust');
    expect(unreachableMessage('https://localhost:7080/', 'notTls').hint).toContain('http://localhost:7080');
    expect(unreachableMessage(null, null).heading).toBe('Nothing is listening on that address');
  });

  it('words blocked notices', () => {
    expect(blockedNotice('https://example.com/x', true, null)).toBe('Opened example.com in your browser.');
    expect(blockedNotice('http://localhost:1420/', false, 'http://localhost:1420')).toContain('Bashboard itself');
    expect(blockedNotice('ftp://localhost/', false, null)).toContain('Only loopback addresses and local HTML files open');
    expect(blockedNotice('file:///C:/notes/a.html', false, null)).toContain('typed in the address field');
    expect(blockedNotice('http://127.0.0.1:8000/', false, null, true)).toBe(
      "Blocked 127.0.0.1:8000. Downloaded pages can't open local services.",
    );
  });

  it('words the unreachable overlay for a file page', () => {
    const m = unreachableMessage('file:///C:/notes/a%20b.html', null);
    expect(m.heading).toBe('Could not open a b.html');
    expect(m.command).toBeUndefined();
  });
});

describe('file pages', () => {
  const mount = { base: 'http://127.0.0.1:50001/abc123/', path: 'C:\\notes\\site\\index.html' };

  it('maps a serving URL back to the file it serves', () => {
    expect(servedPath('http://127.0.0.1:50001/abc123/index.html', mount)).toBe('C:\\notes\\site\\index.html');
    expect(servedPath('http://127.0.0.1:50001/abc123/sub/a%20b.htm?x=1#top', mount)).toBe('C:\\notes\\site\\sub\\a b.htm');
    expect(shownUrl('http://127.0.0.1:50001/abc123/sub/a%20b.htm#top', [mount])).toBe('file:///C:/notes/site/sub/a%20b.htm');
  });

  it('joins a drive-root mount without doubling the separator', () => {
    const root = { base: 'http://127.0.0.1:50002/t/', path: 'C:\\a.html' };
    expect(servedPath('http://127.0.0.1:50002/t/a.html', root)).toBe('C:\\a.html');
  });

  it('maps nothing but the file itself under a single-file mount', () => {
    const page = 'C:\\Users\\me\\page.html';
    const home = { base: 'http://127.0.0.1:50004/t/', path: page, folder: page };
    expect(servedPath('http://127.0.0.1:50004/t/page.html?x=1', home)).toBe(page);
    expect(servedPath('http://127.0.0.1:50004/t/other.html', home)).toBeNull();
    expect(servedPath('http://127.0.0.1:50004/t/Documents/proj/index.html', home)).toBeNull();
    const current = { base: home.base, fileUrl: 'file:///C:/Users/me/page.html' };
    expect(filePageStep('http://127.0.0.1:50004/t/other.html', current, [home])).toEqual({ kind: 'leave' });
  });

  it('leaves other URLs alone', () => {
    expect(servedPath('http://127.0.0.1:50001/other/index.html', mount)).toBeNull();
    expect(servedPath('http://localhost:5173/', mount)).toBeNull();
    expect(servedPath('http://127.0.0.1:50001/abc123/', mount)).toBeNull();
    expect(servedPath('http://127.0.0.1:50001/abc123/%E0%A4%A.html', mount)).toBeNull();
    expect(servedPath('http://127.0.0.1:50001/abc123/index.html', null)).toBeNull();
    for (const escape of ['..%5c..%5cx.html', '..%2f..%2fx.html', 'a%3a%3a$DATA.html', '%2egit/x.html', 'nul%00.html']) {
      expect(servedPath(`http://127.0.0.1:50001/abc123/${escape}`, mount), escape).toBeNull();
    }
    expect(shownUrl('http://localhost:5173/x', [mount])).toBe('http://localhost:5173/x');
    expect(shownUrl('http://127.0.0.1:50001/abc123/index.html', [])).toBe('http://127.0.0.1:50001/abc123/index.html');
  });

  it('maps an address under a listener the pane moved off', () => {
    // Local and Downloaded pages in one folder are served from two listeners (3.21 Mounts).
    const downloaded = { base: 'http://127.0.0.1:50003/def456/', path: 'C:\\notes\\site\\got.html' };
    const mounts = [downloaded, mount];
    expect(shownUrl('http://127.0.0.1:50003/def456/got.html', mounts)).toBe('file:///C:/notes/site/got.html');
    expect(shownUrl('http://127.0.0.1:50001/abc123/index.html', mounts)).toBe('file:///C:/notes/site/index.html');
    expect(shownUrl('http://127.0.0.1:50003/abc123/index.html', mounts)).toBe('http://127.0.0.1:50003/abc123/index.html');
  });

  it('remembers mounts newest first, one per base, capped', () => {
    const a = { base: 'http://127.0.0.1:1/a/', path: 'C:\\s\\a.html' };
    const b = { base: 'http://127.0.0.1:2/b/', path: 'C:\\s\\b.html' };
    const a2 = { base: a.base, path: 'C:\\s\\c.html' };
    expect(rememberMount([], a)).toEqual([a]);
    expect(rememberMount([a], b)).toEqual([b, a]);
    expect(rememberMount([b, a], a2)).toEqual([a2, b]);
    expect(rememberMount([b, a], a2, 1)).toEqual([a2]);
    const many = Array.from({ length: MOUNTS_PER_PANE + 3 }, (_, i) => ({ base: `http://127.0.0.1:${i + 1}/t/`, path: 'C:\\s\\a.html' }));
    const kept = many.reduce<typeof many>((ms, m) => rememberMount(ms, m), []);
    expect(kept).toHaveLength(MOUNTS_PER_PANE);
    expect(kept[0]).toBe(many[many.length - 1]);
  });

  describe('filePageStep', () => {
    const local = { base: 'http://127.0.0.1:50001/abc123/', path: 'C:\\notes\\site\\index.html', folder: 'C:\\notes\\site' };
    const down = { base: 'http://127.0.0.1:50003/def456/', path: 'C:\\notes\\site\\got.html', folder: 'C:\\notes\\site' };
    const mounts = [down, local];
    const indexUrl = 'file:///C:/notes/site/index.html';

    it('re-enters file mode on Back from a loopback page into an earlier file page', () => {
      expect(filePageStep('http://127.0.0.1:50001/abc123/index.html', null, mounts)).toEqual({
        kind: 'file',
        mount: local,
        fileUrl: indexUrl,
        reenter: true,
        serve: true,
      });
    });

    it('re-enters under a listener the pane moved off, as Forward does after Back', () => {
      const step = filePageStep('http://127.0.0.1:50003/def456/got.html#top', null, mounts);
      expect(step).toMatchObject({ kind: 'file', mount: down, fileUrl: 'file:///C:/notes/site/got.html', reenter: true, serve: true });
    });

    it('serves again when the file or the base changes, not for the same page', () => {
      const current = { base: local.base, fileUrl: indexUrl };
      expect(filePageStep('http://127.0.0.1:50001/abc123/index.html?x=1', current, mounts)).toMatchObject({ kind: 'file', reenter: false, serve: false });
      expect(filePageStep('http://127.0.0.1:50001/abc123/other.html', current, mounts)).toMatchObject({ kind: 'file', serve: true });
      expect(filePageStep('http://127.0.0.1:50003/def456/index.html', { base: down.base, fileUrl: indexUrl }, mounts)).toMatchObject({
        kind: 'file',
        mount: down,
        serve: false,
      });
      expect(filePageStep('http://127.0.0.1:50001/abc123/index.html', { base: down.base, fileUrl: indexUrl }, mounts)).toMatchObject({
        kind: 'file',
        mount: local,
        serve: true,
      });
    });

    it('does not serve a non-HTML file as a page', () => {
      expect(filePageStep('http://127.0.0.1:50001/abc123/pic.png', null, mounts)).toMatchObject({ kind: 'file', reenter: true, serve: false });
    });

    it('leaves file mode for any other address, keeping the mounts for later', () => {
      expect(filePageStep('http://localhost:5173/', { base: local.base, fileUrl: indexUrl }, mounts)).toEqual({ kind: 'leave' });
      expect(filePageStep('http://127.0.0.1:50001/0000/index.html', null, mounts)).toEqual({ kind: 'leave' });
      expect(filePageStep('http://127.0.0.1:50001/abc123/index.html', null, [])).toEqual({ kind: 'leave' });
    });
  });

  it('shows a file URL as its path', () => {
    expect(displayText('file:///C:/notes/a%20b.html')).toBe('C:\\notes\\a b.html');
    expect(displayText('http://localhost:5173/')).toBeUndefined();
    expect(displayText(null)).toBeUndefined();
  });

  it('recognizes HTML files', () => {
    expect(isHtmlFile('file:///C:/a/b.HTML')).toBe(true);
    expect(isHtmlFile('file:///C:/a/b.htm?x#y')).toBe(true);
    expect(isHtmlFile('file:///C:/a/b.css')).toBe(false);
  });
});

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(12.4)).toBe('12 ms');
    expect(formatDuration(1240)).toBe('1.24 s');
  });

  it('pretty-prints JSON and leaves other text alone', () => {
    expect(prettyBody('{"a":1}', 'application/json')).toBe('{\n  "a": 1\n}');
    expect(prettyBody('[1]', 'text/plain')).toBe('[\n  1\n]');
    expect(prettyBody('{oops', 'application/json')).toBe('{oops');
    expect(prettyBody('<p>', 'text/html')).toBe('<p>');
  });

  it('sizes base64 bodies', () => {
    expect(base64Size(btoa('hello'))).toBe(5);
    expect(base64Size(btoa('hi'))).toBe(2);
    expect(base64Size('')).toBe(0);
  });
});
