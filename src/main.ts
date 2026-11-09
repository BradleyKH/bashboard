import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import { DEFAULT_SETTINGS, loadSettings, saveSetting, type Settings, type SettingsPayload } from './settings';
import { bindWindowVisibility } from './windowVisibility';
import { gitFetchVisible } from './gitApi';
import { syncGitFetchRoots } from './gitFetchRoots';
import { showNotification } from './notificationsApi';
import { takeStartupFolder } from './secondLaunch';
import { setHomeDir } from './displayPath';
import { containerAction, startEngine, type Engine } from './containers';
import { engineLabel, groupContainers, type DashboardGroupRow } from './containerGroups';
import { ContainersStore } from './containersStore';
import { copyText } from './copyText';
import { stopListener } from './portStop';
import { PortsStore } from './portsStore';
import { LocalModelsStore } from './localModelsStore';
import { setKindMenuFilter } from './kindMenu';
import { DashboardPanel } from './dashboardPanel';
import { paneCards, type PaneCardInput } from './dashboardModel';
import { hiddenNotice } from './dashboardRevealModel';
import { chordHint } from './paletteModel';
import { setKeyHintBindings } from './keyHints';
import { DebouncedSaver } from './debouncedSaver';
import { ConfirmDialog } from './confirmDialog';
import { moveItem, parseFavorites } from './favorites';
import { shipOverviewStore } from './shipOverviewStore';
import { parseLayouts } from './layouts';
import { BackdropHost } from './backdrop/backdropHost';
import { favoritesLoad, layoutsLoad, reposLoad, workspaceLoad, workspaceSave } from './persistence';
import { GIT_BASH_PROFILE, loadProfiles } from './profiles';
import { parseRepos } from './repos';
import { deleteWorktree } from './worktreeDelete';
import { parseSavedWorkspace } from './savedWorkspace';
import { loadSessions } from './sessions';
import { loadTextZoom, onTextZoomChange, textZoomSnapshot } from './textZoomStore';
import { showToast } from './toast';
import { TabStrip } from './tabStrip';
import { closePadConfirm, closeTabConfirm, replaceConfirm } from './paneConfirm';
import type { PaneKind } from './paneKinds';
import { Workspace } from './workspace';
import { fontsReady } from './fontsReady';
import { listenFileDrops } from './fileDrop';
import { checkForUpdate } from './updater';
import { closeContextMenu } from './contextMenu';
import { installTextFieldMenu } from './textFieldMenu';
import type { AppState } from './appState';
import { FavoritesLayouts } from './favoritesLayouts';
import { RepoTracker } from './repoTracker';
import { LaunchController } from './launchController';
import { HookOffer } from './hookOffer';
import { PaletteController } from './paletteController';
import { AppDialogs } from './appDialogs';
import { listenAppEvents, listenSettingsChanges } from './appEvents';

// The built-in menu's Refresh reloads the page, and a reload kills every pane's pty as an orphan.
window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
installTextFieldMenu();

const backdrop = new BackdropHost(document.getElementById('backdrop') as HTMLCanvasElement, (message) =>
  showToast(`Could not show the background image: ${message}`),
);
// Tracked here rather than read from the settings so quick repeated toggles don't act on a
// value the file watcher hasn't reported back yet.
let backdropAnimated = true;

function applyBackdropSettings(settings: Settings): void {
  backdropAnimated = settings.backdrop.animate;
  backdrop.apply(settings.backdrop, settings.accentColor).catch((err: unknown) =>
    showToast(`Could not start the background animation: ${String(err)}`),
  );
}

// The style comes from the settings, so they load first; the mount then runs alongside the font
// and stale-pty awaits below rather than after them.
const settingsLoaded: Promise<SettingsPayload> = loadSettings().catch((err: unknown) => {
  showToast(`Could not load settings, using defaults: ${String(err)}`);
  return { settings: DEFAULT_SETTINGS, warnings: [], firstRun: false };
});
void settingsLoaded.then((p) => applyBackdropSettings(p.settings));
// The dashboard panel is built later; it is told the current value once it exists.
let windowShown = true;
let windowShownSink: ((shown: boolean) => void) | undefined;
bindWindowVisibility((visible) => {
  windowShown = visible;
  windowShownSink?.(visible);
  backdrop.setVisible(visible);
  void gitFetchVisible(visible).catch(() => {});
});

// xterm.js measures glyph cells when a terminal opens, so the bundled font must be loaded before
// the first pane (docs/design/terminal.md section 4.4).
await fontsReady();

// getCurrentWindow() throws synchronously outside Tauri (plain `pnpm dev`), which would abort the
// rest of startup before the first pane mounts.
let appWindow: ReturnType<typeof getCurrentWindow> | undefined;
try {
  appWindow = getCurrentWindow();
} catch {
  appWindow = undefined;
}

function toggleBackdrop(): void {
  // Only the drawn styles animate; Image and Slideshow ignore backdrop.animate.
  if (backdrop.style !== 'lights' && backdrop.style !== 'galaxy' && backdrop.style !== 'matrix' && backdrop.style !== 'wave') return;
  backdropAnimated = !backdropAnimated;
  backdrop.setAnimated(backdropAnimated);
  saveSetting(['backdrop', 'animate'], backdropAnimated).catch((err: unknown) =>
    showToast(`Could not save the background animation setting: ${String(err)}`),
  );
}

function toggleFullscreen(): void {
  if (!appWindow) return;
  const win = appWindow;
  win
    .isFullscreen()
    .then((full) => win.setFullscreen(!full))
    .catch((err: unknown) => showToast(`Could not toggle full screen: ${String(err)}`));
}

// Ptys from before a reload are unreachable since their channels died with the old page
// (docs/design/terminal.md section 3.1). Any of them can exit on its own before the kill lands.
const stale = await invoke<{ id: number; pid: number; startedAt: number }[]>('pty_list').catch(() => []);
await Promise.allSettled(stale.map(({ id }) => invoke('pty_kill', { id })));

setHomeDir(await homeDir().catch(() => null));

const payload = await settingsLoaded;
const state: AppState = {
  settings: payload.settings,
  payload,
  profiles: [GIT_BASH_PROFILE],
  sessions: [],
  favorites: [],
  layouts: [],
  repos: [],
  hideNoticeShown: false,
};
setKeyHintBindings(state.settings.keybindings);

const refreshProfiles = (): Promise<void> =>
  loadProfiles()
    .then((list) => {
      state.profiles = list.length > 0 ? list : [GIT_BASH_PROFILE];
    })
    .catch((e: unknown) => console.warn('shell profiles unavailable:', e));
await refreshProfiles();

try {
  state.sessions = await loadSessions();
} catch (err) {
  showToast(`Could not load agent sessions: ${String(err)}`);
}

try {
  state.favorites = parseFavorites(await favoritesLoad());
} catch (err) {
  console.warn('favorites unavailable:', err);
}

try {
  state.layouts = parseLayouts(await layoutsLoad());
} catch (err) {
  console.warn('layouts unavailable:', err);
}

try {
  state.repos = parseRepos(await reposLoad());
} catch (err) {
  console.warn('repos unavailable:', err);
}

/** Refocuses the focused pane, of any kind, after a dialog or picker closes. */
function focusTerminal(): void {
  const focused = workspace.panes().find((p) => p.focused);
  if (focused) workspace.focusPane(focused.paneId);
}

/** The dashboard toggle's current chords, for the edge handle and the hide notice. */
function toggleKeys(): string | undefined {
  return chordHint(state.settings.keybindings, 'toggleDashboard');
}

const controllerDeps = {
  state,
  workspace: (): Workspace => workspace,
  panel: (): DashboardPanel => panel,
  focusTerminal,
};
const favorites = new FavoritesLayouts(controllerDeps);
const repo = new RepoTracker(controllerDeps);
const containers = new ContainersStore();
const ports = new PortsStore();
const localModels = new LocalModelsStore();
setKindMenuFilter((kind) => kind !== 'containers' || containers.available);
const launch = new LaunchController({ repo, workspace: controllerDeps.workspace, containers });

/** Design 4.10: lists the panes closing the tab would lose work in; resolves true to close it. */
function confirmCloseTab(tabId: string, busyPanes: PaneCardInput[]): Promise<boolean> {
  const title = workspace.tabs().find((t) => t.id === tabId)?.title ?? 'this tab';
  return confirmDialog.open(closeTabConfirm(title, paneCards(busyPanes, state.sessions)));
}

function paneCard(paneId: string) {
  const input = workspace.panes().find((p) => p.paneId === paneId);
  return input ? paneCards([input], state.sessions)[0] : undefined;
}

/** Design 4.15: Ctrl+W on a pad with text. */
function confirmClosePane(paneId: string): Promise<boolean> {
  const card = paneCard(paneId);
  return card ? confirmDialog.open(closePadConfirm(card)) : Promise.resolve(true);
}

/** Design 4.11 Kind menu: replacing a busy terminal or a pad with text. */
function confirmReplace(paneId: string, kind: PaneKind): Promise<boolean> {
  const card = paneCard(paneId);
  return card ? confirmDialog.open(replaceConfirm(card, kind)) : Promise.resolve(true);
}

/** Start or stop every container of the row's member groups that is not already in that state, per engine. */
function actOnContainerRow(row: DashboardGroupRow, action: 'start' | 'stop'): void {
  const keys = new Set(row.groupKeys);
  const wanted = action === 'start' ? (s: string) => s !== 'running' : (s: string) => s === 'running';
  const byEngine = new Map<Engine, string[]>();
  for (const g of groupContainers(containers.current().containers)) {
    if (!keys.has(g.key)) continue;
    for (const c of g.containers) {
      if (wanted(c.state)) byEngine.set(c.engine, [...(byEngine.get(c.engine) ?? []), c.id]);
    }
  }
  for (const [engine, ids] of byEngine) {
    containerAction(engine, ids, action).catch((e) =>
      showToast(`Could not ${action} ${row.name}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
}

/** A Panes card click: expands a collapsed pane, else focuses it. */
function focusCard(paneId: string): void {
  const p = workspace.panes().find((x) => x.paneId === paneId);
  if (p?.collapsed) workspace.expandPane(paneId);
  else workspace.focusPane(paneId);
}

const panel = new DashboardPanel(document.getElementById('dashboard') as HTMLElement, {
  onFocus: focusCard,
  onClose: (paneId) => workspace.closePane(paneId),
  defaultProfile: () => state.settings.shell.defaultProfile,
  onToggleCollapse: (paneId) => {
    if (workspace.panes().find((x) => x.paneId === paneId)?.collapsed) workspace.expandPane(paneId);
    else workspace.collapsePane(paneId);
  },
  onCardDragStart: (paneId, e) => workspace.startDrag({ kind: 'pane', paneId }, e),
  onSwitchTab: (tabId) => workspace.switchTab(tabId),
  onRenameTab: (tabId, name) => workspace.renameTab(tabId, name),
  onSectionsChange: () => saver.schedule(),
  onPanePathsChange: () => saver.schedule(),
  onAgentPanesOnlyChange: () => saver.schedule(),
  onShowStoppedChange: () => saver.schedule(),
  onWidthChange: () => saver.schedule(),
  onOrderChange: () => saver.schedule(),
  onSetElementShown: (el, shown) =>
    saveSetting(['dashboard', 'sections', el], shown).catch((err: unknown) =>
      showToast(`Could not save the setting: ${String(err)}`),
    ),
  onSetClockStyle: (style) =>
    saveSetting(['dashboard', 'clockStyle'], style).catch((err: unknown) =>
      showToast(`Could not save the setting: ${String(err)}`),
    ),
  onOpenContainers: (keys) => workspace.openContainers(keys),
  onOpenShip: (target, tab) => workspace.openShip(target, tab),
  onOpenAccounts: (host, opts) => dialogs.openAccounts(host, opts),
  ports: {
    onOpenPorts: (key, showAll): void => workspace.openPorts(key, showAll),
    ownerTitle: (ptyId): string | null => workspace.titleForPty(ptyId),
    onGoToPane: (ptyId): void => workspace.revealPty(ptyId),
    onOpenUrl: (url) => void invoke('open_url', { url }).catch((e: unknown) => console.warn('open_url failed', e)),
    onCopy: (text, what) => void copyText(text, what),
    onStop: (l): void => {
      const owner: string | null = l.ptyId === null ? null : workspace.titleForPty(l.ptyId);
      void stopListener(l, owner, (o) => confirmDialog.open(o), ports);
    },
  },
  onStart: (row) => actOnContainerRow(row, 'start'),
  onStop: (row) => actOnContainerRow(row, 'stop'),
  onStartEngine: (engine) =>
    startEngine(engine).catch((e: unknown) =>
      showToast(`Could not start ${engineLabel(engine)}: ${e instanceof Error ? e.message : String(e)}`),
    ),
  onOpen: favorites.openFolder,
  onInstallHooks: (agent) => hooks.offer(agent),
  onAdd: favorites.addFocusedFolder,
  onRename: (index, label) =>
    favorites.updateFavorites(state.favorites.map((f, i) => (i === index ? { ...f, label } : f))),
  onRemove: (index) => favorites.updateFavorites(state.favorites.filter((_, i) => i !== index)),
  onReorder: (from, to) => favorites.updateFavorites(moveItem(state.favorites, from, to)),
  onPromote: (path) => favorites.addFavorite(path),
  onDragStart: (path, e) => workspace.startDrag({ kind: 'folder', path }, e),
  onShowHelp: () => void dialogs.open('help'),
  onShowSettings: () => void dialogs.open('settings'),
  onHide: () => {
    // The notice teaches the ways back once; after that it is noise on every ×.
    if (!state.hideNoticeShown) {
      state.hideNoticeShown = true;
      showToast(hiddenNotice(toggleKeys(), state.settings.dashboard.side));
      saver.schedule();
    }
    focusTerminal();
  },
  onReveal: () => focusTerminal(),
  actionKeys: (action) => chordHint(state.settings.keybindings, action),
  onLeave: () => focusTerminal(),
  onKey: (e): boolean => workspace.runKey(e),
  onOpenLayout: (name) => favorites.openLayout(name),
  onSaveLayout: favorites.saveLayout,
  onRenameLayout: favorites.renameLayout,
  onRemoveLayout: (index) => favorites.updateLayouts(state.layouts.filter((_, i) => i !== index)),
  onOpenIn: repo.openIn,
  onLaunch: launch.launch,
  onLaunchPreview: launch.preview,
  onOpenLaunchMenu: (anchor) => void launch.openMenu(anchor),
  onOpenPin: repo.openPin,
  onRenamePin: (index, label) => repo.renamePin(index, label),
  onRemovePin: (index) => repo.removePin(index),
  onReorderPin: (from, to) => repo.movePin(from, to),
  onOpenFavoritesMenu: (anchor) => favorites.openFavoritePicker(anchor),
  onOpenLayoutsMenu: (anchor) => favorites.openLayoutPicker(anchor),
  onShownChange: () => repo.render(),
});
panel.setFavorites(state.favorites);
panel.setLayouts(state.layouts);
const hooks = new HookOffer({ panel, focusTerminal });
void hooks.refresh();
const confirmDialog = new ConfirmDialog();
const checkForUpdatesNow = (): void => void checkForUpdate({ manual: true, confirm: (o) => confirmDialog.open(o) });
const palette = new PaletteController({ ...controllerDeps, repo, favorites, focusCard, checkForUpdatesNow });
const dialogs = new AppDialogs({
  ...controllerDeps,
  confirmDialog,
  hooks,
  favorites,
  refreshProfiles,
  checkForUpdatesNow,
});
// Opened before the first pane mounts so the pane fits the narrowed area and keeps focus.
panel.setContainersStore(containers);
panel.setPortsStore(ports);
panel.setLocalModelsStore(localModels);
void containers.start();
panel.applyDashboardSettings(payload.settings.dashboard, payload.settings.localModels.minContext);
shipOverviewStore.applySettings(payload.settings);
panel.setWindowShown(windowShown);
windowShownSink = (shown) => panel.setWindowShown(shown);
panel.setOpen(payload.settings.dashboard.visibleOnStart);

const workspace = new Workspace(document.getElementById('panes') as HTMLElement, payload, {
  onToggleDashboard: () => {
    panel.toggle();
    focusTerminal();
  },
  onFocusDashboard: (): void => (panel.hasFocus() ? panel.leave() : panel.focusIn()),
  onOpenFavoritePicker: () => favorites.openFavoritePicker(),
  onOpenProfilePicker: () => favorites.openProfilePicker(),
  onOpenLayoutPicker: () => favorites.openLayoutPicker(),
  onOpenLaunchMenu: () => void launch.openMenu(),
  onOpenPalette: () => palette.open(),
  onOpenDialog: (tab) => void dialogs.open(tab),
  onOpenAccounts: (host, opts) => dialogs.openAccounts(host, opts),
  onToggleBackdrop: toggleBackdrop,
  onToggleFullscreen: toggleFullscreen,
  onAttention: (paneId, cause) => {
    if (appWindow && !document.hasFocus()) {
      appWindow
        .requestUserAttention(UserAttentionType.Critical)
        .catch((e) => console.warn('taskbar flash failed:', e));
      if (cause === 'waiting' && state.settings.terminal.notifyWhenWaiting) {
        const { title, reason } = workspace.waitingNotice(paneId);
        showNotification(title, reason, paneId).catch((e) => console.warn('notification failed:', e));
      }
    }
    if (cause === 'waiting' && state.settings.dashboard.peekOnWaiting && !panel.isOpen()) panel.peek();
  },
  onConfirmCloseTab: confirmCloseTab,
  onConfirmClosePane: confirmClosePane,
  onConfirmReplace: confirmReplace,
  onConfirm: (o) => confirmDialog.open(o),
  onDragHover: (pos) => tabStrip?.dragHover(pos),
  tabDropAt: (x, y) => panel.groupAt(x, y),
  onPin: repo.pinPath,
  onUnpin: repo.unpinPath,
  getPinnedFolders: repo.pinnedFolders,
  getRepoFolder: () => repo.currentRepo?.root ?? null,
  containers,
  ports,
  onOpenIn: repo.openIn,
  onDeleteWorktree: (root, w) =>
    deleteWorktree(root, w, {
      panes: (): PaneCardInput[] => workspace.panes(),
      sessions: () => state.sessions,
      confirm: confirmDialog,
    }),
  // The core reads primaryBranch from repos.json, so the Git panes reload once it is written.
  onSetPrimaryBranch: (root, branch) => void repo.setPrimaryBranch(root, branch).then(() => workspace.reloadWorktrees()),
});
const tabStrip: TabStrip | undefined = new TabStrip(
  document.getElementById('tab-strip') as HTMLElement,
  workspace,
  focusTerminal,
);
listenFileDrops({
  targetAt: (x, y) => workspace.pathTargetAt(x, y),
  highlight: (id) => workspace.setPathHighlight(id),
  hover: (pos) => tabStrip?.dragHover(pos),
  drop: (id, paths) => void workspace.insertPaths(id, paths),
});
workspace.setSessions(state.sessions);

const saver = new DebouncedSaver(
  () => ({
    ...workspace.snapshot(),
    collapsedSections: panel.collapsedSections(),
    dashboardWidth: panel.width(),
    dashboardSectionOrder: panel.sectionOrder(),
    dashboardTopElements: panel.topElements(),
    dashboardRightElements: panel.rightElements() ?? undefined,
    dashboardPinsColumn: panel.pinsColumn(),
    showPanePaths: panel.panePathsShown(),
    agentPanesOnly: panel.agentPanesOnlyShown() || undefined,
    hideStoppedContainers: !panel.stoppedContainersShown() || undefined,
    dashboardHideNoticeShown: state.hideNoticeShown || undefined,
    textZoom: textZoomSnapshot(),
  }),
  workspaceSave,
  1000,
);
const refreshPanel = (): void => panel.update(workspace.panes(), workspace.tabs(), state.sessions);
workspace.onChange(() => {
  refreshPanel();
  repo.track();
  syncGitFetchRoots(workspace.panes());
  saver.schedule();
});
// A menu belongs to the tab it was opened in; onChange fires for much else, so compare tab ids.
let activeTabId = workspace.tabs().find((t) => t.active)?.id;
workspace.onChange(() => {
  const next = workspace.tabs().find((t) => t.active)?.id;
  if (next === activeTabId) return;
  activeTabId = next;
  closeContextMenu();
});
onTextZoomChange(() => saver.schedule());
listenAppEvents({ state, workspace, saver, refreshPanel, favorites, repo, appWindow });

let restored = false;
try {
  const saved = parseSavedWorkspace(await workspaceLoad());
  // Collapsed sections, the panel width, and text zoom apply even when restoring panes is switched off.
  if (saved) panel.setCollapsedSections(saved.collapsedSections);
  if (saved?.dashboardWidth !== undefined) panel.setWidth(saved.dashboardWidth);
  if (saved) {
    panel.setPlacement({
      order: saved.dashboardSectionOrder,
      top: saved.dashboardTopElements,
      right: saved.dashboardRightElements,
      pinsColumn: saved.dashboardPinsColumn,
    });
  }
  if (saved?.showPanePaths) panel.setShowPanePaths(true);
  if (saved?.agentPanesOnly) panel.setAgentPanesOnly(true);
  if (saved?.hideStoppedContainers) panel.setShowStoppedContainers(false);
  if (saved?.dashboardHideNoticeShown) state.hideNoticeShown = true;
  if (saved?.textZoom) loadTextZoom(saved.textZoom);
  if (payload.settings.restore.enabled && saved && saved.tabs.length > 0) {
    workspace.restore(saved, {
      resumeSessions: payload.settings.restore.resumeSessions,
      scrollback: payload.settings.restore.scrollback,
    });
    restored = true;
  }
} catch (err) {
  showToast(`Could not restore the workspace: ${String(err)}`);
}
const startupFolder = await takeStartupFolder().catch(() => null);
if (!restored) workspace.addPane(startupFolder ?? undefined);
else if (startupFolder) workspace.newTab(startupFolder);
repo.track();
syncGitFetchRoots(workspace.panes());
if (payload.firstRun) void dialogs.showSetup();
void checkForUpdate({ manual: false, confirm: (o) => confirmDialog.open(o) });
listenSettingsChanges({ state, workspace, panel, dialogs, applyBackdropSettings, refreshProfiles });
