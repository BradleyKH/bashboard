import { invoke } from '@tauri-apps/api/core';
import './portsPane.css';
import type { ConfirmOptions } from './confirmDialog';
import { attachContextMenu } from './contextMenu';
import { copyText } from './copyText';
import { setPathText } from './displayPath';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import { isLoopbackUrl } from './localBrowserModel';
import { portMenuItems } from './portMenus';
import type { Listener } from './ports';
import {
  addressLabel,
  canStop,
  DEFAULT_PORT_SORT,
  exposureLabel,
  formatUptime,
  isExposed,
  listenerKey,
  localUrl,
  nextPortSort,
  paneListeners,
  processLabel,
  type PortSort,
  type PortSortColumn,
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
  /** Opens a loopback URL in a Local Browser pane beside this one. */
  onOpenLocal?: (url: string) => void;
  store: PortsStore;
  ownerTitle: (ptyId: number) => string | null;
  onGoToPane: (ptyId: number) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

/** Every listening TCP port, with its process, command line, and owning pane (docs/design/containers.md section 4.19). */
export class PortsPane implements PaneView {
  readonly kind = 'ports' as const;
  readonly paneId: string;
  readonly folder = null;
  private readonly opts: PortsPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly servicesBox: HTMLInputElement;
  private readonly paneOnlyBox: HTMLInputElement;
  private readonly commandsBox: HTMLInputElement;
  private readonly count: HTMLElement;
  private readonly list: HTMLElement;
  private settings: Settings;
  private selected: string | null = null;
  private sort: PortSort = DEFAULT_PORT_SORT;
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
    this.paneOnlyBox = document.createElement('input');
    const paneOnly = this.checkbox(this.paneOnlyBox, 'Started from a pane', 'List only ports started from a Bashboard pane');
    this.paneOnlyBox.checked = true;
    this.servicesBox = document.createElement('input');
    const services = this.checkbox(this.servicesBox, 'Windows services', 'Also list ports held by Windows services and the system');
    this.commandsBox = document.createElement('input');
    const commands = this.checkbox(this.commandsBox, 'Command lines', "Show each port's full command line under its folder");
    this.count = document.createElement('span');
    this.count.className = 'ports-count';
    // Left of the checkboxes, so the count's changing width never moves them.
    bar.append(this.filterInput, this.count, paneOnly, services, commands);

    this.list = document.createElement('div');
    this.list.className = 'ports-list hide-commands';
    this.body.append(bar, this.list);
    this.host.appendChild(this.body);

    this.unsubscribe = opts.store.subscribe(() => this.render());
    this.listen(this.filterInput, 'input', () => this.render());
    this.listen(this.servicesBox, 'change', () => this.render());
    this.listen(this.paneOnlyBox, 'change', () => this.render());
    this.listen(this.commandsBox, 'change', () => this.list.classList.toggle('hide-commands', !this.commandsBox.checked));
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
    const target = this.opts.store.current().find((l) => listenerKey(l) === key);
    // A row no pane started is filtered out by default; show it rather than select nothing.
    if (target && this.owner(target) === null) this.paneOnlyBox.checked = false;
    this.render();
    this.list.querySelector<HTMLElement>('.ports-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  /** Clears Started from a pane, for the dashboard's "+ N other programs" row. */
  showAll(): void {
    this.paneOnlyBox.checked = false;
    this.render();
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
    const rows = paneListeners(
      all,
      { showSystem: this.servicesBox.checked, paneOnly: this.paneOnlyBox.checked, text: this.filterInput.value },
      (l) => this.owner(l),
      this.sort,
    );
    const hidden = all.length - rows.length;
    this.count.textContent = `${rows.length} listening${hidden > 0 ? `, ${hidden} hidden` : ''}`;
    const nowSec = Date.now() / 1000;
    const key = JSON.stringify([rows.map((l) => [listenerKey(l), l.addresses, this.owner(l)]), this.selected, this.sort, store.ready]);
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
    // With no row started from a pane, the Pane column would be blank, so it goes.
    const showPane = rows.some((l) => this.owner(l) !== null);
    this.list.classList.toggle('no-pane', !showPane);
    this.list.replaceChildren(this.renderHead(showPane), ...rows.map((l) => this.renderRow(l, nowSec, showPane)));
  }

  private renderHead(showPane: boolean): HTMLElement {
    const head = document.createElement('div');
    head.className = 'ports-head';
    const columns: Array<[string, PortSortColumn | null]> = [
      ['', null],
      ['Port', 'port'],
      ['Program', 'program'],
      ['Folder', null],
      ...(showPane ? [['Pane', 'pane'] as [string, PortSortColumn]] : []),
      ['Address', 'address'],
      ['PID', 'pid'],
      ['Up', 'up'],
      ['', null],
    ];
    for (const [label, column] of columns) {
      const cell = column === null ? this.cell('ports-head-cell', label) : this.sortHeader(label, column);
      if (label === 'Folder') cell.classList.add('ports-head-folder');
      head.append(cell);
    }
    return head;
  }

  private sortHeader(label: string, column: PortSortColumn): HTMLElement {
    const active = this.sort.column === column;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ports-head-cell ports-sort';
    b.classList.toggle('active', active);
    b.textContent = label;
    if (active) {
      const arrow = document.createElement('span');
      arrow.className = 'ports-sort-arrow';
      arrow.textContent = this.sort.desc ? '▼' : '▲';
      b.append(arrow);
    }
    b.title = active && !this.sort.desc ? `Sort by ${label}, descending` : `Sort by ${label}`;
    b.addEventListener('click', () => {
      this.sort = nextPortSort(this.sort, column);
      this.render();
    });
    return b;
  }

  private renderRow(l: Listener, nowSec: number, showPane: boolean): HTMLElement {
    const key = listenerKey(l);
    const owner = this.owner(l);
    const ptyId = owner === null ? null : l.ptyId;
    const el = document.createElement('div');
    el.className = 'ports-row';
    el.classList.toggle('selected', key === this.selected);
    el.classList.toggle('system', l.system);

    const dot = document.createElement('span');
    dot.className = 'status-dot port-dot';
    dot.classList.toggle('exposed', isExposed(l.addresses));
    dot.title = exposureLabel(l.addresses);
    const url = localUrl(l);
    const stop = () => void stopListener(l, owner, this.opts.confirm, this.opts.store);
    const actions = document.createElement('span');
    actions.className = 'ports-actions';
    actions.append(
      this.button('Open', `Open ${url}`, true, () => this.openDefault(url)),
      // Present but disabled when no pane started it, so every row's buttons line up.
      this.button('Go to pane', owner ? `Go to ${owner}` : 'Not started from a pane', ptyId !== null, () => {
        if (ptyId !== null) this.opts.onGoToPane(ptyId);
      }),
      this.button('Stop', `Stop ${processLabel(l.name)} (pid ${l.pid})`, canStop(l), stop),
    );
    el.append(
      dot,
      this.cell('ports-port', String(l.port)),
      this.cell('ports-name', processLabel(l.name)),
      this.folderCell(l),
      ...(showPane ? [this.cell('ports-owner', owner ?? '')] : []),
      this.cell('ports-addr', addressLabel(l.addresses)),
      this.cell('ports-pid', String(l.pid)),
      this.cell('ports-up', formatUptime(nowSec, l.startedAt)),
      actions,
    );

    el.append(this.cell('ports-detail', l.command || (l.system ? 'Windows service' : 'Command line not available')));

    // Selecting in place, rather than rebuilding, keeps the row under the pointer for a double-click.
    el.addEventListener('click', () => {
      this.selected = key;
      for (const r of this.list.querySelectorAll('.ports-row.selected')) r.classList.remove('selected');
      el.classList.add('selected');
    });
    el.addEventListener('dblclick', (e) => {
      if (!(e.target instanceof Element && e.target.closest('button'))) this.openDefault(url);
    });
    attachContextMenu(el, () => ({
      target: el,
      entries: portMenuItems(l, {
        onOpenUrl: (u) => this.openUrl(u),
        onOpenLocal: this.opts.onOpenLocal,
        onCopy: (text, what) => void copyText(text, what),
        onGoToPane: ptyId === null ? undefined : () => this.opts.onGoToPane(ptyId),
        onStop: stop,
      }),
    }));
    return el;
  }

  /**
   * Present on every row, empty when the folder is unknown, so a wide pane can give it a column
   * that lines up; a narrow pane moves it beneath the row (portsPane.css).
   */
  private folderCell(l: Listener): HTMLElement {
    const cwd = document.createElement('span');
    cwd.className = 'ports-cwd';
    if (l.cwd) setPathText(cwd, l.cwd);
    return cwd;
  }

  private checkbox(box: HTMLInputElement, label: string, title: string): HTMLElement {
    const el = document.createElement('label');
    el.className = 'ports-check';
    box.type = 'checkbox';
    el.append(box, document.createTextNode(label));
    el.title = title;
    return el;
  }

  private button(label: string, title: string, enabled: boolean, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ports-btn';
    b.textContent = label;
    b.title = title;
    b.disabled = !enabled;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private cell(className: string, text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }

  /** The Open button and double-click: Local Browser when it can take the URL, else the system browser. */
  private openDefault(url: string): void {
    if (this.opts.onOpenLocal && isLoopbackUrl(url)) this.opts.onOpenLocal(url);
    else this.openUrl(url);
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
