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
    expect(normalizeDevtools({ split: 'yes' as never }).split).toBe(false);
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
    expect(blockedNotice('ftp://localhost/', false, null)).toContain('only opens localhost');
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
