import { describe, expect, it } from 'vitest';
import type { BrowserEvent } from './devtoolsModel';
import { EGRESS_HOST_CAP, EgressBlocks, blockedPort, hostName, isLoopbackHost } from './browserEgressModel';

const blocked = (host: string, directive = 'connect-src', url = `https://${host}/x`): BrowserEvent => ({
  kind: 'egressBlocked',
  host,
  directive,
  url,
});

describe('EgressBlocks', () => {
  it('collects hosts in first-seen order with a count each', () => {
    const b = new EgressBlocks();
    expect(b.add(blocked('a.example.com'))).toBe(true);
    b.add(blocked('b.example.com', 'img-src'));
    b.add(blocked('a.example.com', 'script-src', 'https://a.example.com/y'));
    expect(b.hosts()).toEqual([
      { host: 'a.example.com', count: 2, directive: 'connect-src', url: 'https://a.example.com/x' },
      { host: 'b.example.com', count: 1, directive: 'img-src', url: 'https://b.example.com/x' },
    ]);
    expect(b.size).toBe(2);
  });

  it('treats host case as one host and ignores an empty host', () => {
    const b = new EgressBlocks();
    b.add(blocked('Example.COM'));
    b.add(blocked('example.com'));
    expect(b.add(blocked(' '))).toBe(false);
    expect(b.hosts().map((h) => [h.host, h.count])).toEqual([['example.com', 2]]);
  });

  it('ignores other events', () => {
    const b = new EgressBlocks();
    expect(b.add({ kind: 'fileChanged' })).toBe(false);
    expect(b.add({ kind: 'loadState', loading: true })).toBe(false);
    expect(b.size).toBe(0);
  });

  it('clears on navigation', () => {
    const b = new EgressBlocks();
    b.add(blocked('a.example.com'));
    b.clear();
    expect(b.hosts()).toEqual([]);
  });

  it('removes an allowed host', () => {
    const b = new EgressBlocks();
    b.add(blocked('a.example.com'));
    b.add(blocked('b.example.com'));
    b.remove('A.example.com');
    expect(b.hosts().map((h) => h.host)).toEqual(['b.example.com']);
  });

  it('caps at 20 hosts but keeps counting the ones it has', () => {
    const b = new EgressBlocks();
    for (let i = 0; i < EGRESS_HOST_CAP + 5; i++) b.add(blocked(`h${i}.example.com`));
    expect(b.size).toBe(20);
    expect(b.add(blocked('h99.example.com'))).toBe(false);
    expect(b.add(blocked('h0.example.com'))).toBe(true);
    expect(b.hosts()[0].count).toBe(2);
    expect(b.hosts().some((h) => h.host === 'h20.example.com')).toBe(false);
  });
});

// The same cases as `LOOPBACK` and `NOT_LOOPBACK` in src-tauri/src/browser_files/trust.rs.
const LOOPBACK = [
  'localhost',
  'LOCALHOST',
  'localhost:3000',
  'localhost.',
  'app.localhost',
  'Api.App.Localhost:8080',
  'http://localhost:5173',
  'https://127.0.0.1',
  'ws://127.0.0.1:9229/path',
  '127.0.0.1',
  '127.0.0.1:8080',
  '127.1.2.3',
  '127.255.255.254:1',
  '127.1',
  '0.0.0.0',
  '0.0.0.0:3000',
  '[::1]',
  '[::1]:8080',
  'http://[::1]:8080',
  '[0:0:0:0:0:0:0:1]',
  '[::ffff:127.0.0.1]',
];
const NOT_LOOPBACK = [
  'example.com',
  'api.example.com:443',
  'localhost.example.com',
  'notlocalhost',
  'mylocalhost.com',
  '128.0.0.1',
  '10.0.0.1',
  '192.168.1.10:3000',
  '1.0.0.0',
  '[::2]',
  '[2001:db8::1]',
  'https:',
  '',
];

describe('isLoopbackHost', () => {
  it.each(LOOPBACK)('%s is this machine', (host) => expect(isLoopbackHost(host)).toBe(true));
  it.each(NOT_LOOPBACK)('%s is not', (host) => expect(isLoopbackHost(host)).toBe(false));
});

describe('blockedPort and hostName', () => {
  const at = (host: string, url: string) => ({ host, count: 1, directive: 'connect-src', url });

  it('reads the port from the refused URL, or the scheme default', () => {
    expect(blockedPort(at('localhost:3000', 'http://localhost:3000/api'))).toBe('3000');
    expect(blockedPort(at('localhost', 'http://localhost/api'))).toBe('80');
    expect(blockedPort(at('127.0.0.1', 'https://127.0.0.1/x'))).toBe('443');
    expect(blockedPort(at('[::1]:8080', 'not a url'))).toBe('8080');
  });

  it('drops the port from a host', () => {
    expect(hostName('localhost:3000')).toBe('localhost');
    expect(hostName('[::1]:8080')).toBe('[::1]');
    expect(hostName('127.0.0.1')).toBe('127.0.0.1');
  });
});
