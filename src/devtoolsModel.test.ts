import { describe, expect, it } from 'vitest';
import { ConsoleLog, NetworkLog, consoleLevel, typeGroup, type BrowserEvent } from './devtoolsModel';

const con = (level: string, text: string, timestamp = 1): BrowserEvent => ({ kind: 'console', level, text, timestamp });
const req = (requestId: string, over: Partial<Extract<BrowserEvent, { kind: 'request' }>> = {}): BrowserEvent => ({
  kind: 'request',
  requestId,
  url: `http://localhost:5173/${requestId}`,
  method: 'GET',
  resourceType: 'Fetch',
  headers: { Accept: '*/*' },
  timestamp: 10,
  ...over,
});

describe('consoleLevel', () => {
  it('maps CDP types onto the drawer levels', () => {
    expect(consoleLevel('warning')).toBe('warn');
    expect(consoleLevel('assert')).toBe('error');
    expect(consoleLevel('trace')).toBe('debug');
    expect(consoleLevel('dir')).toBe('log');
  });
});

describe('ConsoleLog', () => {
  it('adds console and exception events and ignores others', () => {
    const log = new ConsoleLog();
    log.add(con('log', 'hi'));
    log.add({ kind: 'exception', text: 'boom', timestamp: 2 });
    expect(log.add({ kind: 'loadState', loading: true })).toBeNull();
    const [a, b] = log.entries();
    expect(a.level).toBe('log');
    expect(b).toMatchObject({ level: 'error', exception: true });
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('drops the oldest entries past the cap', () => {
    const log = new ConsoleLog(3);
    for (let i = 0; i < 5; i++) log.add(con('log', `m${i}`));
    expect(log.entries().map((e) => e.text)).toEqual(['m2', 'm3', 'm4']);
  });

  it('filters by level and text and counts per level', () => {
    const log = new ConsoleLog();
    log.add(con('log', 'Hello world'));
    log.add(con('warning', 'careful'));
    log.add(con('error', 'hello again'));
    expect(log.filter({ levels: ['error', 'warn'] }).map((e) => e.text)).toEqual(['careful', 'hello again']);
    expect(log.filter({ text: ' HELLO ' }).length).toBe(2);
    expect(log.filter({ levels: new Set(['log']), text: 'hello' }).length).toBe(1);
    expect(log.counts()).toEqual({ log: 1, info: 0, warn: 1, error: 1, debug: 0 });
  });

  it('clears', () => {
    const log = new ConsoleLog();
    log.add(con('log', 'x'));
    log.clear();
    expect(log.size).toBe(0);
  });
});

describe('typeGroup', () => {
  it('groups resource types', () => {
    expect(typeGroup('XHR')).toBe('fetch');
    expect(typeGroup('Fetch')).toBe('fetch');
    expect(typeGroup('Document')).toBe('doc');
    expect(typeGroup('Script')).toBe('js');
    expect(typeGroup('Stylesheet')).toBe('css');
    expect(typeGroup('Image')).toBe('img');
    expect(typeGroup('Font')).toBe('other');
  });
});

describe('NetworkLog', () => {
  it('assembles a row across request, response, and finished', () => {
    const log = new NetworkLog();
    log.apply(req('a'));
    expect(log.get('a')).toMatchObject({ status: null, size: null, duration: null, requestHeaders: { Accept: '*/*' } });
    log.apply({
      kind: 'response',
      requestId: 'a',
      status: 200,
      statusText: 'OK',
      mimeType: 'application/json',
      headers: { 'content-type': 'application/json' },
      timestamp: 11,
    });
    log.apply({ kind: 'finished', requestId: 'a', encodedLength: 512, timestamp: 12.5 });
    expect(log.get('a')).toMatchObject({ status: 200, size: 512, duration: 2.5, failed: false, method: 'GET' });
  });

  it('marks failures', () => {
    const log = new NetworkLog();
    log.apply(req('a'));
    log.apply({ kind: 'failed', requestId: 'a', errorText: 'net::ERR_ABORTED', canceled: true, timestamp: 11 });
    expect(log.get('a')).toMatchObject({ failed: true, canceled: true, duration: 1 });
  });

  it('ignores updates for unknown requests', () => {
    const log = new NetworkLog();
    log.apply({ kind: 'finished', requestId: 'zz', encodedLength: 1, timestamp: 1 });
    expect(log.size).toBe(0);
  });

  it('follows a redirect on the same request id without adding a row', () => {
    const log = new NetworkLog();
    log.apply(req('a'));
    log.apply(req('a', { url: 'http://localhost:5173/next', timestamp: 11 }));
    expect(log.size).toBe(1);
    expect(log.get('a')).toMatchObject({ url: 'http://localhost:5173/next', start: 11 });
  });

  it('drops the oldest rows past the cap', () => {
    const log = new NetworkLog(2);
    log.apply(req('a'));
    log.apply(req('b'));
    log.apply(req('c'));
    expect(log.rows().map((r) => r.requestId)).toEqual(['b', 'c']);
  });

  it('filters by type group and text', () => {
    const log = new NetworkLog();
    log.apply(req('a', { resourceType: 'Script', url: 'http://localhost:5173/main.js' }));
    log.apply(req('b', { resourceType: 'XHR', url: 'http://localhost:5173/api/users', method: 'POST' }));
    log.apply(req('c', { resourceType: 'Image', url: 'http://localhost:5173/logo.png' }));
    expect(log.filter({ types: ['js', 'img'] }).map((r) => r.requestId)).toEqual(['a', 'c']);
    expect(log.filter({ types: [] }).length).toBe(3);
    expect(log.filter({ text: 'post' }).map((r) => r.requestId)).toEqual(['b']);
    expect(log.filter({ text: 'API', types: new Set(['fetch'] as const) }).length).toBe(1);
  });

  it('clears', () => {
    const log = new NetworkLog();
    log.apply(req('a'));
    log.clear();
    expect(log.rows()).toEqual([]);
  });
});
