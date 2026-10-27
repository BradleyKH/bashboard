import './containersPane.css';
import {
  containerAction,
  containerStats,
  type Container,
  type ContainerAction,
  type ContainerStats,
  type ContainersSnapshot,
  type Engine,
  type EngineState,
} from './containers';
import { engineLabel, groupContainers, type ContainerGroup } from './containerGroups';
import { renderContainerGroup } from './containerGroupView';
import { ContainerLogs } from './containerLogs';
import { containerUsage, renderContainerRow, updateContainerRow } from './containerRow';
import { containerKey, renderKey } from './containersRenderKey';
import type { ContainersStore } from './containersStore';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import type { PaneView } from './paneView';
import type { Settings } from './settings';
import { showToast } from './toast';

export interface ContainersPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  /** Whether the pane starts on screen; stats are polled only while it is. */
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The snapshot every Containers pane and the dashboard share. */
  store: ContainersStore;
  /** The Shell button: open a terminal in this container beside the pane. */
  onShell: (container: Container) => void;
}

const STATS_INTERVAL_MS = 5000;
const ENGINE_ORDER: Engine[] = ['docker', 'podman'];

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Docker and Podman containers grouped by Compose project (docs/design.md section 4.16). */
export class ContainersPane implements PaneView {
  readonly kind = 'containers' as const;
  readonly paneId: string;
  readonly folder = null;
  private readonly opts: ContainersPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly list: HTMLElement;
  private readonly logs: ContainerLogs;
  private settings: Settings;
  private expanded: boolean;
  private snapshot: ContainersSnapshot;
  /** Group keys the user expanded; kept across snapshots, so a group that reappears stays open. */
  private readonly expandedGroups = new Set<string>();
  /** Group keys and container keys with an action in flight. */
  private readonly busy = new Set<string>();
  private readonly stats = new Map<string, ContainerStats>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** `renderKey` of what is on screen; an unchanged key means only text needs refreshing. */
  private shownKey: string | null = null;
  /** The rendered row element for each container key. */
  private readonly rows = new Map<string, HTMLElement>();
  private disposed = false;
  private readonly unsubscribe: () => void;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: ContainersPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.expanded = opts.expanded;
    this.snapshot = opts.store.current();

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body ctr-body';
    this.body.tabIndex = -1;
    this.list = document.createElement('div');
    this.list.className = 'ctr-list';
    this.logs = new ContainerLogs({ onClose: () => this.render() });
    this.body.append(this.list, this.logs.el);
    this.host.appendChild(this.body);
    this.applySettings(opts.settings);

    this.unsubscribe = opts.store.subscribe((s) => {
      this.snapshot = s;
      this.pruneStats();
      this.render();
    });
    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));

    this.render();
    if (this.expanded) this.startStats();
  }

  title(): string {
    return 'Containers';
  }

  /** Expands a group by its `ContainerGroup.key` (the dashboard opens the pane on one). */
  expandGroup(key: string): void {
    if (this.expandedGroups.has(key)) return;
    this.expandedGroups.add(key);
    this.render();
    void this.pollStats();
  }

  focus(): void {
    this.body.focus();
  }

  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    if (expanded) this.startStats();
    else this.stopStats();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.logs.setFont(settings.font.family, settings.font.size);
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
    const row = this.body.querySelector<HTMLElement>('.ctr-group-head');
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
    this.unsubscribe();
    this.stopStats();
    this.logs.dispose();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private render(): void {
    if (this.disposed) return;
    const engines = ENGINE_ORDER.map((e) => this.snapshot.engines.find((s) => s.engine === e)).filter(
      (s): s is EngineState => s !== undefined,
    );
    if (engines.length === 0) {
      this.shownKey = null;
      this.rows.clear();
      this.list.replaceChildren(this.note('No container engine found.'));
      return;
    }
    const groups = groupContainers(this.snapshot.containers);
    const key = renderKey({
      engines,
      groups,
      expandedGroups: this.expandedGroups,
      busy: this.busy,
      logsKey: this.logs.key,
      usageText: (k) => this.usageText(k),
    });
    if (key === this.shownKey) {
      this.refreshText(groups);
      return;
    }
    this.shownKey = key;
    this.rows.clear();
    const out: HTMLElement[] = [];
    for (const e of engines) {
      if (engines.length > 1) out.push(this.engineHeading(e));
      if (!e.running) {
        out.push(this.note(`${engineLabel(e.engine)} is not running`));
        continue;
      }
      const mine = groups.filter((g) => g.engine === e.engine);
      if (mine.length === 0) out.push(this.note('No containers'));
      for (const g of mine) out.push(this.renderGroup(g));
    }
    this.list.replaceChildren(...out);
  }

  /** The usage line a running container's row shows, or '' when it shows none. */
  private usageText(key: string): string {
    const stats = this.stats.get(key);
    const running = this.snapshot.containers.some((c) => containerKey(c) === key && c.state === 'running');
    return running && stats ? containerUsage(stats) : '';
  }

  private refreshText(groups: readonly ContainerGroup[]): void {
    for (const g of groups) {
      for (const c of g.containers) {
        const el = this.rows.get(containerKey(c));
        if (el) updateContainerRow(el, c, this.stats.get(containerKey(c)) ?? null);
      }
    }
  }

  private engineHeading(e: EngineState): HTMLElement {
    const h = document.createElement('div');
    h.className = 'ctr-engine';
    const name = document.createElement('span');
    name.className = 'ctr-engine-name';
    name.textContent = engineLabel(e.engine);
    const state = document.createElement('span');
    state.className = `ctr-engine-state${e.running ? ' running' : ''}`;
    state.textContent = e.running ? 'running' : 'not running';
    h.append(name, state);
    return h;
  }

  private note(text: string): HTMLElement {
    const n = document.createElement('div');
    n.className = 'ctr-note';
    n.textContent = text;
    return n;
  }

  private renderGroup(g: ContainerGroup): HTMLElement {
    return renderContainerGroup(g, {
      expanded: this.expandedGroups.has(g.key),
      busy: this.busy.has(g.key),
      onToggle: () => this.toggleGroup(g.key),
      onAction: (action) => void this.act(g.key, g.engine, g.containers, action, g.name),
      renderRow: (i) => {
        const c = g.containers[i];
        const key = containerKey(c);
        const el = renderContainerRow(c, {
          stats: this.stats.get(key) ?? null,
          logsOpen: this.logs.key === key,
          busy: this.busy.has(key) || this.busy.has(g.key),
          onAction: (action) => void this.act(key, c.engine, [c], action, c.name),
          onLogs: () => this.openLogs(c),
          onShell: () => this.opts.onShell(c),
        });
        this.rows.set(key, el);
        return el;
      },
    });
  }

  private toggleGroup(key: string): void {
    if (this.expandedGroups.has(key)) this.expandedGroups.delete(key);
    else this.expandedGroups.add(key);
    this.render();
    void this.pollStats();
  }

  private openLogs(c: Container): void {
    if (this.logs.key === containerKey(c)) return;
    this.logs.open(c);
    this.render();
  }

  /** The store refreshes from the engine's events, so success needs no re-render of its own. */
  private async act(
    busyKey: string,
    engine: Engine,
    containers: readonly Container[],
    action: ContainerAction,
    label: string,
  ): Promise<void> {
    if (this.busy.has(busyKey)) return;
    this.busy.add(busyKey);
    this.render();
    try {
      await containerAction(engine, containers.map((c) => c.id), action);
    } catch (e) {
      showToast(`Could not ${action} ${label}: ${errorText(e)}`);
    } finally {
      this.busy.delete(busyKey);
      this.render();
    }
  }

  private startStats(): void {
    if (this.statsTimer !== null || this.disposed) return;
    this.statsTimer = setInterval(() => void this.pollStats(), STATS_INTERVAL_MS);
    void this.pollStats();
  }

  private stopStats(): void {
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  /** Samples the running containers in expanded groups, one call per engine. */
  private async pollStats(): Promise<void> {
    if (this.disposed || !this.expanded || this.polling) return;
    const byEngine = new Map<Engine, string[]>();
    for (const g of groupContainers(this.snapshot.containers)) {
      if (!this.expandedGroups.has(g.key)) continue;
      for (const c of g.containers) {
        if (c.state !== 'running') continue;
        const ids = byEngine.get(c.engine) ?? [];
        ids.push(c.id);
        byEngine.set(c.engine, ids);
      }
    }
    if (byEngine.size === 0) return;
    this.polling = true;
    try {
      const results = await Promise.allSettled(
        [...byEngine].map(([engine, ids]) => containerStats(engine, ids)),
      );
      if (this.disposed) return;
      for (const r of results) {
        // A failed sample keeps the last numbers; the next tick tries again.
        if (r.status !== 'fulfilled') continue;
        for (const s of r.value) this.stats.set(containerKey(s), s);
      }
      this.render();
    } finally {
      this.polling = false;
    }
  }

  private pruneStats(): void {
    const live = new Set(this.snapshot.containers.filter((c) => c.state === 'running').map(containerKey));
    for (const key of this.stats.keys()) if (!live.has(key)) this.stats.delete(key);
  }

  private onKeyDown(e: KeyboardEvent): void {
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
