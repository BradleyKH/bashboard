import { invoke } from '@tauri-apps/api/core';
import { shellCommand, type Container } from './containers';
import { ContainersPane } from './containersPane';
import { ContainersStore } from './containersStore';
import type { DragSource } from './docking';
import { FilesPane } from './filesPane';
import { pinTarget, type FilesRequest } from './filesRouting';
import { GitPane } from './gitPane';
import type { Action, Keymap } from './keymap';
import { handleKey } from './keys';
import { LocalBrowserPane } from './localBrowserPane';
import { TerminalPane, type CommandEvent } from './pane';
import type { PaneKind } from './paneKinds';
import type { PaneView } from './paneView';
import type { PathDrag } from './pathDragLayer';
import { scratchSave, scratchSaveAs } from './persistence';
import { PortsPane } from './portsPane';
import { PortsStore } from './portsStore';
import { repoRoot } from './repoFiles';
import { newScratchId } from './scratchModel';
import { ScratchPane } from './scratchPane';
import { folderInclude } from './searchModel';
import { DEFAULT_SEARCH_OPTIONS, type SearchOptions } from './searchOptions';
import { SearchPane } from './searchPane';
import type { Settings } from './settings';
import { ShipPane } from './shipPane';
import { supports } from './platform';
import { showToast } from './toast';
import type { PaneStatus } from './paneStatus';
import type { TabStore } from './tabStore';
import { TitleStrip } from './titleStrip';
import type { OpenPaneOptions, OpenTerminalOptions, PaneSpec, WorkspaceHooks } from './workspaceTypes';

/** What `PaneFactory` reads of the workspace and the pane callbacks it wires back into it. */
export interface PaneFactoryContext {
  readonly store: TabStore;
  readonly hooks: WorkspaceHooks;
  readonly root: HTMLElement;
  readonly paneViews: Map<string, PaneView>;
  readonly hosts: Map<string, HTMLElement>;
  /** Container shell pane ids to their container's name. */
  readonly containerShells: Map<string, string>;
  paneStatus(): PaneStatus;
  /** Keeps a host that is off screen alive. */
  keep(host: HTMLElement): void;
  keymap(): Keymap;
  paneSettings(): Settings;
  dispatch(action: Action): boolean;
  terminal(id: string): TerminalPane | undefined;
  setFocused(id: string): void;
  paneChanged(id: string): void;
  onCommand(id: string, ev: CommandEvent): void;
  onBell(id: string): void;
  focusPane(id: string): void;
  collapsePane(id: string): void;
  closePane(id: string): void;
  requestClosePane(id: string): Promise<void>;
  toggleZoom(): void;
  replaceKind(id: string, kind: PaneKind): Promise<void>;
  startDrag(source: DragSource, e: PointerEvent): void;
  startPathDrag(paths: string[], e: PointerEvent, move?: PathDrag['move']): void;
  insertPathIntoTab(id: string, paths: string[], baseRoot: string): void;
  insertTextIntoTab(id: string, text: string): void;
  send(padId: string, text: string): void;
  scratchSavedAs(id: string, path: string): void;
  openPane(spec: PaneSpec, opts?: OpenPaneOptions): void;
  openTerminal(cwd?: string, opts?: OpenTerminalOptions): void;
  openLocalBrowser(url: string | null, opts?: { tab?: boolean; collapsed?: boolean; fromPaneId?: string }): void;
  showFiles(req: FilesRequest, opts?: OpenPaneOptions): void;
  showGit(root: string, opts?: OpenPaneOptions): void;
  showSearch(root: string, query?: string, opts?: OpenPaneOptions, options?: SearchOptions): void;
  titleForPty(ptyId: number): string | null;
  revealPty(ptyId: number): void;
}

/**
 * Builds a pane of each kind with its host and title strip (docs/design/workspace.md section
 * 4.11), wiring the pane's callbacks back to the workspace, and registers it there.
 */
export class PaneFactory {
  private emptyContainers: ContainersStore | undefined;
  private emptyPorts: PortsStore | undefined;
  private sizer: HTMLElement | null = null;

  constructor(private readonly ctx: PaneFactoryContext) {}

  createHost(id: string): HTMLElement {
    const host = document.createElement('div');
    host.className = 'pane';
    this.ctx.hosts.set(id, host);
    return host;
  }

  buildPane(id: string, host: HTMLElement, spec: PaneSpec, expanded: boolean, onReady?: () => void): PaneView {
    const { pane, strip } = this.build(id, host, spec, expanded, onReady);
    this.ctx.paneViews.set(id, pane);
    const newPin = this.newPinHandler(id, spec);
    strip.setActions(pane.stripActions ?? (newPin ? newPinButton(newPin) : null));
    this.ctx.paneStatus().register(id, strip);
    this.ctx.paneStatus().refresh(id);
    return pane;
  }

  startPane(id: string, pane: PaneView): void {
    if (!(pane instanceof TerminalPane)) return;
    pane.start().then(() => this.ctx.paneChanged(id)).catch((err: unknown) => {
      const msg = `Could not start the shell: ${String(err)}`;
      pane.notice(`[${msg}]`);
      showToast(msg);
    });
  }

  // xterm measures its cell size when it opens, so a terminal that is not on screen (collapsed,
  // or in a background tab) opens in a hidden sizer and is detached right after. Its pty spawns
  // at xterm's default size and is refit when it is shown. Other kinds need no measuring.
  openOffscreen(id: string, spec: PaneSpec, onReady?: () => void): void {
    const host = this.createHost(id);
    if (spec.kind === 'terminal') this.getSizer().append(host);
    const pane = this.buildPane(id, host, spec, false, onReady);
    host.remove();
    // A Local Browser page loads while off screen, so it is ready when shown.
    this.ctx.keep(host);
    this.startPane(id, pane);
  }

  private getSizer(): HTMLElement {
    if (!this.sizer) {
      this.sizer = document.createElement('div');
      this.sizer.className = 'pane-sizer';
      document.body.append(this.sizer);
    }
    const r = this.ctx.root.getBoundingClientRect();
    this.sizer.style.width = `${r.width}px`;
    this.sizer.style.height = `${r.height}px`;
    return this.sizer;
  }

  /**
   * A terminal's New pin (docs/design/terminal.md section 4.4): a command pin in its working
   * directory, prefilled with its selection. A container shell's folder is inside the container,
   * so it has none.
   */
  private newPinHandler(id: string, spec: PaneSpec): (() => void) | undefined {
    const { ctx } = this;
    const hook = ctx.hooks.onNewCommandPin;
    if (spec.kind !== 'terminal' || spec.container || !hook) return undefined;
    return () => {
      const term = ctx.terminal(id);
      hook(term?.cwd ?? null, term?.selection() ?? '');
    };
  }

  /** The strip goes in first so it sits ahead of the body the pane builds into. */
  private build(
    id: string,
    host: HTMLElement,
    spec: PaneSpec,
    expanded: boolean,
    onReady?: () => void,
  ): { pane: PaneView; strip: TitleStrip } {
    const { ctx } = this;
    const strip = new TitleStrip(
      {
        onCollapse: () => ctx.collapsePane(id),
        onClose: () => void ctx.requestClosePane(id),
        onZoom: () => {
          ctx.focusPane(id);
          ctx.toggleZoom();
        },
        onChooseKind: (kind) => void ctx.replaceKind(id, kind),
        onDragStart: (e) => ctx.startDrag({ kind: 'pane', paneId: id }, e),
        onNewPin: this.newPinHandler(id, spec),
      },
      spec.kind,
    );
    host.prepend(strip.el);
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
      case 'ship':
        pane = this.createShip(id, host, spec, expanded);
        break;
      case 'search':
        pane = this.createSearch(id, host, spec, expanded);
        break;
      case 'containers':
        pane = this.createContainers(id, host, expanded);
        break;
      case 'ports':
        pane = this.createPorts(id, host, expanded);
        break;
      case 'browser':
        pane = this.createBrowser(id, host, spec, expanded);
        break;
    }
    return { pane, strip };
  }

  private createTerminal(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'terminal' }>,
    expanded: boolean,
    onReady?: () => void,
  ): TerminalPane {
    const { ctx } = this;
    if (spec.container) ctx.containerShells.set(id, spec.container.name);
    return new TerminalPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      cwd: spec.cwd,
      profile: spec.profile,
      command: spec.command,
      scrollbackId: spec.scrollbackId ?? newScratchId(),
      replay: spec.replay,
      expanded,
      keyHandler: (e, term, send) =>
        handleKey(e, { keymap: () => ctx.keymap(), term, send, dispatch: (a) => ctx.dispatch(a) }),
      onFocus: () => ctx.setFocused(id),
      onOpenLocal: (url) => ctx.openLocalBrowser(url, { fromPaneId: id }),
      onExit: (code) => {
        // Matches Windows Terminal: a clean exit closes the pane, a failure stays readable.
        if (code === 0) ctx.closePane(id);
        else ctx.paneChanged(id);
      },
      onCwdChange: () => ctx.paneChanged(id),
      onShellChange: () => ctx.paneChanged(id),
      onCommand: (ev) => ctx.onCommand(id, ev),
      onBell: () => ctx.onBell(id),
      onReady:
        onReady ??
        (spec.initialInput !== undefined
          ? () => ctx.terminal(id)?.typeText(`${spec.initialInput}\r`)
          : spec.initialPaste !== undefined
            ? () => ctx.terminal(id)?.pasteText(spec.initialPaste ?? '')
            : undefined),
    });
  }

  private createScratch(id: string, host: HTMLElement, spec: Extract<PaneSpec, { kind: 'scratch' }>): ScratchPane {
    const { ctx } = this;
    const pad = new ScratchPane({
      host,
      paneId: id,
      scratchId: spec.scratchId ?? newScratchId(),
      settings: ctx.paneSettings(),
      text: spec.text,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onChange: () => ctx.paneChanged(id),
      onSend: (text) => ctx.send(id, text),
      save: scratchSave,
      saveAs: scratchSaveAs,
      onSavedAs: (path) => ctx.scratchSavedAs(id, path),
    });
    // The pad fills itself first, so its title is current by the time this runs.
    if (spec.text instanceof Promise) spec.text.then(() => ctx.paneChanged(id), () => {});
    return pad;
  }

  private createSearch(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'search' }>,
    expanded: boolean,
  ): SearchPane {
    const { ctx } = this;
    return new SearchPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      root: spec.root,
      query: spec.query ?? '',
      options: spec.options ?? DEFAULT_SEARCH_OPTIONS,
      expanded,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onChange: () => ctx.paneChanged(id),
      onPathDragStart: (paths, e) => ctx.startPathDrag(paths, e),
      onInsertPath: (absolute, baseRoot) => ctx.insertPathIntoTab(id, [absolute], baseRoot),
      onShowInFiles: (absolute, root) => ctx.showFiles({ root, ...pinTarget(root, absolute, false) }),
    });
  }

  private createGit(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'git' }>,
    expanded: boolean,
  ): GitPane {
    const { ctx } = this;
    return new GitPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      root: spec.root,
      expanded,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onChange: () => ctx.paneChanged(id),
      confirm: (o) => ctx.hooks.onConfirm?.(o) ?? Promise.resolve(false),
      onPathDragStart: (paths, e) => ctx.startPathDrag(paths, e),
      onInsertPath: (absolute, baseRoot) => ctx.insertPathIntoTab(id, [absolute], baseRoot),
      onInsertText: (text) => ctx.insertTextIntoTab(id, text),
      onOpenGit: (root) => ctx.showGit(root),
      onOpenIn: (kind, path) => ctx.hooks.onOpenIn?.(kind, path),
      onDeleteWorktree: (root, w) => ctx.hooks.onDeleteWorktree?.(root, w) ?? Promise.resolve(null),
      onSetPrimaryBranch: (root, branch) => ctx.hooks.onSetPrimaryBranch?.(root, branch),
      tab: spec.tab,
    });
  }

  private createShip(
    id: string,
    host: HTMLElement,
    spec: Extract<PaneSpec, { kind: 'ship' }>,
    expanded: boolean,
  ): ShipPane {
    const { ctx } = this;
    return new ShipPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      root: spec.root ?? null,
      expanded,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onChange: () => ctx.paneChanged(id),
      confirm: (o) => ctx.hooks.onConfirm?.(o) ?? Promise.resolve(false),
      onRunTerminal: (argv, cwd) => this.openShipCommand(id, argv, cwd),
      onOpenAccounts: (host, opts) => ctx.hooks.onOpenAccounts?.(host, opts),
      onOpenTerminal: (root) => ctx.openTerminal(root),
      tab: spec.tab,
      thisBranch: spec.thisBranch,
      thisBranchPulls: spec.thisBranchPulls,
      allPulls: spec.allPulls,
    });
  }

  /**
   * A Ship pane's sign-in or install command, in a terminal split off it. A clean exit closes
   * that terminal; one still open at quit is saved, and restored, as a plain shell in `cwd`.
   */
  private openShipCommand(shipPaneId: string, argv: string[], cwd: string): void {
    if (!this.ctx.store.isCollapsed(shipPaneId)) this.ctx.focusPane(shipPaneId);
    this.ctx.openPane({ kind: 'terminal', cwd: cwd || undefined, command: argv });
  }

  private createContainers(id: string, host: HTMLElement, expanded: boolean): ContainersPane {
    const { ctx } = this;
    return new ContainersPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      expanded,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onOpenLocal: (url) => ctx.openLocalBrowser(url, { fromPaneId: id }),
      // Without a store from the app (a browser-only run) the pane shows no engines.
      store: ctx.hooks.containers ?? (this.emptyContainers ??= new ContainersStore()),
      onShell: (c) => this.openContainerShell(id, c),
      confirm: (o) => ctx.hooks.onConfirm?.(o) ?? Promise.resolve(false),
    });
  }

  /** Design 4.16: a shell inside the container, split off its Containers pane. */
  private openContainerShell(containersPaneId: string, container: Container): void {
    if (!this.ctx.store.isCollapsed(containersPaneId)) this.ctx.focusPane(containersPaneId);
    this.ctx.openPane({ kind: 'terminal', command: shellCommand(container), container: { name: container.name } });
  }

  private createPorts(id: string, host: HTMLElement, expanded: boolean): PortsPane {
    const { ctx } = this;
    return new PortsPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      expanded,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onOpenLocal: (url) => ctx.openLocalBrowser(url, { fromPaneId: id }),
      // Without a store from the app (a browser-only run) the pane lists nothing.
      store: ctx.hooks.ports ?? (this.emptyPorts ??= new PortsStore()),
      ownerTitle: (ptyId) => ctx.titleForPty(ptyId),
      onGoToPane: (ptyId) => ctx.revealPty(ptyId),
      confirm: (o) => ctx.hooks.onConfirm?.(o) ?? Promise.resolve(false),
    });
  }

  private createBrowser(id: string, host: HTMLElement, spec: Extract<PaneSpec, { kind: 'browser' }>, expanded: boolean): LocalBrowserPane {
    const { ctx } = this;
    const store = ctx.hooks.ports ?? (this.emptyPorts ??= new PortsStore());
    return new LocalBrowserPane({
      host,
      paneId: id,
      url: spec.url,
      devtools: spec.devtools,
      device: spec.device,
      settings: ctx.paneSettings(),
      expanded,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      listeners: () => store.current(),
      onOpenExternal: (url) => {
        invoke('open_url', { url }).catch((err: unknown) => console.warn('open_url failed', err));
      },
      confirm: (o) => ctx.hooks.onConfirm?.(o) ?? Promise.resolve(false),
      onStateChange: () => ctx.paneChanged(id),
      onWantPorts: (wanted) => store.setWanted(`pane:${id}`, wanted),
    });
  }

  private createFiles(id: string, host: HTMLElement, spec: Extract<PaneSpec, { kind: 'files' }>): FilesPane {
    const { ctx } = this;
    // The pane asks for its pins while it is still being constructed.
    let pane: FilesPane | undefined;
    const root = () => pane?.root() ?? spec.root ?? spec.folder;
    pane = new FilesPane({
      host,
      paneId: id,
      settings: ctx.paneSettings(),
      folder: spec.folder,
      selected: spec.selected,
      root: spec.root,
      expanded: spec.expanded,
      sort: spec.sort,
      keymap: () => ctx.keymap(),
      dispatch: (a) => ctx.dispatch(a),
      onFocus: () => ctx.setFocused(id),
      onChange: () => ctx.paneChanged(id),
      onOpenTerminalHere: (folder) => {
        ctx.focusPane(id);
        ctx.openTerminal(folder);
      },
      onSearchHere: (folder) => void this.searchFolder(id, folder),
      onOpenLocal: supports('localBrowser') ? (url) => ctx.openLocalBrowser(url, { fromPaneId: id }) : undefined,
      onInsertPaths: (paths, baseRoot) => ctx.insertPathIntoTab(id, paths, baseRoot),
      onPathDragStart: (paths, e, move) => ctx.startPathDrag(paths, e, move),
      onPin: (absolute, isDir) => ctx.hooks.onPin?.(root(), absolute, isDir),
      onUnpin: (absolute) => ctx.hooks.onUnpin?.(root(), absolute),
      getPinnedFolders: () => ctx.hooks.getPinnedFolders?.(root()) ?? [],
    });
    return pane;
  }

  /**
   * Search in this folder (design 4.12): a Search pane on the folder's own repo, which can sit
   * below a Files pane opened outside any repo, limited to the folder.
   */
  private async searchFolder(filesPaneId: string, folder: string): Promise<void> {
    let root = folder;
    try {
      root = (await repoRoot(folder)).root;
    } catch {
      // Not resolvable: search the folder itself, and let the core report a bad path inline.
    }
    this.ctx.focusPane(filesPaneId);
    this.ctx.showSearch(root, '', {}, { ...DEFAULT_SEARCH_OPTIONS, include: folderInclude(root, folder) });
  }
}

function newPinButton(onClick: () => void): HTMLElement {
  const el = document.createElement('div');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'strip-action';
  b.textContent = '+';
  b.title = 'New pin: pin a command in this folder';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  el.append(b);
  return el;
}
