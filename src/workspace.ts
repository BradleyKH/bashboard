import { invoke } from '@tauri-apps/api/core';
import { applyAccent } from './accent';
import { applyTextScale, applyUiScale } from './uiScale';
import { applyScheme, resolveScheme } from './code/schemes';
import { applyContentText, contentTextColor } from './contentText';
import { nextAttention as nextAttentionId, type AttentionEntry } from './attentionQueue';
import type { PaneCardInput } from './dashboardModel';
import { FilesPane } from './filesPane';
import { pinTarget, type FilesRequest } from './filesRouting';
import { applyDock, expandInto, focusAfterRemoval, type DockTarget, type DragSource } from './docking';
import { FindBar } from './findBar';
import type { ShipTab } from './shipModel';
import type { ProviderKind } from './forgeApi';
import { GitPane } from './gitPane';
import { forget, recentTerminal, touch } from './focusHistory';
import { lookup, type Action } from './keymap';
import { autoDir, close, computeRects, findPath, insertAtEdge, neighbor, resizePane } from './layout';
import type { CellSize, Direction, Layout, Rect } from './layout';
import { LiveSettings } from './liveSettings';
import { TerminalPane } from './pane';
import { PaneAttention } from './paneAttention';
import { PaneLights } from './paneLights';
import { PaneDrag, type PaneDragContext } from './paneDrag';
import { PaneFactory, type PaneFactoryContext } from './paneFactory';
import { knownForgeSources as forgeSourcesOf } from './paneInfo';
import * as routing from './paneRouting';
import { specForKind } from './paneSpecModel';
import { PathDrop, type PathDropContext } from './pathDrop';
import type { PathDrag } from './pathDragLayer';
import type { PaneKind } from './paneKinds';
import type { PaneView } from './paneView';
import { scratchDelete, type PtyActivity } from './persistence';
import type { SavedTab, SavedWorkspace } from './savedWorkspace';
import type { SearchOptions } from './searchOptions';
import { SearchPane } from './searchPane';
import { ScratchPane } from './scratchPane';
import { applyScrim, nextScrim, scrimFromSettings, type ScrimState } from './scrim';
import type { HookEvent, Session } from './sessions';
import { saveSetting, type Settings, type SettingsPayload } from './settings';
import { PaneStatus, type PaneStatusContext } from './paneStatus';
import { TabStore } from './tabStore';
import { TabView, type TabViewContext } from './tabView';
import { addTab, closeTab as closeTabState, renameTab as renameTabState, type TabState } from './tabs';
import { reorderTab as reorderTabState, switchTab as switchTabState } from './tabs';
import { showToast } from './toast';
import { dispatchAction, type DispatchContext } from './workspaceDispatch';
import * as persistence from './workspacePersistence';
import { WorkspaceSessions } from './workspaceSessions';
import type { Edge, LaunchTarget, OpenPaneOptions, OpenTerminalOptions, PaneSpec } from './workspaceTypes';
import type { TabInfo, TerminalInfo, WorkspaceHooks } from './workspaceTypes';
import { supports } from './platform';

export type { DragSource };
export type { LaunchTarget, OpenPaneOptions, OpenTerminalOptions, PaneSpec, TabInfo, TerminalInfo, WorkspaceHooks };

/** Every narrow view of the workspace its helper modules act through, built once by `context`. */
type WorkspaceContext = PaneFactoryContext &
  PathDropContext &
  routing.PaneRoutingContext &
  DispatchContext &
  persistence.PersistenceContext &
  PaneDragContext &
  TabViewContext &
  PaneStatusContext;

/**
 * Owns the tabs, each with its own split tree, focus, and collapsed panes, plus every pane of
 * every kind and the scrim state (docs/design/workspace.md sections 4.2, 4.3, 4.10, 4.11).
 * Everything that acts on "the" tree or focus acts on the active tab. A tab's `focusedId` is always
 * an expanded pane, or '' when none is.
 */
export class Workspace {
  private readonly store = new TabStore();
  private readonly paneViews = new Map<string, PaneView>();
  private readonly hosts = new Map<string, HTMLElement>();
  /** Terminals take `p<n>`, every other kind `v<n>`, so saved keys never collide across kinds. */
  private nextId = 1;
  private nextViewId = 1;
  private readonly config: LiveSettings;
  private readonly ctx: WorkspaceContext;
  private readonly factory: PaneFactory;
  private readonly pathDrop: PathDrop;
  private readonly paneDrag: PaneDrag;
  private readonly tabView: TabView;
  private readonly status: PaneStatus;
  private scrim: ScrimState;
  /** Tracked locally so quick repeats don't act on a size the file watcher hasn't reported back yet. */
  private fontSize: number;
  private readonly listeners = new Set<() => void>();
  private readonly sessions = new WorkspaceSessions();
  /** Container shell pane ids to their container's name. */
  private readonly containerShells = new Map<string, string>();
  private readonly attention: PaneAttention;
  private readonly lights: PaneLights;
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
    applyAccent(document.documentElement, payload.settings.accentColor);
    applyContentText(document.documentElement, contentTextColor(payload.settings.contentTextColor, payload.settings.accentColor));
    applyScheme(document.documentElement, resolveScheme(payload.settings.codeColors.scheme, payload.settings.accentColor));
    applyUiScale(document.documentElement, payload.settings.uiScale);
    applyTextScale(document.documentElement, this.fontSize);
    this.ctx = this.context();
    this.status = new PaneStatus(this.ctx);
    this.tabView = new TabView(this.ctx);
    this.paneDrag = new PaneDrag(this.ctx);
    this.pathDrop = new PathDrop(this.ctx);
    this.factory = new PaneFactory(this.ctx);
    this.attention = new PaneAttention({
      isSeen: (id) => this.isSeen(id),
      host: (id) => this.hosts.get(id),
      onRaised: (id, cause) => this.hooks.onAttention?.(id, cause),
    });
    this.lights = new PaneLights(() => ({
      rects: this.tabView.paneRects(),
      attention: new Set([...this.hosts.keys()].filter((id) => this.attention.has(id))),
    }));
    this.lights.apply(payload.settings);
    window.addEventListener('focus', () => {
      const cleared = this.attention.clearIfSeen(this.store.focusedId);
      if (this.clearDoneIfSeen() || cleared) this.notify();
    });
    // Bubble phase, so inputs that stop propagation of their own keys (the favorites picker) win.
    window.addEventListener('keydown', (e) => this.onEmptyLayoutKey(e));
  }

  /** The one object the helper modules act through; each sees it only as its own narrow context. */
  private context(): WorkspaceContext {
    return {
      store: this.store,
      paneViews: this.paneViews,
      hosts: this.hosts,
      root: this.root,
      hooks: this.hooks,
      containerShells: this.containerShells,
      sessions: this.sessions,
      findBar: this.findBar,
      keymap: () => this.config.keymap,
      paneSettings: () => this.paneSettings(),
      defaultProfile: () => this.config.settings.shell.defaultProfile,
      focusOrder: () => this.focusOrder,
      isBound: (ptyId) => this.sessions.bound(ptyId) !== null,
      dispatch: (a) => this.dispatch(a),
      terminal: (id) => this.terminal(id),
      scratch: (id) => this.scratch(id),
      folderForNew: () => this.folderForNew(),
      fontSize: () => this.fontSize,
      setFontSize: (size) => this.setFontSize(size),
      cycleScrim: () => this.cycleScrim(),
      layoutCell: () => this.layoutCell(),
      paneRects: () => this.tabView.paneRects(),
      containerRect: () => this.containerRect(),
      takeId: () => this.takeId(),
      takeIdFor: (kind) => this.takeIdFor(kind),
      createHost: (id) => this.factory.createHost(id),
      render: () => this.tabView.render(),
      notify: () => this.notify(),
      mount: (id, tree, spec) => this.mount(id, tree, spec),
      buildPane: (id, host, spec, expanded, onReady) => this.factory.buildPane(id, host, spec, expanded, onReady),
      startPane: (id, pane) => this.factory.startPane(id, pane),
      openOffscreen: (id, spec, onReady) => this.factory.openOffscreen(id, spec, onReady),
      hideTab: (tab) => this.tabView.hideTab(tab),
      setFocused: (id) => this.setFocused(id),
      paneChanged: (id) => this.paneChanged(id),
      onCommand: (id, ev) =>
        this.sessions.onCommand(id, ev, this.isSeen(id), this.config.settings.terminal.doneAfterSeconds),
      onBell: (id) => {
        if (this.attention.bell(id)) this.notify();
      },
      onDragHover: (pos) => this.hooks.onDragHover?.(pos),
      focusPane: (id) => this.focusPane(id),
      expandPane: (id) => this.expandPane(id),
      collapsePane: (id) => this.collapsePane(id),
      closePane: (id) => this.closePane(id),
      requestClosePane: (id) => this.requestClosePane(id),
      requestCloseTab: (id) => this.requestCloseTab(id),
      toggleZoom: () => this.toggleZoom(),
      replaceKind: (id, kind) => this.replaceKind(id, kind),
      startDrag: (source, e) => this.startDrag(source, e),
      startPathDrag: (paths, e, move) => this.startPathDrag(paths, e, move),
      insertPathIntoTab: (id, paths, baseRoot) => this.pathDrop.insertPathIntoTab(id, paths, baseRoot),
      insertTextIntoTab: (id, text) => this.pathDrop.insertTextIntoTab(id, text),
      send: (padId, text) => this.pathDrop.send(padId, text),
      scratchSavedAs: (id, path) => this.scratchSavedAs(id, path),
      split: (side) => this.split(side),
      moveFocus: (direction) => this.moveFocus(direction),
      resizePane: (direction) => this.resizePane(direction),
      newTab: () => this.newTab(),
      switchTab: (id) => this.switchTab(id),
      nextAttention: () => this.nextAttention(),
      openPane: (spec, opts) => this.openPane(spec, opts),
      openTerminal: (cwd, opts) => this.openTerminal(cwd, opts),
      openLayout: (saved, name) => this.openLayout(saved, name),
      openLocalBrowser: (url, opts) => this.openLocalBrowser(url, opts),
      showFiles: (req, opts) => this.showFiles(req, opts),
      showGit: (root, opts) => this.showGit(root, opts),
      showSearch: (root, query, opts, options) => this.showSearch(root, query, opts, options),
      titleForPty: (ptyId) => this.titleForPty(ptyId),
      revealPty: (ptyId) => this.revealPty(ptyId),
      titleOf: (id) => this.status.title(id),
      markCollapsed: (id) => this.markCollapsed(id),
      showActive: () => this.tabView.showActive(),
      forgetZoom: (tabId) => this.tabView.forget(tabId),
      strip: (id) => this.status.strip(id),
      paneStatus: () => this.status,
      keep: (host) => this.tabView.keep(host),
      hasAttention: (id) => this.attention.has(id),
      observeAttention: (id, status) => this.attention.observe(id, status),
      syncFindBar: () => this.syncFindBar(),
    };
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
   * Design 4.11 Opening: a pane of any kind, alone in a new tab, collapsed, docked at a target,
   * or split from the focused pane; with no room it opens collapsed.
   */
  openPane(spec: PaneSpec, opts: OpenPaneOptions = {}): string | undefined {
    const id = this.takeIdFor(spec.kind);
    if (opts.tab) {
      const prev = this.store.active;
      this.store.state = addTab(this.store.state, this.store.emptyTab());
      this.tabView.hideTab(prev);
      this.mount(id, { kind: 'pane', paneId: id }, spec);
      return id;
    }
    if (opts.collapsed) {
      this.openCollapsed(id, spec);
      return id;
    }
    if (!this.store.tree) {
      this.mount(id, { kind: 'pane', paneId: id }, spec);
      return id;
    }
    const cell = this.layoutCell();
    if (!cell) return undefined;
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
      return id;
    }
    if (displaced) this.markCollapsed(displaced);
    this.mount(id, next, spec);
    return id;
  }

  applySettings(payload: SettingsPayload): void {
    this.config.update(payload);
    this.fontSize = this.config.settings.font.size;
    this.scrim = scrimFromSettings(this.config.settings.scrim);
    applyScrim(document.documentElement, this.scrim);
    applyAccent(document.documentElement, this.config.settings.accentColor);
    const { contentTextColor: mode, accentColor } = this.config.settings;
    applyContentText(document.documentElement, contentTextColor(mode, accentColor));
    applyScheme(document.documentElement, resolveScheme(this.config.settings.codeColors.scheme, accentColor));
    applyUiScale(document.documentElement, this.config.settings.uiScale);
    applyTextScale(document.documentElement, this.fontSize);
    for (const pane of this.paneViews.values()) pane.applySettings(this.config.settings);
    this.lights.apply(this.config.settings);
  }

  private setFontSize(size: number): void {
    if (size === this.fontSize) return;
    this.fontSize = size;
    applyTextScale(document.documentElement, size);
    const settings = this.paneSettings();
    for (const pane of this.paneViews.values()) pane.applySettings(settings);
    saveSetting(['font', 'size'], size).catch((err: unknown) =>
      showToast(`Could not save the text size: ${String(err)}`),
    );
  }

  /** Splits the focused pane, opening the new terminal on `side`. */
  split(side: Edge | 'auto'): void {
    const cell = this.layoutCell();
    if (!this.store.tree || !this.paneViews.has(this.store.focusedId) || !cell) return;
    const container = this.containerRect();
    let edge: Edge;
    if (side === 'auto') {
      const rect = computeRects(this.store.tree, container).get(this.store.focusedId);
      if (!rect) return;
      edge = autoDir(rect) === 'row' ? 'right' : 'bottom';
    } else {
      edge = side;
    }
    const id = `p${this.nextId}`;
    const next = insertAtEdge(this.store.tree, this.store.focusedId, id, edge, container, cell);
    if (next === this.store.tree) {
      showToast('Not enough room to split the pane');
      return;
    }
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
        const input = this.status.cardInput(tab, paneId);
        if (input) out.push(input);
      }
    }
    return out;
  }

  /** Panes that closing would lose work in: busy terminals and scratch pads with text. */
  busyPanes(tabId?: string): PaneCardInput[] {
    return this.panes().filter((p) => (tabId === undefined || p.tabId === tabId) && this.status.losesWork(p));
  }

  /** Tabs in strip order. */
  tabs(): TabInfo[] {
    return this.store.state.tabs.map((tab) => this.status.tabInfo(tab));
  }

  /**
   * Design 4.10: a tab with one default-profile terminal in `cwd`, or by default the focused
   * pane's folder.
   */
  newTab(cwd: string | undefined = this.folderForNew()): void {
    const prev = this.store.active;
    this.store.state = addTab(this.store.state, this.store.emptyTab());
    this.tabView.hideTab(prev);
    const id = this.takeId();
    this.mount(id, { kind: 'pane', paneId: id }, { kind: 'terminal', cwd });
  }

  switchTab(id: string): void {
    if (id === this.store.activeId || !this.store.state.tabs.some((t) => t.id === id)) return;
    const prev = this.store.active;
    this.store.state = switchTabState(this.store.state, id);
    this.tabView.hideTab(prev);
    this.tabView.showActive();
    this.notify();
    // A tab switched to mid-drag has different pane rects.
    this.paneDrag.refresh();
  }

  /**
   * Goes to the next terminal that needs the user, in any tab. A hidden pane of a zoomed tab
   * needs no explicit unzoom: focusing it changes the tab's focused pane, which drops the zoom.
   */
  nextAttention(): void {
    const entries: AttentionEntry[] = [];
    for (const tab of this.store.state.tabs) {
      for (const paneId of tab.panes) {
        if (!this.terminal(paneId)) continue;
        entries.push({ paneId, tabId: tab.id, ...this.status.resolved(paneId) });
      }
    }
    const tabOrder = this.store.state.tabs.map((t) => t.id);
    const target = nextAttentionId(entries, tabOrder, this.store.focusedId);
    if (target === null) {
      showToast('Nothing needs you');
      return;
    }
    this.revealPane(target);
  }

  /** Focuses the pane in whatever tab holds it, expanding it when collapsed. */
  revealPane(paneId: string): void {
    if (!this.paneViews.has(paneId)) return;
    if (this.store.isCollapsed(paneId)) this.expandPane(paneId);
    else this.focusPane(paneId);
  }

  /** A terminal's title and why it is waiting, for a notification (design 4.7). */
  waitingNotice(paneId: string): { title: string; reason: string } {
    return { title: this.status.title(paneId), reason: this.status.waitingReason(paneId) };
  }

  /** Closes every pane in the tab without asking; `requestCloseTab` asks first. */
  closeTab(id: string): void {
    const tab = this.store.find(id);
    if (!tab) return;
    const wasActive = id === this.store.activeId;
    for (const paneId of tab.panes) this.forgetPane(paneId);
    this.tabView.forget(id);
    const next = closeTabState(this.store.state, id);
    if (!next) {
      this.closeWindow();
      return;
    }
    this.store.state = next;
    if (wasActive) this.tabView.showActive();
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
    persistence.openLayout(this.ctx, saved, name);
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
    if (this.tabView.zoomedId !== null && paneId !== this.tabView.zoomedId) this.tabView.endZoom(tab.id);
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
    if (wasActive && this.store.activeId !== tab.id) this.tabView.showActive();
    else if (wasActive && inTree) this.tabView.render();
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
    this.tabView.render();
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
    this.tabView.render();
    // After render, so the host is attached when WebGL loads and the refit runs.
    pane.setExpanded(true);
    pane.focus();
    this.notify();
  }

  /** Design 4.2 docking into the active tab; a null target is only valid while its layout is empty. */
  dock(paneId: string, target: DockTarget | null): void {
    this.paneDrag.dock(paneId, target);
  }

  /** Design 4.6: moves the pane into another tab without switching to it. */
  moveToTab(paneId: string, tabId: string): void {
    this.paneDrag.moveToTab(paneId, tabId);
  }

  /** Starts a pointer drag that docks a pane or opens a folder where it drops. */
  startDrag(source: DragSource, e: PointerEvent): void {
    this.paneDrag.startDrag(source, e);
  }

  /**
   * Design 4.11 Kind menu: replaces the pane in place with a new pane of `kind`, asking first
   * when that would lose work.
   */
  async replaceKind(paneId: string, kind: PaneKind): Promise<void> {
    const old = this.paneViews.get(paneId);
    if (!old || old.kind === kind) return;
    const input = this.store.tabOf(paneId) ? this.status.cardInput(this.store.tabOf(paneId)!, paneId) : null;
    if (input && this.status.losesWork(input) && this.hooks.onConfirmReplace) {
      const ok = await this.hooks.onConfirmReplace(paneId, kind);
      if (!ok) {
        this.paneViews.get(this.store.focusedId)?.focus();
        return;
      }
    }
    // The pane or its tab may have changed while the dialog was open.
    const tab = this.store.tabOf(paneId);
    if (!tab || this.paneViews.get(paneId) !== old) return;
    this.swapPane(paneId, tab, specForKind(kind, old.folder, this.recentTerminalCwd(tab), () => this.hooks.getRepoFolder?.()));
  }

  /**
   * Design 4.15: a scratch pad saved to a file becomes a Files pane on that file, its preview
   * filling the pane, and the pad's own copy is deleted, so the file is the only copy.
   */
  private scratchSavedAs(paneId: string, path: string): void {
    const tab = this.store.tabOf(paneId);
    if (!tab || !(this.paneViews.get(paneId) instanceof ScratchPane)) return;
    const { folder, select } = pinTarget(path, path, false);
    this.swapPane(paneId, tab, { kind: 'files', folder, selected: select, expanded: true });
  }

  /** Replaces the pane with a new one built from `spec`, in the same spot; no confirmation. */
  private swapPane(paneId: string, tab: TabState, spec: PaneSpec): void {
    const kind = spec.kind;
    const id = this.takeIdFor(kind);
    const visible = tab.id === this.store.activeId && !tab.collapsed.includes(paneId);
    this.store.replacePane(paneId, id);
    this.forgetPane(paneId);
    if (visible) {
      const host = this.factory.createHost(id);
      this.store.focusedId = id;
      this.tabView.render();
      const pane = this.factory.buildPane(id, host, spec, true);
      pane.focus();
      this.notify();
      this.factory.startPane(id, pane);
      return;
    }
    this.factory.openOffscreen(id, spec);
    this.notify();
  }

  setSessions(sessions: Session[]): void {
    this.sessions.setSessions(sessions);
    let changed = false;
    for (const id of this.paneViews.keys()) {
      const term = this.terminal(id);
      if (term) this.sessions.settle(id, term.ptyId);
      const before = this.status.shown(id);
      if (this.status.refresh(id)) changed = true;
      if (this.status.shown(id) !== before) changed = true;
    }
    if (changed) this.notify();
  }

  /** Pane id of the terminal running the core's pty `ptyId` (`BASHBOARD_PANE_ID`), in any tab. */
  terminalForPty(ptyId: number): string | null {
    for (const id of this.paneViews.keys()) {
      if (this.terminal(id)?.ptyId === ptyId) return id;
    }
    return null;
  }

  /** The title of the terminal running pty `ptyId`, or null when no pane runs it. */
  titleForPty(ptyId: number): string | null {
    const id = this.terminalForPty(ptyId);
    return id === null ? null : this.status.title(id);
  }

  /** Brings forward the terminal running pty `ptyId`, in whatever tab holds it. */
  revealPty(ptyId: number): void {
    const id = this.terminalForPty(ptyId);
    if (id !== null) this.revealPane(id);
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
    const byPty = ev.paneId === null ? null : this.terminalForPty(ev.paneId);
    const match = this.sessions.onHook(ev, byPty, this.terminalEntries(), (id) => this.isSeen(id));
    if (!match) return;
    this.status.refresh(match);
    this.notify();
  }

  /** Records a session's newest model (from the agent context stream) for the next save. */
  setSessionModel(sessionId: string, model: string | null): void {
    this.sessions.setModel(sessionId, model);
  }

  /**
   * Opens a terminal in `cwd` and pastes `text` without Enter once its shell is ready, for a
   * command pin (docs/design/dashboard.md section 4.6). Returns the new pane's id.
   */
  openTerminalWithPaste(cwd: string, text: string, opts: OpenTerminalOptions = {}): string | undefined {
    return this.openPane({ kind: 'terminal', cwd, profile: opts.profile, initialPaste: text }, opts);
  }

  /** Pastes into a terminal without Enter, as bracketed paste when the shell asked for it. */
  pasteIntoTerminal(id: string, text: string): void {
    this.terminal(id)?.pasteText(text);
  }

  /** Opens a terminal in `cwd` and types `command` once its shell is ready, as restore does for a resume. */
  openTerminalWithCommand(cwd: string | undefined, command: string, opts: OpenTerminalOptions = {}): void {
    this.openPane({ kind: 'terminal', cwd, profile: opts.profile, initialInput: command }, opts);
  }

  /** Design 4.9: layout leaves already hold pane ids, which double as saved keys. */
  snapshot(): SavedWorkspace {
    return persistence.snapshot(this.ctx);
  }

  /**
   * Design 4.9: a new shell per saved terminal and each pad with its saved text, tab by tab in
   * saved order. Expects an empty workspace and at least one saved tab.
   */
  restore(saved: SavedWorkspace, opts: { resumeSessions: boolean; scrollback: boolean }): void {
    persistence.restore(this.ctx, saved, opts);
  }

  /** Design 4.9: saves the terminals' scrollback for the next launch, or with `enabled` off, none. */
  async saveScrollback(enabled: boolean): Promise<void> {
    await persistence.saveScrollback(this.ctx, enabled);
  }

  /** Saves every pad's and Files editor's pending text now, for the window closing. */
  async flushPanes(): Promise<void> {
    await persistence.flushPanes(this.ctx);
  }

  /** The focused pane's box in window coordinates, or null when the tab has none on screen. */
  focusedPaneRect(): DOMRect | null {
    return this.tabView.paneRects().get(this.store.focusedId) ?? null;
  }

  /** Design 4.6 Launch: where launching `kind` at `root` would land, for the preview. */
  launchTarget(kind: PaneKind, root: string): LaunchTarget | null {
    return routing.launchTarget(this.ctx, kind, root);
  }

  /** Design 4.12: the folder in the active tab's Files pane for that repo, else a new one. */
  showFiles(req: FilesRequest, opts: OpenPaneOptions = {}): void {
    routing.showFiles(this.ctx, req, opts);
  }

  /** Design 4.13: the active tab's Git pane for that repo, else a new one. */
  showGit(root: string, opts: OpenPaneOptions = {}): void {
    routing.showGit(this.ctx, root, opts);
  }

  /** Design 4.14: opens a Search pane on the repo as a split of the focused pane, never reusing one. */
  showSearch(root: string, query = '', opts: OpenPaneOptions = {}, options?: SearchOptions): void {
    this.openPane({ kind: 'search', root, query, options }, opts);
  }

  /** Design 4.16: the first Containers pane, else a Containers tab, with those groups expanded. */
  openContainers(groupKeys: string[] = []): void {
    routing.openContainers(this.ctx, groupKeys);
  }

  /** Design 4.20: a Ship pane drilled into `target`, or on the Overview when it is null. */
  openShip(target: string | null, tab?: ShipTab): void {
    routing.openShip(this.ctx, target, tab);
  }

  /** Design 4.19: the first Ports pane, else a Ports tab, selecting the `listenerKey` row. */
  openPorts(key?: string, showAll = false): void {
    routing.openPorts(this.ctx, key, showAll);
  }

  /** Design 4.21: a Local Browser pane on `url`, null for its start page. */
  openLocalBrowser(url: string | null, opts: { tab?: boolean; collapsed?: boolean; fromPaneId?: string } = {}): void {
    if (!supports('localBrowser')) {
      // Links and `bb browse` still reach the page, in the system browser.
      if (url) void invoke('open_url', { url }).catch((err: unknown) => console.warn('open_url failed', err));
      return;
    }
    routing.openLocalBrowser(this.ctx, url, opts);
  }

  /** The repos' pins changed; Files panes refresh their pin buttons. */
  pinsChanged(): void {
    for (const pane of this.paneViews.values()) if (pane instanceof FilesPane) pane.pinsChanged();
  }

  /** The primary branch changed, so every Git pane's worktree comparison is stale. */
  reloadWorktrees(): void {
    for (const pane of this.paneViews.values()) if (pane instanceof GitPane) pane.reloadWorktrees();
  }

  setActivity(list: PtyActivity[]): void {
    if (!this.sessions.applyActivity(list, Date.now())) return;
    for (const id of this.paneViews.keys()) this.status.refresh(id);
    this.notify();
  }

  moveFocus(direction: Direction): void {
    if (!this.store.tree) return;
    // Design 4.2: the zoom ends first, then focus moves as usual.
    if (this.tabView.zoomedId !== null) this.tabView.endZoom(this.store.activeId);
    const id = neighbor(this.store.tree, this.store.focusedId, direction, this.containerRect());
    if (!id) return;
    this.setFocused(id);
    this.paneViews.get(id)?.focus();
  }

  resizePane(direction: Direction): void {
    const cell = this.layoutCell();
    if (!this.store.tree || !cell || this.tabView.zoomedId !== null) return;
    const next = resizePane(this.store.tree, this.store.focusedId, direction, this.containerRect(), cell);
    if (next === this.store.tree) return;
    this.store.tree = next;
    this.tabView.render();
  }

  private dispatch(action: Action): boolean {
    return dispatchAction(this.ctx, action);
  }

  private cycleScrim(): void {
    this.scrim = nextScrim(this.scrim, this.config.settings.scrim.blurPx);
    applyScrim(document.documentElement, this.scrim);
    saveSetting(['scrim', 'opacity'], this.scrim.opacity).catch((err: unknown) =>
      showToast(`Could not save the scrim setting: ${String(err)}`),
    );
  }

  /** With no expanded pane nothing holds focus, so workspace keys arrive here instead. */
  private onEmptyLayoutKey(e: KeyboardEvent): void {
    if (this.store.tree || e.defaultPrevented || this.paneDrag.isActive()) return;
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

  /** The action bound to a key, without running it. */
  keyAction(e: KeyboardEvent): Action | null {
    return lookup(this.config.keymap, e);
  }

  /** Runs an action as its key would, for the command palette. */
  runAction(action: Action): boolean {
    return this.dispatch(action);
  }

  /** Attaches and sizes the host via render before the pane builds in it, since start() fits to it. */
  private mount(id: string, tree: Layout, spec: PaneSpec): void {
    const host = this.factory.createHost(id);
    this.store.addToActive(id, false);
    this.store.tree = tree;
    this.store.focusedId = id;
    this.tabView.render();
    const pane = this.factory.buildPane(id, host, spec, true);
    pane.focus();
    this.notify();
    this.factory.startPane(id, pane);
  }

  private openCollapsed(id: string, spec: PaneSpec): void {
    this.store.addToActive(id, true);
    this.factory.openOffscreen(id, spec);
    this.notify();
  }

  /** Starts an in-app path drag (v0.2.0 design section 6) from a row's pointerdown. */
  startPathDrag(paths: string[], e: PointerEvent, move?: PathDrag['move']): void {
    this.pathDrop.startPathDrag(paths, e, move);
  }

  /** The expanded terminal or scratch pad in the active tab under the point, or null. */
  pathTargetAt(x: number, y: number): string | null {
    return this.pathDrop.pathTargetAt(x, y);
  }

  setPathHighlight(id: string | null): void {
    this.pathDrop.setPathHighlight(id);
  }

  /**
   * Inserts paths into a terminal (bracketed paste, no Enter) or at a scratch pad's caret, then
   * shows the target. `baseRoot` undefined makes paths relative to the target terminal's repo.
   */
  async insertPaths(targetId: string, paths: string[], baseRoot?: string | null): Promise<void> {
    await this.pathDrop.insertPaths(targetId, paths, baseRoot);
  }

  /** Drops WebGL and leaves the host to be detached by the next render. */
  private markCollapsed(id: string): void {
    this.store.setCollapsed(id, true);
    if (this.findBar.isOpenOn(this.terminal(id))) this.findBar.close(false);
    this.hosts.get(id)?.classList.remove('focused');
    this.paneViews.get(id)?.setExpanded(false);
  }

  private paneChanged(id: string): void {
    this.status.refresh(id);
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

  /** What the Accounts tab treats as known repos: resolved Ship pane hosts and terminal folders. */
  knownForgeSources(): { hosts: { provider: ProviderKind; host: string }[]; dirs: string[]; repos: string[] } {
    return forgeSourcesOf(this.paneViews.values());
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

  /** Every terminal pane with its id, for matching a hook to its session. */
  private *terminalEntries(): Iterable<[string, TerminalPane]> {
    for (const [id, pane] of this.paneViews) if (pane instanceof TerminalPane) yield [id, pane];
  }

  /** The focused pane's cell size for layout checks; its padY already holds the in-flow strip. */
  private layoutCell(): CellSize | null {
    return this.paneViews.get(this.store.focusedId)?.cellSize() ?? null;
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
    this.tabView.syncZoomButtons();
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
    if (!this.isSeen(id) || !this.sessions.clearDone(id)) return false;
    this.status.refresh(id);
    return true;
  }

  /** Design 4.2 Zoom: toggles the active tab's zoom on its focused pane. */
  private toggleZoom(): void {
    if (this.tabView.toggleZoom()) this.notify();
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

  /** Disposes the pane and drops its per-pane state, deleting a pad's file; the caller updates the tabs. */
  private forgetPane(id: string): void {
    const pane = this.paneViews.get(id);
    this.containerShells.delete(id);
    this.hosts.delete(id);
    this.status.forget(id);
    this.attention.forget(id);
    this.sessions.forget(id);
    this.focusOrder = forget(this.focusOrder, id);
    this.paneViews.delete(id);
    // The save starts before dispose, so pending editor text still reaches the disk.
    if (pane instanceof FilesPane || pane instanceof SearchPane) void pane.flush();
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
