// The hosts a file page tried to reach and its CSP refused, for the Allow bar under the Local Browser
// toolbar (docs/design/browser.md section 4.21, with the policy in 3.21). Pure, no DOM.
import type { BrowserEvent } from './devtoolsModel';

/** More distinct hosts than this are dropped; a page that probes that many is not one to allow by hand. */
export const EGRESS_HOST_CAP = 20;

export interface BlockedHost {
  host: string;
  /** Refused requests to this host since the page loaded. */
  count: number;
  /** The directive and URL of the first refusal, which is what the bar shows as a hint. */
  directive: string;
  url: string;
}

/** Refused hosts in first-seen order, one entry per host. Cleared when the page navigates. */
export class EgressBlocks {
  private byHost = new Map<string, BlockedHost>();

  constructor(private readonly cap = EGRESS_HOST_CAP) {}

  /** Records an `egressBlocked` event; any other event is ignored. Returns whether the list changed. */
  add(ev: BrowserEvent): boolean {
    if (ev.kind !== 'egressBlocked') return false;
    // A refusal with no host (an inline or `data:` URL) leaves nothing for Allow to add to a policy.
    const host = ev.host.trim().toLowerCase();
    if (host === '') return false;
    const existing = this.byHost.get(host);
    if (existing) {
      existing.count++;
      return true;
    }
    if (this.byHost.size >= this.cap) return false;
    this.byHost.set(host, { host, count: 1, directive: ev.directive, url: ev.url });
    return true;
  }

  /** Drops a host once it has been allowed. */
  remove(host: string): void {
    this.byHost.delete(host.toLowerCase());
  }

  clear(): void {
    this.byHost.clear();
  }

  get size(): number {
    return this.byHost.size;
  }

  hosts(): readonly BlockedHost[] {
    return [...this.byHost.values()];
  }
}

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/**
 * True when `host` names this machine: `localhost`, any `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, or
 * `[::1]`, with or without a scheme and port, in any case. Mirrors `is_loopback_host` in
 * `src-tauri/src/browser_files/trust.rs`, which drops these from a Downloaded page's policy; the two
 * test suites share their cases.
 */
export function isLoopbackHost(host: string): boolean {
  let rest = host.trim().toLowerCase();
  const scheme = rest.indexOf('://');
  if (scheme >= 0) rest = rest.slice(scheme + 3);
  else if (rest.endsWith(':')) return false;
  const name = rest.startsWith('[') ? rest.slice(0, rest.indexOf(']') + 1 || undefined) : rest.split(/[:/]/)[0];
  if (name === '' || name.includes('*')) return false;
  let parsed: string;
  try {
    parsed = new URL(`http://${name}/`).hostname;
  } catch {
    return false;
  }
  if (parsed.startsWith('[')) {
    // The URL parser compresses IPv6, and writes an IPv4-mapped address as two hex groups.
    if (parsed === '[::1]' || parsed === '[::]') return true;
    const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(parsed);
    if (!mapped) return false;
    const high = parseInt(mapped[1], 16);
    return high >> 8 === 127 || (high === 0 && parseInt(mapped[2], 16) === 0);
  }
  if (IPV4.test(parsed)) return parsed.startsWith('127.') || parsed === '0.0.0.0';
  const domain = parsed.replace(/\.+$/, '');
  return domain === 'localhost' || domain.endsWith('.localhost');
}

/** The port a refused request went to, from its URL, with the scheme's default when it names none. */
export function blockedPort(h: BlockedHost): string {
  try {
    const url = new URL(h.url);
    return url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  } catch {
    const port = /:(\d+)$/.exec(h.host);
    return port ? port[1] : '80';
  }
}

/** The host without its port, as the Allow confirm names it. */
export function hostName(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
}
