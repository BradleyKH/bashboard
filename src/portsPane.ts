import { invoke } from '@tauri-apps/api/core';
import './portsPane.css';
import type { ConfirmOptions } from './confirmDialog';
import { attachContextMenu } from './contextMenu';
import { copyText } from './copyText';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import { portMenuItems } from './portMenus';
import type { Listener } from './ports';
import {
  addressLabel,
  formatUptime,
  isExposed,
  listenerKey,
  listenerTooltip,
  localUrl,
  paneListeners,
  processLabel,
} from './portsModel';
import { stopListener } from './portStop';
import type { PortsStore } from './portsStore';
import type { Settings } from './settings';

export interface PortsPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  /** Whether the pane starts on screen; the list is polled only while it is. */
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  store: PortsStore;
  ownerTitle: (ptyId: number) => string | null;
  onGoToPane: (ptyId: number) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

/** Every listening TCP port, with its process, command line, and owning pane (docs/design.md section 4.19). */
export class PortsPane implements PaneView {
  readonly kind = 'ports' as const;
  readonly paneId: string;
  readonly folder = null;
  private readonly opts: PortsPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly servicesBox: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private settings: Settings;
  private selected: string | null = null;
  /** What the rows on screen show apart from uptimes; unchanged, only the uptimes refresh. */
  private shownKey: string | null = null;
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: PortsPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body ports-body';
    this.body.tabIndex = -1;

    const bar = document.createElement('div');
    bar.className = 'ports-bar';
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'search';
    this.filterInput.className = 'ports-filter';
    this.filterInput.placeholder = 'Filter by port, program, command, or pane';
    this.filterInput.spellcheck = false;
    const services = document.createElement('label');
    services.className = 'ports-services';
    this.servicesBox = document.createElement('input');
    this.servicesBox.type = 'checkbox';
    services.append(this.servicesBox, document.createTextNode('Windows services'));
    services.title = 'Also list ports held by Windows services and the system';
    this.count = document.createElement('span');
    this.count.className = 'ports-count';
    bar.append(this.filterInput, services, this.count);

    this.list = document.createElement('div');
    this.list.className = 'ports-list';
    this.body.append(bar, this.list);
    this.host.appendChild(this.body);

    this.unsubscribe = opts.store.subscribe(() => this.render());
    this.listen(this.filterInput, 'input', () => this.render());
    this.listen(this.servicesBox, 'change', () => this.render());
    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));

    this.render();
    this.setExpanded(opts.expanded);
  }

  title(): string {
    return 'Ports';
  }

  /** Selects and scrolls to the row with this `listenerKey` (the dashboard opens the pane on one). */
  highlight(key: string): void {
    this.selected = key;
    this.render();
    this.list.querySelector<HTMLElement>('.ports-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  focus(): void {
    this.body.focus();
  }

  setExpanded(expanded: boolean): void {
    this.opts.store.setWanted(`pane:${this.paneId}`, expanded && !this.disposed);
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
  }

  cellSize(): CellSize {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre;';
    probe.style.fontFamily = toFontFamily(this.settings.font.family);
    probe.style.fontSize = `${this.settings.font.size}px`;
    this.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 10;
    const probeHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const row = this.body.querySelector<HTMLElement>('.ports-row');
    const height = row?.offsetHeight || probeHeight || this.settings.font.size * 1.2;
    return {
      width,
      height,
      // Everything outside the body: borders and the title strip.
      padX: Math.max(0, this.host.offsetWidth - this.body.clientWidth) + 1,
      padY: Math.max(0, this.host.offsetHeight - this.body.clientHeight) + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.opts.store.setWanted(`pane:${this.paneId}`, false);
    this.unsubscribe();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private owner(l: Listener): string | null {
    return l.ptyId === null ? null : this.opts.ownerTitle(l.ptyId);
  }

  private render(): void {
    if (this.disposed) return;
    const store = this.opts.store;
    const all = store.current();
    const rows = paneListeners(all, { showSystem: this.servicesBox.checked, text: this.filterInput.value }, (l) =>
      this.owner(l),
    );
    const hidden = all.length - rows.length;
    this.count.textContent = `${rows.length} listening${hidden > 0 ? `, ${hidden} hidden` : ''}`;
    const nowSec = Date.now() / 1000;
    const key = JSON.stringify([rows.map((l) => [listenerKey(l), l.addresses, this.owner(l)]), this.selected, store.ready]);
    if (key === this.shownKey) {
      const cells = this.list.querySelectorAll<HTMLElement>('.ports-up');
      rows.forEach((l, i) => {
        if (cells[i]) cells[i].textContent = formatUptime(nowSec, l.startedAt);
      });
      return;
    }
    this.shownKey = key;
    if (rows.length === 0) {
      const note = document.createElement('div');
      note.className = 'ports-note';
      note.textContent = !store.ready ? 'Reading ports…' : all.length === 0 ? 'Nothing is listening.' : 'No ports match.';
      this.list.replaceChildren(note);
      return;
    }
    // Rebuilding keeps the scroll position, since the list element itself stays.
    this.list.replaceChildren(...rows.map((l) => this.renderRow(l, nowSec)));
  }

  private renderRow(l: Listener, nowSec: number): HTMLElement {
    const key = listenerKey(l);
    const owner = this.owner(l);
    const el = document.createElement('div');
    el.className = 'ports-row';
    el.classList.toggle('selected', key === this.selected);
    el.classList.toggle('system', l.system);
    el.title = listenerTooltip(l, owner, nowSec);

    const top = document.createElement('div');
    top.className = 'ports-line';
    const dot = document.createElement('span');
    dot.className = 'status-dot port-dot';
    dot.classList.toggle('exposed', isExposed(l.addresses));
    const port = this.cell('ports-port', String(l.port));
    const name = this.cell('ports-name', processLabel(l.name));
    const pid = this.cell('ports-pid', `pid ${l.pid}`);
    const addr = this.cell('ports-addr', addressLabel(l.addresses));
    const up = this.cell('ports-up', formatUptime(nowSec, l.startedAt));
    top.append(dot, port, name, pid, addr);
    if (owner) top.append(this.cell('ports-owner', owner));
    top.append(up);

    const detail = document.createElement('div');
    detail.className = 'ports-detail';
    detail.textContent = l.command || (l.system ? 'Windows service' : 'Command line not available');
    el.append(top, detail);
    if (l.cwd) el.append(this.cell('ports-cwd', l.cwd));

    const ptyId = owner === null ? null : l.ptyId;
    // Selecting in place, rather than rebuilding, keeps the row under the pointer for a double-click.
    el.addEventListener('click', () => {
      this.selected = key;
      for (const r of this.list.querySelectorAll('.ports-row.selected')) r.classList.remove('selected');
      el.classList.add('selected');
    });
    el.addEventListener('dblclick', () => this.openUrl(localUrl(l)));
    attachContextMenu(el, () => ({
      target: el,
      entries: portMenuItems(l, {
        onOpenUrl: (url) => this.openUrl(url),
        onCopy: (text, what) => void copyText(text, what),
        onGoToPane: ptyId === null ? undefined : () => this.opts.onGoToPane(ptyId),
        onStop: () => void stopListener(l, owner, this.opts.confirm, this.opts.store),
      }),
    }));
    return el;
  }

  private cell(className: string, text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  private openUrl(url: string): void {
    void invoke('open_url', { url }).catch((err: unknown) => console.warn('open_url failed', err));
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target === this.filterInput && e.key === 'Escape' && this.filterInput.value !== '') {
      this.filterInput.value = '';
      this.render();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const action = lookup(this.opts.keymap(), e);
    if (action && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
