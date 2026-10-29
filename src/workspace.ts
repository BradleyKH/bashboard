import { invoke } from '@tauri-apps/api/core';
import type { AttentionCause } from './attention';
import type { ConfirmOptions } from './confirmDialog';
import { shellCommand, type Container } from './containers';
import { ContainersPane } from './containersPane';
import { ContainersStore } from './containersStore';
import { boundSession, isBusy, lastFolder, type PaneCardInput } from './dashboardModel';
import { DockOverlay } from './dockOverlay';
import { DoneTracker } from './doneStatus';
import { FilesPane } from './filesPane';
import { routeFilesRequest, type FilesRequest } from './filesRouting';
import {
  applyDock,
  dropZones,
  expandInto,
  focusAfterRemoval,
  type DockTarget,
  type DragSource,
  type DropTarget,
} from './docking';
import { FindBar } from './findBar';
import { GitPane } from './gitPane';
import { routeGitRequest } from './gitModel';
import { forget, recentTerminal, touch } from './focusHistory';
import { DEFAULT_FONT_SIZE, stepFontSize } from './fontSize';
import { lookup, type Action } from './keymap';
import { handleKey } from './keys';
import {
  autoDir,
  clampRatio,
  close,
  computeRects,
  findPath,
  leaves,
  neighbor,
  resizePane,
  setRatio,
  split,
  type CellSize,
  type Dir,
  type Direction,
  type Layout,
  type Rect,
} from './layout';
import { LayoutView } from './layoutView';
import { LiveSettings } from './liveSettings';
import { TerminalPane } from './pane';
import { PaneAttention } from './paneAttention';
import { repoRoot } from './repoFiles';
import type { PaneKind } from './paneKinds';
import type { PaneView } from './paneView';
import { scratchDelete, scratchLoad, scratchSave, scratchSaveAs, type PtyActivity } from './persistence';
import { restoredTab, snapshotTabs } from './savedTabs';
import { TabStore } from './tabStore';
import type { SavedPane, SavedTab, SavedWorkspace } from './savedWorkspace';
import { initialQuery } from './searchModel';
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from './searchOptions';
import { SearchPane } from './searchPane';
import { newScratchId } from './scratchModel';
import { ScratchPane } from './scratchPane';
import { applyScrim, nextScrim, scrimFromSettings, type ScrimState } from './scrim';
import type { HookEvent, Session } from './sessions';
import { saveSetting, type Settings, type SettingsPayload } from './settings';
import { applyActivity } from './sweepTracker';
import {
  addTab,
  closeTab as closeTabState,
  combinedStatus,
  nextTab,
  renameTab as renameTabState,
  reorderTab as reorderTabState,
  switchTab as switchTabState,
  tabAt,
  tabTitle,
  type TabState,
} from './tabs';
import {
  shellStatus,
  terminalStatus,
  type ShellStatus,
  type SweepState,
  type TerminalStatus,
} from './terminalStatus';
import { TitleStrip } from './titleStrip';
import { showToast } from './toast';
import { PaneZoom } from './zoom';

export type { DragSource };

export interface TerminalInfo {
  kind: 'terminal';
  paneId: string;
  tabId: string;
  /** Null until the spawn resolves and after the shell exits. */
  ptyId: number | null;
  cwd: string | null;
  /** Resolved shell profile id; the configured default until the spawn resolves. */
  profile: string;
  focused: boolean;
  /** Epoch ms. */
  openedAt: number;
  collapsed: boolean;
  shell: ShellStatus;
  attention: boolean;
  done: boolean;
}

/** One tab as the tab strip and dashboard show it (docs/design.md section 4.10). */
export interface TabInfo {
  id: string;
  /** The fixed name, else the focused pane's title. */
  title: string;
  /** Null while the title follows the focused pane. */
  name: string | null;
  active: boolean;
  paneCount: number;
  /** The most urgent of its terminals' statuses. */
  status: TerminalStatus;
  /** True while any of its terminals has attention. */
  attention: boolean;
}

export interface WorkspaceHooks {
  onToggleDashboard?: () => void;
  onFocusDashboard?: () => void;
  onOpenFavoritePicker?: () => void;
  onOpenLayoutPicker?: () => void;
  onOpenProfilePicker?: () => void;
  onShowHelp?: () => void;
  onOpenSettings?: () => void;
  onToggleBackdrop?: () => void;
  onToggleFullscreen?: () => void;
  /** Called whenever a pane's attention is newly raised (docs/design.md section 4.7). */
  onAttention?: (paneId: string, cause: AttentionCause) => void;
  /** Pointer position during a pane drag, `null` when it ends. */
  onDragHover?: (pos: { x: number; y: number } | null) => void;
  /** The dashboard tab group under the point during a pane drag (docs/design.md section 4.6). */
  tabDropAt?: (x: number, y: number) => { tabId: string; rect: DOMRect } | null;
  /** Asks before closing a tab whose `busy` panes would lose work; true closes it. */
  onConfirmCloseTab?: (tabId: string, busy: PaneCardInput[]) => Promise<boolean>;
  /** Asks before Ctrl+W closes a scratch pad that has text; true closes it. */
  onConfirmClosePane?: (paneId: string) => Promise<boolean>;
  /** Asks before the kind menu replaces a busy terminal or a pad with text; true replaces it. */
  onConfirmReplace?: (paneId: string, kind: PaneKind) => Promise<boolean>;
  /** Shows a confirm dialog for a pane's own question (a Git pane's Undo last commit); true goes ahead. */
  onConfirm?: (options: ConfirmOptions) => Promise<boolean>;
  /** A Files pane pinned a file or folder of the repo at `root` (docs/design.md section 4.12). */
  onPin?: (root: string, absolute: string, isDir: boolean) => void;
  onUnpin?: (root: string, absolute: string) => void;
  /** Absolute paths of the existing pinned folders of the repo at `root`. */
  getPinnedFolders?: (root: string) => string[];
  /** The Repo section's repo root, which a pane with no folder passes on when replaced (4.11). */
  getRepoFolder?: () => string | null;
  /** The container snapshot every Containers pane shares (docs/design.md section 4.16). */
  containers?: ContainersStore;
}

export interface OpenPaneOptions {
  collapsed?: boolean;
  dock?: DockTarget;
}

export interface OpenTerminalOptions extends OpenPaneOptions {
  /** Shell profile id; omitted uses `shell.defaultProfile`. */
  profile?: string;
}

/** What to build for a new pane (docs/design.md section 4.11). */
export type PaneSpec =
  | {
      kind: 'terminal';
      cwd?: string;
      profile?: string;
      /** Runs in place of the profile's shell. */
      command?: string[];
      /** Marks a container shell (design 4.16), which is titled by it and never saved. */
      container?: { name: string };
    }
  | { kind: 'scratch'; scratchId?: string; text?: string | Promise<string> }
  | { kind: 'files'; folder: string; selected?: string | null; root?: string }
  | { kind: 'git'; root: string }
  | { kind: 'search'; root: string; query?: string; options?: SearchOptions }
  | { kind: 'containers' };

/**
 * Owns the tabs, each with its own split tree, focus, and collapsed panes, plus every pane of
 * every kind and the scrim state (docs/design.md sections 4.2, 4.3, 4.10, 4.11). Everything that
 * acts on "the" tree or focus acts on the active tab. A tab's `focusedId` is always an expanded
 * pane, or '' when none is.
 */
export class Workspace {
  private readonly store = new TabStore();
  private readonly paneViews = new Map<string, PaneView>();
  private readonly hosts = new Map<string, HTMLElement>();
  private readonly strips = new Map<string, TitleStrip>();
  /** Terminals take `p<n>`, every other kind `v<n>`, so saved keys never collide across kinds. */
  private nextId = 1;
  private nextViewId = 1;
  private readonly config: LiveSettings;
  private readonly view: LayoutView;
  private readonly overlay: DockOverlay;
  private drag: DragSource | null = null;
  private scrim: ScrimState;
  /** Tracked locally so quick repeats don't act on a size the file watcher hasn't reported back yet. */
  private fontSize: number;
  private readonly openedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private sessions: Session[] = [];
  /** Keyed by pty id. */
  private sweeps = new Map<number, SweepState>();
  private sizer: HTMLElement | null = null;
  /** Session ids from the restored workspace, kept until a session binds to the pane. */
  private readonly restoredSessions = new Map<string, string>();
  /** Container shell pane ids to their container's name. */
  private readonly containerShells = new Map<string, string>();
  private emptyContainers: ContainersStore | undefined;
  private readonly attention: PaneAttention;
  private readonly done = new DoneTracker();
  private readonly zoom = new PaneZoom();
  /** Tab id to the panes that tab's zoom took off screen, restored when the zoom ends. */
  private readonly zoomHidden = new Map<string, Set<string>>();
  /** The active tab's zoomed pane as the last render decided it. */
  private zoomedId: string | null = null;
  private readonly findBar = new FindBar();
  /** Pane ids, most recently focused first; Send targets the newest terminal in the pad's tab. */
  private focusOrder: string[] = [];

  constructor(
    private readonly root: HTMLElement,
    payload: SettingsPayload,
    private readonly hooks: WorkspaceHooks = {},
  ) {
    this.config = new LiveSettings(payload);
    this.fontSize = payload.settings.font.size;
    this.scrim = scrimFromSettings(payload.settings.scrim);
    applyScrim(document.documentElement, this.scrim);
    this.view = new LayoutView(root, {
      clampRatio: (path, ratio) => {
        const cell = this.layoutCell();
        if (!this.store.tree || !cell) return ratio;
        return clampRatio(this.store.tree, path, ratio, this.containerRect(), cell);
      },
      // Panes refit live during the drag through their ResizeObservers; this commits the ratio.
      onRatioChange: (path, ratio) => {
        if (!this.store.tree) return;
        this.store.tree = setRatio(this.store.tree, path, ratio);
        this.render();
      },
    });
    this.overlay = new DockOverlay(root, {
      paneRects: () => this.paneRects(),
      areaRect: () => (this.store.tree ? this.root.getBoundingClientRect() : null),
      zonesFor: (paneId) => (this.drag ? dropZones(this.drag, paneId) : []),
      onDrop: (target) => this.onDrop(target),
      onHover: (pos) => this.hooks.onDragHover?.(pos),
      tabAt: (x, y) => {
        if (this.drag?.kind !== 'pane') return null;
        const hit = this.hooks.tabDropAt?.(x, y) ?? null;
        return hit && hit.tabId !== this.store.tabOf(this.drag.paneId)?.id ? hit : null;
      },
      onCancel: () => {
        this.drag = null;
        this.paneViews.get(this.store.focusedId)?.focus();
      },
    });
    this.attention = new PaneAttention({
      isSeen: (id) => this.isSeen(id),
      host: (id) => this.hosts.get(id),
      onRaised: (id, cause) => this.hooks.onAttention?.(id, cause),
    });
    window.addEventListener('focus', () => {
      const cleared = this.attention.clearIfSeen(this.store.focusedId);
      if (this.clearDoneIfSeen() || cleared) this.notify();
    });
    // Bubble phase, so inputs that stop propagation of their own keys (the favorites picker) win.
    window.addEventListener('keydown', (e) => this.onEmptyLayoutKey(e));
  }

  /** Adds the first pane, or splits the focused pane when one exists. */
  addPane(cwd?: string): void {
    if (this.store.tree) {
      this.split('auto');
      return;
    }
    const id = this.takeId();
    this.mount(id, { kind: 'pane', paneId: id }, { kind: 'terminal', cwd });
  }

  /** Opens a terminal in `cwd`: collapsed, docked at a target, or split from the focused pane. */
  openTerminal(cwd?: string, opts: OpenTerminalOptions = {}): void {
    this.openPane({ kind: 'terminal', cwd, profile: opts.profile }, opts);
  }

  /**
   * Design 4.11 Opening: a pane of any kind, collapsed, docked at a target, or split from the
   * focused pane; with no room it opens collapsed.
   */
  openPane(spec: PaneSpec, opts: OpenPaneOptions = {}): void {
    const id = this.takeIdFor(spec.kind);
    if (opts.collapsed) {
      this.openCollapsed(id, spec);
      return;
    }
    if (!this.store.tree) {
      this.mount(id, { kind: 'pane', paneId: id }, spec);
      return;
    }
    const cell = this.layoutCell();
    if (!cell) return;
    const container = this.containerRect();
    let next: Layout | null = null;
    let displaced: string | null = null;
    if (opts.dock) {
      const r = applyDock(this.store.tree, id, false, opts.dock, container, cell);
      if (r.kind === 'ok') {
        next = r.tree;
        displaced = r.displaced;
      }
    } else {
      next = expandInto(this.store.tree, this.store.focusedId, id, container, cell);
    }
    if (!next) {
      showToast('Not enough room for another pane; opened it collapsed');
      this.openCollapsed(id, spec);
      return;
    }
    if (displaced) this.markCollapsed(displaced);
    this.mount(id, next, spec);
  }

  applySettings(payload: SettingsPayload): void {
    this.config.update(payload);
    this.fontSize = this.config.settings.font.size;
    this.scrim = scrimFromSettings(this.config.settings.scrim);
    applyScrim(document.documentElement, this.scrim);
    for (const pane of this.paneViews.values()) pane.applySettings(this.config.settings);
  }

  private setFontSize(size: number): void {
    if (size === this.fontSize) return;
    this.fontSize = size;
    const settings = this.paneSettings();
    for (const pane of this.paneViews.values()) pane.applySettings(settings);
    saveSetting(['font', 'size'], size).catch((err: unknown) =>
      showToast(`Could not save the font size: ${String(err)}`),
    );
  }

  split(dir: Dir | 'auto'): void {
    const cell = this.layoutCell();
    if (!this.store.tree || !this.paneViews.has(this.store.focusedId) || !cell) return;
    const container = this.containerRect();
    let d: Dir;
    if (dir === 'auto') {
      const rect = computeRects(this.store.tree, container).get(this.store.focusedId);
      if (!rect) return;
      d = autoDir(rect);
    } else {
      d = dir;
    }
    const id = `p${this.nextId}`;
    const next = split(this.store.tree, this.store.focusedId, id, d, container, cell);
    if (next === this.store.tree) return;
    this.takeId();
    this.mount(id, next, { kind: 'terminal', cwd: this.folderForNew() });
  }

  /**
   * Every terminal, collapsed ones included, grouped by tab in strip order; within a tab, in
   * the order they were opened or moved in.
   */
  terminals(): TerminalInfo[] {
    return this.panes().filter((p): p is TerminalInfo => p.kind === 'terminal');
  }

  /** Every pane of every kind as a dashboard card input, in the order of `terminals()`. */
  panes(): PaneCardInput[] {
    const out: PaneCardInput[] = [];
    for (const tab of this.store.state.tabs) {
      for (const paneId of tab.panes) {
        const input = this.paneInput(tab, paneId);
        if (input) out.push(input);
      }
    }
    return out;
  }

  /** Panes that closing would lose work in: busy terminals and scratch pads with text. */
  busyPanes(tabId?: string): PaneCardInput[] {
    return this.panes().filter((p) => (tabId === undefined || p.tabId === tabId) && this.losesWork(p));
  }

  /** Tabs in strip order. */
  tabs(): TabInfo[] {
    return this.store.state.tabs.map((tab) => ({
      id: tab.id,
      title: tabTitle(tab, this.titleOf(tab.focusedId || (tab.panes[0] ?? ''))),
      name: tab.name,
      active: tab.id === this.store.activeId,
      paneCount: tab.panes.length,
      status: combinedStatus(tab.panes.filter((id) => this.terminal(id)).map((id) => this.statusOf(id))),
      attention: tab.panes.some((id) => this.attention.has(id)),
    }));
  }

  /** Design 4.10: a tab with one default-profile terminal in the focused pane's folder. */
  newTab(): void {
    const cwd = this.folderForNew();
    const prev = this.store.active;
    this.store.state = addTab(this.store.state, this.store.emptyTab());
    this.hideTab(prev);
    const id = this.takeId();
    this.mount(id, { kind: 'pane', paneId: id }, { kind: 'terminal', cwd });
  }

  switchTab(id: string): void {
    if (id === this.store.activeId || !this.store.state.tabs.some((t) => t.id === id)) return;
    const prev = this.store.active;
    this.store.state = switchTabState(this.store.state, id);
    this.hideTab(prev);
    this.showActive();
    this.notify();
    // A tab switched to mid-drag has different pane rects.
    this.overlay.refresh();
  }

  /** Closes every pane in the tab without asking; `requestCloseTab` asks first. */
  closeTab(id: string): void {
    const tab = this.store.find(id);
    if (!tab) return;
    const wasActive = id === this.store.activeId;
    for (const paneId of tab.panes) this.forgetPane(paneId);
    this.zoom.forget(id);
    this.zoomHidden.delete(id);
    const next = closeTabState(this.store.state, id);
    if (!next) {
      this.closeWindow();
      return;
    }
    this.store.state = next;
    if (wasActive) this.showActive();
    this.notify();
  }

  /** Closes the tab, first asking through `onConfirmCloseTab` when closing would lose work. */
  async requestCloseTab(id: string): Promise<void> {
    if (!this.store.state.tabs.some((t) => t.id === id)) return;
    const busy = this.busyPanes(id);
    if (busy.length > 0 && this.hooks.onConfirmCloseTab) {
      if (!(await this.hooks.onConfirmCloseTab(id, busy))) {
        this.paneViews.get(this.store.focusedId)?.focus();
        return;
      }
    }
    this.closeTab(id);
  }

  /** A blank name returns the tab to following its focused pane. */
  renameTab(id: string, name: string): void {
    this.store.state = renameTabState(this.store.state, id, name);
    this.notify();
  }

  reorderTab(from: number, to: number): void {
    const next = reorderTabState(this.store.state, from, to);
    if (next === this.store.state) return;
    this.store.state = next;
    this.notify();
  }

  /**
   * Design 4.6, 4.9, and 4.11: appends the saved tab as the active tab, fixed to `name`, without
   * resuming Claude sessions; its scratch pads open fresh.
   */
  openLayout(saved: SavedTab, name: string): void {
    const prev = this.store.active;
    const { tab, ids } = restoredTab(saved, this.store.takeTabId(), name, (p) => this.takeIdFor(p.kind));
    this.store.state = addTab(this.store.state, tab);
    this.hideTab(prev);
    if (saved.panes.length === 0) {
      const id = this.takeId();
      this.mount(id, { kind: 'pane', paneId: id }, { kind: 'terminal' });
      return;
    }
    // Every expanded host must be attached and sized before its pane opens, since start() fits to it.
    for (const p of saved.panes) if (!p.collapsed) this.createHost(ids.get(p.key)!);
    this.render();
    this.buildTab(saved, ids, true, { resumeClaude: false, loadScratch: false });
    // A layout of only collapsed panes would leave nothing to type into.
    if (!this.store.tree) {
      this.expandPane(tab.panes[0]);
      return;
    }
    this.paneViews.get(this.store.focusedId)?.focus();
    this.notify();
  }

  /** Listeners run after state changes and must not re-render the layout. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Switches to the pane's tab first. Collapsed panes are ignored; expanding one is `expandPane`. */
  focusPane(paneId: string): void {
    const pane = this.paneViews.get(paneId);
    const tab = this.store.tabOf(paneId);
    if (!pane || !tab || this.store.isCollapsed(paneId)) return;
    if (tab.id !== this.store.activeId) {
      this.store.update(tab.id, { focusedId: paneId });
      this.switchTab(tab.id);
      return;
    }
    // A hidden pane of the zoomed tab (a card click) ends the zoom first.
    if (this.zoomedId !== null && paneId !== this.zoomedId) {
      this.zoom.end(tab.id);
      this.render();
    }
    this.setFocused(paneId);
    pane.focus();
  }

  /**
   * Closes the pane without asking, expanded or collapsed, killing a terminal's shell or
   * deleting a pad's file; a tab's last closes the tab, the last tab the window.
   */
  closePane(id: string): void {
    const tab = this.store.tabOf(id);
    if (!this.paneViews.has(id) || !tab) return;
    const wasActive = tab.id === this.store.activeId;
    const inTree = this.store.removeFromTree(id);
    this.forgetPane(id);
    if (!this.store.removePane(id)) {
      this.closeWindow();
      return;
    }
    if (wasActive && this.store.activeId !== tab.id) this.showActive();
    else if (wasActive && inTree) this.render();
    this.notify();
  }

  /** Ctrl+W: a scratch pad with text asks through `onConfirmClosePane` first (design 4.15). */
  async requestClosePane(id: string): Promise<void> {
    const pad = this.scratch(id);
    if (pad && !pad.isEmpty() && this.hooks.onConfirmClosePane) {
      if (!(await this.hooks.onConfirmClosePane(id))) {
        this.paneViews.get(this.store.focusedId)?.focus();
        return;
      }
    }
    this.closePane(id);
  }

  /** Design 4.3: leaves the tree like closing, but the pane stays alive off the DOM. */
  collapsePane(paneId: string): void {
    if (!this.store.tree || !this.paneViews.has(paneId) || !findPath(this.store.tree, paneId)) return;
    const target = focusAfterRemoval(this.store.tree, paneId, this.store.focusedId);
    this.store.tree = close(this.store.tree, paneId);
    this.store.focusedId = this.store.tree ? target : '';
    this.markCollapsed(paneId);
    this.render();
    this.notify();
  }

  /** Switches to the pane's tab, then splits its focused pane in the auto direction or fills an empty layout. */
  expandPane(paneId: string): void {
    const pane = this.paneViews.get(paneId);
    const tab = this.store.tabOf(paneId);
    if (!pane || !tab || !this.store.isCollapsed(paneId)) return;
    this.switchTab(tab.id);
    const cell = this.layoutCell() ?? pane.cellSize();
    const next = expandInto(this.store.tree, this.store.focusedId, paneId, this.containerRect(), cell);
    if (!next) {
      showToast('Not enough room to expand the pane');
      return;
    }
    this.store.tree = next;
    this.store.setCollapsed(paneId, false);
    this.store.focusedId = paneId;
    this.render();
    // After render, so the host is attached when WebGL loads and the refit runs.
    pane.setExpanded(true);
    pane.focus();
    this.notify();
  }

  /**
   * Design 4.2 docking into the active tab; a null target is only valid while its layout is
   * empty. A pane from another tab moves into the active one, closing a source tab it empties.
   */
  dock(paneId: string, target: DockTarget | null): void {
    const pane = this.paneViews.get(paneId);
    const source = this.store.tabOf(paneId);
    if (!pane || !source) return;
    const fromActive = source.id === this.store.activeId;
    const inTree = fromActive && this.store.tree !== null && findPath(this.store.tree, paneId) !== null;
    const cell = this.layoutCell() ?? pane.cellSize();
    const r = applyDock(this.store.tree, paneId, inTree, target, this.containerRect(), cell);
    if (r.kind !== 'ok') {
      if (r.kind === 'noRoom') showToast('Not enough room to dock there');
      this.paneViews.get(this.store.focusedId)?.focus();
      return;
    }
    this.store.moveToActive(paneId);
    if (r.displaced) this.markCollapsed(r.displaced);
    this.store.tree = r.tree;
    this.store.setCollapsed(paneId, false);
    this.store.focusedId = paneId;
    this.render();
    if (!inTree) pane.setExpanded(true);
    pane.focus();
    this.notify();
  }

  /**
   * Design 4.6: a card dropped on another tab's group moves its pane into that tab without
   * switching to it. A collapsed pane stays collapsed; an expanded one splits that tab's focused
   * pane as expanding does, or lands collapsed when there is no room. A tab it empties closes.
   */
  moveToTab(paneId: string, tabId: string): void {
    const pane = this.paneViews.get(paneId);
    const source = this.store.tabOf(paneId);
    const target = this.store.find(tabId);
    if (!pane || !source || !target || source.id === tabId) {
      this.paneViews.get(this.store.focusedId)?.focus();
      return;
    }
    const activeBefore = this.store.activeId;
    const toActive = tabId === activeBefore;
    const wasCollapsed = this.store.isCollapsed(paneId);
    const wasOnScreen = source.id === activeBefore && !wasCollapsed;
    let next: Layout | null = null;
    if (!wasCollapsed) {
      // Every tab fills the same pane area, so the active tab's rect stands in for the target's.
      const cell = (toActive ? this.layoutCell() : null) ?? pane.cellSize();
      next = expandInto(target.tree, target.focusedId, paneId, this.containerRect(), cell);
      if (!next) showToast('Not enough room in that tab, so the pane moved collapsed');
    }
    this.store.moveTo(paneId, tabId, next === null);
    if (next) this.store.update(tabId, { tree: next, focusedId: paneId });
    else if (!wasCollapsed) this.markCollapsed(paneId);

    if (this.store.activeId !== activeBefore) {
      // The source was the active tab and the move emptied it.
      this.zoom.forget(source.id);
      this.zoomHidden.delete(source.id);
      if (this.store.activeId !== tabId) {
        const fallback = this.store.active;
        this.store.state = switchTabState(this.store.state, tabId);
        this.hideTab(fallback);
      }
      this.showActive();
    } else if (toActive) {
      this.render();
      if (next) {
        pane.setExpanded(true);
        pane.focus();
      }
    } else {
      if (wasOnScreen && next) pane.setExpanded(false);
      if (wasOnScreen) this.render();
      this.paneViews.get(this.store.focusedId)?.focus();
    }
    this.notify();
  }

  /** Starts a pointer drag that docks a pane or opens a folder where it drops. */
  startDrag(source: DragSource, e: PointerEvent): void {
    if (source.kind === 'pane' && !this.paneViews.has(source.paneId)) return;
    this.drag = source;
    const label = source.kind === 'pane' ? this.titleOf(source.paneId) : lastFolder(source.path) || source.path;
    this.overlay.begin(e, label);
  }

  /**
   * Design 4.11 Kind menu: replaces the pane in place with a new pane of `kind`, asking first
   * when that would lose work.
   */
  async replaceKind(paneId: string, kind: PaneKind): Promise<void> {
    const old = this.paneViews.get(paneId);
    if (!old || old.kind === kind) return;
    const input = this.store.tabOf(paneId) ? this.paneInput(this.store.tabOf(paneId)!, paneId) : null;
    if (input && this.losesWork(input) && this.hooks.onConfirmReplace) {
      const ok = await this.hooks.onConfirmReplace(paneId, kind);
      if (!ok) {
        this.paneViews.get(this.store.focusedId)?.focus();
        return;
      }
    }
    // The pane or its tab may have changed while the dialog was open.
    const tab = this.store.tabOf(paneId);
    if (!tab || this.paneViews.get(paneId) !== old) return;
    const spec = this.specForKind(kind, old.folder, tab);
    const id = this.takeIdFor(kind);
    const visible = tab.id === this.store.activeId && !tab.collapsed.includes(paneId);
    this.store.replacePane(paneId, id);
    this.forgetPane(paneId);
    if (visible) {
      const host = this.createHost(id);
      this.store.focusedId = id;
      this.render();
      const pane = this.buildPane(id, host, spec, true);
      pane.focus();
      this.notify();
      this.startPane(id, pane);
      return;
    }
    this.openOffscreen(id, spec);
    this.notify();
  }

  setSessions(sessions: Session[]): void {
    this.sessions = sessions;
    let raised = false;
    for (const id of this.paneViews.keys()) {
      const term = this.terminal(id);
      if (term && boundSession(term.ptyId, sessions)) this.restoredSessions.delete(id);
      if (this.refreshStrip(id)) raised = true;
    }
    if (raised) this.notify();
  }

  /** Pane id of the terminal running the core's pty `ptyId` (`BASHBOARD_PANE_ID`), in any tab. */
  terminalForPty(ptyId: number): string | null {
    for (const id of this.paneViews.keys()) {
      if (this.terminal(id)?.ptyId === ptyId) return id;
    }
    return null;
  }

  /**
   * Design 3.13: makes the pane's tab active and the source of the next split. A collapsed pane
   * has no place in the tree, so its tab's own focused pane is the source.
   */
  anchorOn(paneId: string): void {
    const tab = this.store.tabOf(paneId);
    if (!tab || !this.paneViews.has(paneId)) return;
    if (this.store.isCollapsed(paneId)) this.switchTab(tab.id);
    else this.focusPane(paneId);
  }

  /** Design 4.8: an unseen `Stop` for a terminal's bound session shows `done` on it. */
  onHook(ev: HookEvent): void {
    if (ev.hookEventName !== 'Stop') return;
    let match = ev.paneId === null ? null : this.terminalForPty(ev.paneId);
    if (!match) {
      for (const id of this.paneViews.keys()) {
        const pane = this.terminal(id);
        if (pane && boundSession(pane.ptyId, this.sessions)?.sessionId === ev.sessionId) {
          match = id;
          break;
        }
      }
    }
    if (!match || !this.done.mark(match, ev.sessionId, ev.at, this.isSeen(match))) return;
    this.refreshStrip(match);
    this.notify();
  }

  /** Design 4.9: layout leaves already hold pane ids, which double as saved keys. */
  snapshot(): SavedWorkspace {
    return snapshotTabs(this.store.state, (id, collapsed): SavedPane | null => {
      const pane = this.paneViews.get(id);
      if (this.containerShells.has(id)) return null;
      if (pane instanceof TerminalPane) {
        return {
          key: id,
          kind: 'terminal',
          cwd: pane.cwd ?? '',
          collapsed,
          sessionId: boundSession(pane.ptyId, this.sessions)?.sessionId ?? this.restoredSessions.get(id) ?? null,
          ...(pane.profile !== undefined && { profile: pane.profile }),
        };
      }
      if (pane instanceof ScratchPane) return { key: id, collapsed, kind: 'scratch', scratchId: pane.scratchId };
      if (pane instanceof FilesPane) return { key: id, collapsed, kind: 'files', ...pane.saved() };
      if (pane instanceof GitPane) return { key: id, collapsed, kind: 'git', ...pane.saved() };
      if (pane instanceof SearchPane) return { key: id, collapsed, kind: 'search', ...pane.saved() };
      if (pane instanceof ContainersPane) return { key: id, collapsed, kind: 'containers' };
      return null;
    });
  }

  /**
   * Design 4.9: a new shell per saved terminal and each pad with its saved text, tab by tab in
   * saved order. Expects an empty workspace and at least one saved tab.
   */
  restore(saved: SavedWorkspace, opts: { resumeClaude: boolean }): void {
    if (saved.tabs.length === 0) return;
    const built = saved.tabs.map((t) => ({
      saved: t,
      ...restoredTab(t, this.store.takeTabId(), t.name, (p) => this.takeIdFor(p.kind)),
    }));
    const active = built[Math.min(Math.max(saved.activeTab, 0), built.length - 1)];
    this.store.state = { tabs: built.map((b) => b.tab), activeId: active.tab.id };
    // Every expanded host must be attached and sized before its pane opens, since start() fits to it.
    for (const p of active.saved.panes) if (!p.collapsed) this.createHost(active.ids.get(p.key)!);
    this.render();
    for (const b of built) {
      this.buildTab(b.saved, b.ids, b === active, { resumeClaude: opts.resumeClaude, loadScratch: true });
    }
    for (const [hid, host] of this.hosts) host.classList.toggle('focused', hid === this.store.focusedId);
    this.paneViews.get(this.store.focusedId)?.focus();
    this.notify();
  }

  /** Saves every pad's and Files editor's pending text now, for the window closing. */
  async flushPanes(): Promise<void> {
    const panes = [...this.paneViews.values()].filter(
      (p): p is ScratchPane | FilesPane => p instanceof ScratchPane || p instanceof FilesPane,
    );
    await Promise.all(panes.map((p) => p.flush()));
  }

  /**
   * Design 4.12: shows the folder in the active tab's Files pane for that repo, or opens one as
   * a split of the focused pane.
   */
  showFiles(req: FilesRequest, opts: OpenPaneOptions = {}): void {
    const panes = this.store.active.panes.flatMap((id) => {
      const pane = this.paneViews.get(id);
      return pane instanceof FilesPane ? [{ paneId: id, root: pane.root(), folder: pane.folder }] : [];
    });
    const route = routeFilesRequest(panes, req);
    if ('reuse' in route) {
      const pane = this.paneViews.get(route.reuse) as FilesPane;
      if (this.store.isCollapsed(route.reuse)) this.expandPane(route.reuse);
      else this.focusPane(route.reuse);
      void pane.showFolder(req.folder, req.select);
      return;
    }
    this.openPane({ kind: 'files', folder: req.folder, selected: req.select ?? null, root: req.root }, opts);
  }

  /**
   * Design 4.13: focuses the active tab's Git pane for that repo, or opens one as a split of the
   * focused pane.
   */
  showGit(root: string, opts: OpenPaneOptions = {}): void {
    const panes = this.store.active.panes.flatMap((id) => {
      const pane = this.paneViews.get(id);
      return pane instanceof GitPane ? [{ paneId: id, root: pane.root() }] : [];
    });
    const route = routeGitRequest(panes, root);
    if ('reuse' in route) {
      if (this.store.isCollapsed(route.reuse)) this.expandPane(route.reuse);
      else this.focusPane(route.reuse);
      return;
    }
    this.openPane({ kind: 'git', root }, opts);
  }

  /** Design 4.14: opens a Search pane on the repo as a split of the focused pane, never reusing one. */
  showSearch(root: string, query = '', opts: OpenPaneOptions = {}): void {
    this.openPane({ kind: 'search', root, query }, opts);
  }

  /**
   * Design 4.16: shows the first Containers pane in tab order, or appends a Containers tab, then
   * expands the groups with those `ContainerGroup` keys.
   */
  openContainers(groupKeys: string[] = []): void {
    const find = (tabs: TabState[]) =>
      tabs.flatMap((t) => t.panes).find((id) => this.paneViews.get(id) instanceof ContainersPane);
    let id = find(this.store.state.tabs);
    if (id) {
      if (this.store.isCollapsed(id)) this.expandPane(id);
      else this.focusPane(id);
    } else {
      this.openLayout(
        {
          name: 'Containers',
          panes: [{ key: 'c', kind: 'containers', collapsed: false }],
          layout: { kind: 'pane', paneId: 'c' },
          focused: 'c',
        },
        'Containers',
      );
      id = find([this.store.active]);
    }
    const pane = id ? this.paneViews.get(id) : undefined;
    if (pane instanceof ContainersPane) for (const key of groupKeys) pane.expandGroup(key);
  }

  /** The repos' pins changed; Files panes refresh their pin buttons. */
  pinsChanged(): void {
    for (const pane of this.paneViews.values()) if (pane instanceof FilesPane) pane.pinsChanged();
  }

  setActivity(list: PtyActivity[]): void {
    const { next, changed } = applyActivity(this.sweeps, list, Date.now());
    this.sweeps = next;
    if (!changed) return;
    for (const id of this.paneViews.keys()) this.refreshStrip(id);
    this.notify();
  }

  moveFocus(direction: Direction): void {
    if (!this.store.tree) return;
    // Design 4.2: the zoom ends first, then focus moves as usual.
    if (this.zoomedId !== null) {
      this.zoom.end(this.store.activeId);
      this.render();
    }
    const id = neighbor(this.store.tree, this.store.focusedId, direction, this.containerRect());
    if (!id) return;
    this.setFocused(id);
    this.paneViews.get(id)?.focus();
  }

  resizePane(direction: Direction): void {
    const cell = this.layoutCell();
    if (!this.store.tree || !cell || this.zoomedId !== null) return;
    const next = resizePane(this.store.tree, this.store.focusedId, direction, this.containerRect(), cell);
    if (next === this.store.tree) return;
    this.store.tree = next;
    this.render();
  }

  /** Every bound workspace action is swallowed, even with no effect, so it never leaks to bash. */
  private dispatch(action: Action): boolean {
    switch (action.type) {
      case 'splitRight':
        this.split('row');
        return true;
      case 'splitDown':
        this.split('column');
        return true;
      case 'splitAuto':
        this.split('auto');
        return true;
      case 'closePane': {
        // Disposing the pane from inside its own key handler leaves xterm mid-event.
        const id = this.store.focusedId;
        queueMicrotask(() => void this.requestClosePane(id));
        return true;
      }
      case 'collapsePane': {
        // Detaching the host from inside its own key handler leaves xterm mid-event.
        const id = this.store.focusedId;
        queueMicrotask(() => this.collapsePane(id));
        return true;
      }
      case 'togglePaneZoom':
        // Rendering detaches hosts, which leaves xterm mid-event inside its own key handler.
        queueMicrotask(() => this.toggleZoom());
        return true;
      case 'moveFocus':
        this.moveFocus(action.direction);
        return true;
      case 'resizePane':
        this.resizePane(action.direction);
        return true;
      case 'cycleScrim':
        this.scrim = nextScrim(this.scrim, this.config.settings.scrim.blurPx);
        applyScrim(document.documentElement, this.scrim);
        saveSetting(['scrim', 'opacity'], this.scrim.opacity).catch((err: unknown) =>
          showToast(`Could not save the scrim setting: ${String(err)}`),
        );
        return true;
      case 'increaseFontSize':
        this.setFontSize(stepFontSize(this.fontSize, 1));
        return true;
      case 'decreaseFontSize':
        this.setFontSize(stepFontSize(this.fontSize, -1));
        return true;
      case 'resetFontSize':
        this.setFontSize(DEFAULT_FONT_SIZE);
        return true;
      case 'toggleDashboard':
        this.hooks.onToggleDashboard?.();
        return true;
      case 'focusDashboard':
        this.hooks.onFocusDashboard?.();
        return true;
      case 'openFavorite':
        this.hooks.onOpenFavoritePicker?.();
        return true;
      case 'openLayout':
        this.hooks.onOpenLayoutPicker?.();
        return true;
      case 'splitWithProfile':
        this.hooks.onOpenProfilePicker?.();
        return true;
      case 'showHelp':
        this.hooks.onShowHelp?.();
        return true;
      case 'openSettings':
        this.hooks.onOpenSettings?.();
        return true;
      case 'toggleBackdrop':
        this.hooks.onToggleBackdrop?.();
        return true;
      case 'toggleFullscreen':
        this.hooks.onToggleFullscreen?.();
        return true;
      case 'newTab':
        // Detaching the focused host from inside its own key handler leaves xterm mid-event.
        queueMicrotask(() => this.newTab());
        return true;
      case 'newScratch':
        // Re-rendering from inside the focused pane's key handler leaves xterm mid-event.
        queueMicrotask(() => this.openPane({ kind: 'scratch' }));
        return true;
      case 'openFiles':
        queueMicrotask(() => void this.openFilesForFocused());
        return true;
      case 'openGit':
        queueMicrotask(() => void this.openGitForFocused());
        return true;
      case 'openSearch': {
        // Read now: the selection can be gone by the time a queued task runs.
        const query = initialQuery(this.terminal(this.store.focusedId)?.selection() ?? '');
        queueMicrotask(() => void this.openSearchForFocused(query));
        return true;
      }
      case 'nextTab':
      case 'prevTab': {
        const id = nextTab(this.store.state, action.type === 'nextTab' ? 1 : -1).activeId;
        queueMicrotask(() => this.switchTab(id));
        return true;
      }
      case 'switchToTab':
      case 'switchToLastTab': {
        const tab = tabAt(this.store.state, action.type === 'switchToTab' ? action.index : 9);
        if (tab) queueMicrotask(() => this.switchTab(tab.id));
        return true;
      }
      case 'closeTab': {
        const id = this.store.activeId;
        queueMicrotask(() => void this.requestCloseTab(id));
        return true;
      }
      case 'find': {
        const pane = this.terminal(this.store.focusedId);
        const host = this.hosts.get(this.store.focusedId);
        if (pane && host) this.findBar.open(pane, host);
        return true;
      }
      default:
        return false;
    }
  }

  /** With no expanded pane nothing holds focus, so workspace keys arrive here instead. */
  private onEmptyLayoutKey(e: KeyboardEvent): void {
    if (this.store.tree || e.defaultPrevented || this.overlay.isActive()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (!this.runKey(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  /** Runs the workspace action bound to a key pressed outside any pane; true when one ran. */
  runKey(e: KeyboardEvent): boolean {
    const action = lookup(this.config.keymap, e);
    return action !== null && this.dispatch(action);
  }

  private onDrop(target: DropTarget | null): void {
    const source = this.drag;
    this.drag = null;
    if (!source) return;
    if (target && 'tabId' in target) {
      if (source.kind === 'pane') this.moveToTab(source.paneId, target.tabId);
    } else if (source.kind === 'pane') {
      this.dock(source.paneId, target);
    } else if (target) {
      this.openTerminal(source.path, { dock: target });
    } else {
      this.openTerminal(source.path);
    }
  }

  /** Attaches and sizes the host via render before the pane builds in it, since start() fits to it. */
  private mount(id: string, tree: Layout, spec: PaneSpec): void {
    const host = this.createHost(id);
    this.store.addToActive(id, false);
    this.store.tree = tree;
    this.store.focusedId = id;
    this.render();
    const pane = this.buildPane(id, host, spec, true);
    pane.focus();
    this.notify();
    this.startPane(id, pane);
  }

  private openCollapsed(id: string, spec: PaneSpec): void {
    this.store.addToActive(id, true);
    this.openOffscreen(id, spec);
    this.notify();
  }

  // xterm measures its cell size when it opens, so a terminal that is not on screen (collapsed,
  // or in a background tab) opens in a hidden sizer and is detached right after. Its pty spawns
  // at xterm's default size and is refit when it is shown. Other kinds need no measuring.
  private openOffscreen(id: string, spec: PaneSpec, onReady?: () => void): void {
    const host = this.createHost(id);
    if (spec.kind === 'terminal') this.getSizer().append(host);
    const pane = this.buildPane(id, host, spec, false, onReady);
    host.remove();
    this.startPane(id, pane);
  }

  /** Builds a saved tab's panes; for a visible tab the caller has already attached the expanded hosts. */
  private buildTab(
    saved: SavedTab,
    ids: Map<string, string>,
    visible: boolean,
    opts: { resumeClaude: boolean; loadScratch: boolean },
  ): void {
    for (const p of saved.panes) {
      const id = ids.get(p.key)!;
      let onReady: (() => void) | undefined;
      if (p.kind === 'terminal' && p.sessionId) {
        const sessionId = p.sessionId;
        this.restoredSessions.set(id, sessionId);
        if (opts.resumeClaude) onReady = () => this.terminal(id)?.typeText(`claude --resume ${sessionId}\r`);
      }
      const spec = this.restoredSpec(p, opts.loadScratch);
      if (visible && !p.collapsed) {
        this.startPane(id, this.buildPane(id, this.hosts.get(id)!, spec, true, onReady));
      } else {
        this.openOffscreen(id, spec, onReady);
      }
    }
  }

  /** A pad keeps its saved file only when restoring the workspace; layouts and missing ids open fresh. */
  private restoredSpec(p: SavedPane, loadScratch: boolean): PaneSpec {
    switch (p.kind) {
      case 'terminal':
        // An empty cwd lets the core fall back to startingDirectory.
        return { kind: 'terminal', cwd: p.cwd || undefined, profile: p.profile };
      case 'scratch':
        if (loadScratch && p.scratchId) return { kind: 'scratch', scratchId: p.scratchId, text: scratchLoad(p.scratchId) };
        return { kind: 'scratch' };
      case 'files':
        return { kind: 'files', folder: p.folder, selected: p.selected, root: p.root };
      case 'git':
        return { kind: 'git', root: p.root };
      case 'search':
        return { kind: 'search', root: p.root, query: p.query, options: p.options };
      case 'containers':
        return { kind: 'containers' };
    }
  }

  /**
   * Design 4.11 Kind menu: a pane with no folder becoming a terminal opens where the tab's most
   * recent terminal is, else in the core's startingDirectory, with the default profile; becoming
   * a Files or Git pane, it falls back last to the Repo section's repo.
   */
  private specForKind(kind: PaneKind, folder: string | null, tab: TabState): PaneSpec {
    switch (kind) {
      case 'terminal':
        return { kind: 'terminal', cwd: folder ?? this.recentTerminalCwd(tab) };
      case 'scratch':
        return { kind: 'scratch' };
      case 'files':
        return { kind: 'files', folder: folder ?? this.recentTerminalCwd(tab) ?? this.hooks.getRepoFolder?.() ?? '' };
      case 'git':
        return { kind: 'git', root: folder ?? this.recentTerminalCwd(tab) ?? this.hooks.getRepoFolder?.() ?? '' };
      case 'search':
        return { kind: 'search', root: folder ?? this.recentTerminalCwd(tab) ?? this.hooks.getRepoFolder?.() ?? '' };
      case 'containers':
        return { kind: 'containers' };
    }
  }

  private createHost(id: string): HTMLElement {
    const host = document.createElement('div');
    host.className = 'pane';
    this.hosts.set(id, host);
    return host;
  }

  /** The strip goes in first so it sits ahead of the body the pane builds into. */
  private buildPane(id: string, host: HTMLElement, spec: PaneSpec, expanded: boolean, onReady?: () => void): PaneView {
    const strip = new TitleStrip(
      {
        onCollapse: () => this.collapsePane(id),
        onClose: () => void this.requestClosePane(id),
        onZoom: () => {
          this.focusPane(id);
          this.toggleZoom();
        },
        onChooseKind: (kind) => void this.replaceKind(id, kind),
        onDragStart: (e) => this.startDrag({ kind: 'pane', paneId: id }, e),
      },
      spec.kind,
    );
    host.prepend(strip.el);
    this.strips.set(id, strip);
    let pane: PaneView;
    switch (spec.kind) {
      case 'terminal':
        pane = this.createTerminal(id, host, spec, expanded, onReady);
        break;
      case 'scratch':
        pane = this.createScratch(id, host, spec);
        break;
      case 'files':
        pane = this.createFiles(id, host, spec);
        break;
      case 'git':
        pane = this.createGit(id, host, spec, expanded);
        break;
      case 'search':
        pane = this.createSearch(id, host, spec, expanded);
        break;
      case 'containers':
        pane = this.createContainers(id, host, expanded);
        break;
    }
    this.paneViews.set(id, pane);
    this.openedAt.set(id, Date.now());
    this.refreshStrip(id);
    return pane;
  }

  private createTerminal(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'terminal' }>,
    expanded: boolean,
    onReady?: () => void,
  ): TerminalPane {
    if (spec.container) this.containerShells.set(id, spec.container.name);
    return new TerminalPane({
      host,
      paneId: id,
      settings: this.paneSettings(),
      cwd: spec.cwd,
      profile: spec.profile,
      command: spec.command,
      expanded,
      keyHandler: (e, term, send) =>
        handleKey(e, { keymap: () => this.config.keymap, term, send, dispatch: (a) => this.dispatch(a) }),
      onFocus: () => this.setFocused(id),
      onExit: (code) => {
        // Matches Windows Terminal: a clean exit closes the pane, a failure stays readable.
        if (code === 0) this.closePane(id);
        else this.paneChanged(id);
      },
      onCwdChange: () => this.paneChanged(id),
      onShellChange: () => this.paneChanged(id),
      onBell: () => {
        if (this.attention.bell(id)) this.notify();
      },
      onReady,
    });
  }

  private createScratch(id: string, host: HTMLElement, spec: Extract<PaneSpec, { kind: 'scratch' }>): ScratchPane {
    const pad = new ScratchPane({
      host,
      paneId: id,
      scratchId: spec.scratchId ?? newScratchId(),
      settings: this.paneSettings(),
      text: spec.text,
      keymap: () => this.config.keymap,
      dispatch: (a) => this.dispatch(a),
      onFocus: () => this.setFocused(id),
      onChange: () => this.paneChanged(id),
      onSend: (text) => this.send(id, text),
      save: scratchSave,
      saveAs: scratchSaveAs,
    });
    // The pad fills itself first, so its title is current by the time this runs.
    if (spec.text instanceof Promise) spec.text.then(() => this.paneChanged(id), () => {});
    return pad;
  }

  private createSearch(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'search' }>,
    expanded: boolean,
  ): SearchPane {
    return new SearchPane({
      host,
      paneId: id,
      settings: this.paneSettings(),
      root: spec.root,
      query: spec.query ?? '',
      options: spec.options ?? DEFAULT_SEARCH_OPTIONS,
      expanded,
      keymap: () => this.config.keymap,
      dispatch: (a) => this.dispatch(a),
      onFocus: () => this.setFocused(id),
      onChange: () => this.paneChanged(id),
    });
  }

  private createGit(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'git' }>,
    expanded: boolean,
  ): GitPane {
    return new GitPane({
      host,
      paneId: id,
      settings: this.paneSettings(),
      root: spec.root,
      expanded,
      keymap: () => this.config.keymap,
      dispatch: (a) => this.dispatch(a),
      onFocus: () => this.setFocused(id),
      onChange: () => this.paneChanged(id),
      confirm: (o) => this.hooks.onConfirm?.(o) ?? Promise.resolve(false),
    });
  }

  private createContainers(id: string, host: HTMLElement, expanded: boolean): ContainersPane {
    return new ContainersPane({
      host,
      paneId: id,
      settings: this.paneSettings(),
      expanded,
      keymap: () => this.config.keymap,
      dispatch: (a) => this.dispatch(a),
      onFocus: () => this.setFocused(id),
      // Without a store from the app (a browser-only run) the pane shows no engines.
      store: this.hooks.containers ?? (this.emptyContainers ??= new ContainersStore()),
      onShell: (c) => this.openContainerShell(id, c),
    });
  }

  /** Design 4.16: a shell inside the container, split off its Containers pane. */
  private openContainerShell(containersPaneId: string, container: Container): void {
    if (!this.store.isCollapsed(containersPaneId)) this.focusPane(containersPaneId);
    this.openPane({ kind: 'terminal', command: shellCommand(container), container: { name: container.name } });
  }

  private createFiles(id: string, host: HTMLElement, spec: Extract<PaneSpec, { kind: 'files' }>): FilesPane {
    // The pane asks for its pins while it is still being constructed.
    let pane: FilesPane | undefined;
    const root = () => pane?.root() ?? spec.root ?? spec.folder;
    pane = new FilesPane({
      host,
      paneId: id,
      settings: this.paneSettings(),
      folder: spec.folder,
      selected: spec.selected,
      root: spec.root,
      keymap: () => this.config.keymap,
      dispatch: (a) => this.dispatch(a),
      onFocus: () => this.setFocused(id),
      onChange: () => this.paneChanged(id),
      onOpenTerminalHere: (folder) => {
        this.focusPane(id);
        this.openTerminal(folder);
      },
      onInsertPath: (text) => {
        const tab = this.store.tabOf(id);
        if (!tab || !this.pasteIntoTab(tab, text)) showToast('No terminal in this tab to insert the path into');
      },
      onPin: (absolute, isDir) => this.hooks.onPin?.(root(), absolute, isDir),
      onUnpin: (absolute) => this.hooks.onUnpin?.(root(), absolute),
      getPinnedFolders: () => this.hooks.getPinnedFolders?.(root()) ?? [],
    });
    return pane;
  }

  /** Ctrl+Shift+E: a Files pane at the root of the focused pane's repo. */
  private async openFilesForFocused(): Promise<void> {
    const folder = this.folderForNew();
    if (!folder) {
      showToast('No folder to open');
      return;
    }
    try {
      const { root } = await repoRoot(folder);
      this.showFiles({ root, folder: root });
    } catch (err) {
      showToast(`Could not open ${folder}: ${String(err)}`);
    }
  }

  /** Ctrl+Shift+G: a Git pane for the focused pane's repo (design 4.11, 4.13). */
  private async openGitForFocused(): Promise<void> {
    const folder = this.folderForNew() ?? this.hooks.getRepoFolder?.() ?? undefined;
    if (!folder) {
      showToast('No folder to open');
      return;
    }
    try {
      const { root, isGit } = await repoRoot(folder);
      if (!isGit) {
        showToast(`${folder} is not in a git repo`);
        return;
      }
      this.showGit(root);
    } catch (err) {
      showToast(`Could not open ${folder}: ${String(err)}`);
    }
  }

  /** Ctrl+Shift+H: a Search pane for the focused pane's repo, or its folder outside any repo (design 4.14). */
  private async openSearchForFocused(query: string): Promise<void> {
    const folder = this.folderForNew() ?? this.hooks.getRepoFolder?.() ?? undefined;
    if (!folder) {
      showToast('No folder to open');
      return;
    }
    try {
      const { root } = await repoRoot(folder);
      this.showSearch(root, query);
    } catch (err) {
      showToast(`Could not open ${folder}: ${String(err)}`);
    }
  }

  private startPane(id: string, pane: PaneView): void {
    if (!(pane instanceof TerminalPane)) return;
    pane.start().then(() => this.paneChanged(id)).catch((err: unknown) => {
      const msg = `Could not start the shell: ${String(err)}`;
      pane.notice(`[${msg}]`);
      showToast(msg);
    });
  }

  /**
   * Design 4.15 Send: pastes into the tab's most recently focused terminal, then focuses it, or
   * expands it when it is collapsed.
   */
  private send(padId: string, text: string): void {
    const tab = this.store.tabOf(padId);
    if (tab) this.pasteIntoTab(tab, text);
  }

  /** Bracketed paste into the tab's most recently focused terminal, then shows it; false with none. */
  private pasteIntoTab(tab: TabState, text: string): boolean {
    const targetId = recentTerminal(this.focusOrder, tab.panes, (id) => this.terminal(id) !== undefined);
    const target = targetId ? this.terminal(targetId) : undefined;
    if (!targetId || !target) return false;
    target.pasteText(text);
    if (this.store.isCollapsed(targetId)) this.expandPane(targetId);
    else this.focusPane(targetId);
    return true;
  }

  private getSizer(): HTMLElement {
    if (!this.sizer) {
      this.sizer = document.createElement('div');
      this.sizer.className = 'pane-sizer';
      document.body.append(this.sizer);
    }
    const r = this.root.getBoundingClientRect();
    this.sizer.style.width = `${r.width}px`;
    this.sizer.style.height = `${r.height}px`;
    return this.sizer;
  }

  /** Drops WebGL and leaves the host to be detached by the next render. */
  private markCollapsed(id: string): void {
    this.store.setCollapsed(id, true);
    if (this.findBar.isOpenOn(this.terminal(id))) this.findBar.close(false);
    this.hosts.get(id)?.classList.remove('focused');
    this.paneViews.get(id)?.setExpanded(false);
  }

  private paneChanged(id: string): void {
    this.refreshStrip(id);
    this.notify();
  }

  private terminal(id: string): TerminalPane | undefined {
    const pane = this.paneViews.get(id);
    return pane instanceof TerminalPane ? pane : undefined;
  }

  private scratch(id: string): ScratchPane | undefined {
    const pane = this.paneViews.get(id);
    return pane instanceof ScratchPane ? pane : undefined;
  }

  private paneInput(tab: TabState, paneId: string): PaneCardInput | null {
    const pane = this.paneViews.get(paneId);
    if (!pane) return null;
    const common = {
      paneId,
      tabId: tab.id,
      focused: paneId === this.store.focusedId,
      openedAt: this.openedAt.get(paneId) ?? 0,
      collapsed: tab.collapsed.includes(paneId),
    };
    if (pane instanceof TerminalPane) {
      return {
        ...common,
        kind: 'terminal',
        ptyId: pane.ptyId,
        cwd: pane.cwd,
        profile: pane.profile ?? this.config.settings.shell.defaultProfile,
        shell: this.shellOf(paneId, pane),
        attention: this.attention.has(paneId),
        done: this.statusOf(paneId) === 'done',
        ...(this.containerShells.has(paneId) && { containerName: this.containerShells.get(paneId) }),
      };
    }
    if (pane instanceof ScratchPane) {
      return { ...common, kind: 'scratch', title: pane.title(), folder: null, confirmClose: !pane.isEmpty() };
    }
    if (pane instanceof FilesPane) {
      return { ...common, kind: 'files', title: pane.title(), folder: pane.folder, root: pane.root(), confirmClose: false };
    }
    if (pane instanceof GitPane) {
      return { ...common, kind: 'git', title: pane.title(), folder: pane.root(), confirmClose: false };
    }
    if (pane instanceof SearchPane) {
      return { ...common, kind: 'search', title: pane.title(), folder: pane.root(), confirmClose: false };
    }
    if (pane instanceof ContainersPane) {
      return { ...common, kind: 'containers', title: pane.title(), folder: null, confirmClose: false };
    }
    return null;
  }

  private losesWork(p: PaneCardInput): boolean {
    return p.kind === 'terminal' ? isBusy(p, this.sessions) : p.confirmClose;
  }

  /** The focused pane's folder, else that of the active tab's most recent terminal. */
  private folderForNew(): string | undefined {
    return this.paneViews.get(this.store.focusedId)?.folder ?? this.recentTerminalCwd(this.store.active);
  }

  private recentTerminalCwd(tab: TabState): string | undefined {
    const id = recentTerminal(this.focusOrder, tab.panes, (p) => this.terminal(p) !== undefined);
    return (id && this.terminal(id)?.cwd) || undefined;
  }

  private paneSettings(): Settings {
    const settings = this.config.settings;
    return settings.font.size === this.fontSize ? settings : { ...settings, font: { ...settings.font, size: this.fontSize } };
  }

  private shellOf(id: string, pane: TerminalPane): ShellStatus {
    const sweep = pane.ptyId === null ? null : (this.sweeps.get(pane.ptyId) ?? null);
    return shellStatus(pane.oscState(), sweep, this.openedAt.get(id) ?? 0);
  }

  private statusOf(id: string): TerminalStatus {
    const pane = this.terminal(id);
    if (!pane) return 'idle';
    const session = boundSession(pane.ptyId, this.sessions);
    return this.done.resolve(id, session, terminalStatus(session, this.shellOf(id, pane))).status;
  }

  /** Design 4.11: a tab's name follows this, so a pad's first line names its tab. */
  private titleOf(id: string): string {
    const pane = this.paneViews.get(id);
    if (
      pane instanceof ScratchPane ||
      pane instanceof FilesPane ||
      pane instanceof GitPane ||
      pane instanceof SearchPane ||
      pane instanceof ContainersPane
    ) {
      return pane.title();
    }
    if (!(pane instanceof TerminalPane)) return '~';
    const container = this.containerShells.get(id);
    if (container !== undefined) return container;
    const session = boundSession(pane.ptyId, this.sessions);
    return session?.name || (pane.cwd ? lastFolder(pane.cwd) : '') || '~';
  }

  /** Every status change passes through here, so it also feeds attention; true when raised. */
  private refreshStrip(id: string): boolean {
    const strip = this.strips.get(id);
    const pane = this.paneViews.get(id);
    if (!strip || !pane) return false;
    if (!(pane instanceof TerminalPane)) {
      strip.update({ title: this.titleOf(id), path: pane.folder ?? '' });
      return false;
    }
    const status = this.statusOf(id);
    strip.update({ title: this.titleOf(id), path: this.containerShells.get(id) ?? pane.cwd ?? '', status });
    return this.attention.observe(id, status);
  }

  /**
   * The focused pane's cell size for layout checks. A lone pane's strip overlays its body, but
   * any change that leaves two panes puts strips in the flow, so their height is counted.
   */
  private layoutCell(): CellSize | null {
    const pane = this.paneViews.get(this.store.focusedId);
    if (!pane) return null;
    const cell = pane.cellSize();
    if (!this.root.classList.contains('multi')) {
      cell.padY = (cell.padY ?? 0) + (this.strips.get(this.store.focusedId)?.el.offsetHeight ?? 0);
    }
    return cell;
  }

  private paneRects(): Map<string, DOMRect> {
    const out = new Map<string, DOMRect>();
    if (!this.store.tree) return out;
    for (const id of this.zoomedId !== null ? [this.zoomedId] : leaves(this.store.tree)) {
      const host = this.hosts.get(id);
      if (host) out.set(id, host.getBoundingClientRect());
    }
    return out;
  }

  /** Click focus lands here; it must not re-render, since moving hosts blurs the textarea. */
  private setFocused(id: string): void {
    if (!this.store.active.panes.includes(id)) return;
    const changed = this.store.focusedId !== id;
    this.store.focusedId = id;
    for (const [hid, host] of this.hosts) host.classList.toggle('focused', hid === id);
    if (changed) {
      this.syncFindBar();
      this.notify();
    }
  }

  /**
   * Every focus, expand, dock, open, and close change notifies, so the newly seen pane's
   * attention clears, the focus order advances, and pads learn whether their tab can take a Send.
   */
  private notify(): void {
    this.attention.clearIfSeen(this.store.focusedId);
    this.clearDoneIfSeen();
    this.syncZoomButtons();
    if (this.store.focusedId) this.focusOrder = touch(this.focusOrder, this.store.focusedId);
    for (const [id, pane] of this.paneViews) {
      if (!(pane instanceof ScratchPane)) continue;
      const tab = this.store.tabOf(id);
      pane.setCanSend(tab !== null && tab.panes.some((p) => this.terminal(p) !== undefined));
    }
    for (const cb of [...this.listeners]) cb();
  }

  /** The pane being looked at (design 4.7): focused, expanded, in the active tab, in a focused window. */
  private isSeen(id: string): boolean {
    return id === this.store.focusedId && !this.store.isCollapsed(id) && document.hasFocus();
  }

  /** Design 4.8: `done` lasts until the terminal is the one being looked at. */
  private clearDoneIfSeen(): boolean {
    const id = this.store.focusedId;
    if (!this.isSeen(id) || !this.done.clear(id)) return false;
    this.refreshStrip(id);
    return true;
  }

  /** Re-rendering moves hosts and blurs the focused pane, so focus is restored after. */
  private render(): void {
    const tree = this.store.tree;
    const tabId = this.store.activeId;
    // Keyed on the real tree, so a zoomed pane keeps its strip in the flow and layoutCell counts it.
    // Toggled before the hosts move so panes refit once, against the final strip placement.
    this.root.classList.toggle('multi', tree !== null && tree.kind === 'split');
    this.syncFindBar();
    const zoomed = this.zoom.zoomed(tabId, tree, this.store.focusedId);
    this.zoomedId = zoomed;
    const hidden = this.zoomHidden.get(tabId);
    if (!tree) {
      this.zoomHidden.delete(tabId);
      this.root.replaceChildren();
      return;
    }
    if (zoomed !== null) {
      this.view.render({ kind: 'pane', paneId: zoomed }, this.hosts, this.store.focusedId);
      const set = hidden ?? new Set<string>();
      for (const id of leaves(tree)) {
        if (id === zoomed || set.has(id)) continue;
        set.add(id);
        this.paneViews.get(id)?.setExpanded(false);
      }
      this.zoomHidden.set(tabId, set);
    } else {
      this.view.render(tree, this.hosts, this.store.focusedId);
      // After render, so the hosts are attached when WebGL loads and the refit runs.
      if (hidden) {
        this.zoomHidden.delete(tabId);
        const onScreen = leaves(tree);
        for (const id of hidden) if (onScreen.includes(id)) this.paneViews.get(id)?.setExpanded(true);
      }
    }
    this.syncZoomButtons();
    if (!this.findBar.isOpen()) this.paneViews.get(this.store.focusedId)?.focus();
  }

  /** Design 4.2 Zoom: toggles the active tab's zoom on its focused pane. */
  private toggleZoom(): void {
    const { activeId, tree, focusedId } = this.store;
    // An entry a tree or focus change already invalidated shows as zoomed until the next render.
    const stale = this.zoomedId !== null && this.zoom.zoomed(activeId, tree, focusedId) === null;
    if (!stale && !this.zoom.toggle(activeId, tree, focusedId)) return;
    this.render();
    this.notify();
  }

  /** The zoom button pulses while a pane its zoom hides has attention (design 4.2). */
  private syncZoomButtons(): void {
    const tree = this.store.tree;
    if (!tree) return;
    const ids = leaves(tree);
    const z = this.zoomedId;
    const hiddenAttention = z !== null && ids.some((o) => o !== z && this.attention.has(o));
    for (const id of ids) {
      this.strips.get(id)?.setZoom({
        available: tree.kind === 'split',
        zoomed: id === z,
        attention: id === z && hiddenAttention,
      });
    }
  }

  /** The find bar only lives on the focused pane; it closes when that pane closes or loses focus. */
  private syncFindBar(): void {
    if (!this.findBar.isOpenOn(this.terminal(this.store.focusedId))) this.findBar.close(false);
  }

  private containerRect(): Rect {
    const r = this.root.getBoundingClientRect();
    return { x: 0, y: 0, width: r.width, height: r.height };
  }

  private takeId(): string {
    return `p${this.nextId++}`;
  }

  private takeIdFor(kind: PaneKind): string {
    return kind === 'terminal' ? this.takeId() : `v${this.nextViewId++}`;
  }

  /** The outgoing tab's panes leave the DOM at the next render, releasing WebGL as collapsing does. */
  private hideTab(tab: TabState): void {
    this.findBar.close(false);
    if (!tab.tree) return;
    for (const id of leaves(tab.tree)) this.paneViews.get(id)?.setExpanded(false);
  }

  /** Renders the active tab, then takes WebGL and refits once its hosts are attached. */
  private showActive(): void {
    this.render();
    if (this.store.tree) {
      const onScreen = this.zoomedId !== null ? [this.zoomedId] : leaves(this.store.tree);
      for (const id of onScreen) this.paneViews.get(id)?.setExpanded(true);
    }
    this.paneViews.get(this.store.focusedId)?.focus();
  }

  /** Disposes the pane and drops its per-pane state, deleting a pad's file; the caller updates the tabs. */
  private forgetPane(id: string): void {
    const pane = this.paneViews.get(id);
    this.restoredSessions.delete(id);
    this.containerShells.delete(id);
    this.hosts.delete(id);
    this.strips.delete(id);
    this.openedAt.delete(id);
    this.attention.forget(id);
    this.done.forget(id);
    this.focusOrder = forget(this.focusOrder, id);
    this.paneViews.delete(id);
    // The save starts before dispose, so pending editor text still reaches the disk.
    if (pane instanceof FilesPane) void pane.flush();
    if (pane instanceof ScratchPane) {
      const { scratchId } = pane;
      pane
        .cancelSave()
        .then(() => scratchDelete(scratchId))
        .catch((e: unknown) => console.warn('scratch delete failed:', e));
    }
    pane?.dispose();
  }

  /** Leaves an empty workspace behind, so the save on close starts the next launch fresh. */
  private closeWindow(): void {
    this.store.reset();
    void invoke('close_window');
  }
}
