// The bar under the Local Browser toolbar that lists the hosts a file page tried to reach and its CSP
// refused, each with an Allow button, or on a Downloaded page a note for a loopback host, which its
// policy never names (docs/design/browser.md section 4.21, policy in 3.21). The pane owns
// the `EgressBlocks` state and calls `update` whenever it changes; the bar holds none of its own.
import type { FileTrust } from './browserApi';
import { isLoopbackHost, type BlockedHost } from './browserEgressModel';

export interface BrowserEgressBarOptions {
  /** Allow was clicked for `host`; the pane adds it to the folder's policy and reloads. */
  onAllow: (host: string) => void;
  /** The dismiss control was clicked; the pane clears its blocked hosts. */
  onDismiss: () => void;
}

export class BrowserEgressBar {
  readonly element: HTMLElement;
  private readonly list: HTMLElement;

  constructor(private readonly opts: BrowserEgressBarOptions) {
    this.element = document.createElement('div');
    this.element.className = 'lb-egress';
    this.element.hidden = true;
    this.element.setAttribute('role', 'status');

    const label = document.createElement('span');
    label.className = 'lb-egress-label';
    label.textContent = 'Blocked from reaching:';
    this.list = document.createElement('div');
    this.list.className = 'lb-egress-list';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'lb-icon-btn lb-egress-dismiss';
    dismiss.textContent = '×';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss blocked hosts');
    dismiss.addEventListener('click', () => opts.onDismiss());
    this.element.append(label, this.list, dismiss);
  }

  /** Shows `hosts` in the order given for a page at `trust`; an empty list hides the bar. */
  update(hosts: readonly BlockedHost[], trust: FileTrust | null = null): void {
    this.element.hidden = hosts.length === 0;
    this.list.replaceChildren(...hosts.map((h) => this.chip(h, trust)));
  }

  private chip(h: BlockedHost, trust: FileTrust | null): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'lb-egress-host';
    chip.title = `${h.directive}: ${h.url}`;
    const name = document.createElement('span');
    name.className = 'lb-egress-name';
    name.textContent = h.host;
    const count = document.createElement('span');
    count.className = 'lb-egress-count';
    count.textContent = `${h.count} ${h.count === 1 ? 'request' : 'requests'}`;
    if (trust === 'downloaded' && isLoopbackHost(h.host)) {
      const note = document.createElement('span');
      note.className = 'lb-egress-note';
      note.textContent = "Downloaded pages can't reach local services";
      chip.append(name, count, note);
      return chip;
    }
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'lb-btn lb-egress-allow';
    allow.textContent = 'Allow';
    allow.title = `Let this page send requests to ${h.host}`;
    allow.setAttribute('aria-label', `Allow ${h.host}`);
    allow.addEventListener('click', () => this.opts.onAllow(h.host));
    chip.append(name, count, allow);
    return chip;
  }
}
