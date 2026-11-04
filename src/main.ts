import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  editKeybindings,
  openSettingsFile,
  saveSetting,
  type Settings,
  type SettingsPayload,
} from './settings';
import { bindWindowVisibility } from './windowVisibility';
import { gitFetchVisible } from './gitApi';
import { syncGitFetchRoots } from './gitFetchRoots';
import { onCliCommand } from './cli';
import { onNotificationActivated, showNotification } from './notificationsApi';
import { onSecondLaunch } from './secondLaunch';
import { runCliCommand, type CliTarget } from './cliDispatch';
import { ColonySync } from './colonySync';
import { setHomeDir } from './displayPath';
import { containerAction, startEngine, type Engine } from './containers';
import { engineLabel, groupContainers, type DashboardGroupRow } from './containerGroups';
import { ContainersStore } from './containersStore';
import { copyText } from './copyText';
import { stopListener } from './portStop';
import { PortsStore } from './portsStore';
import { setKindMenuFilter } from './kindMenu';
import { DashboardPanel } from './dashboardPanel';
import { lastFolder, paneCards, type PaneCardInput } from './dashboardModel';
import { hiddenNotice } from './dashboardRevealModel';
import { chordHint } from './paletteModel';
import { setKeyHintBindings } from './keyHints';
import { DebouncedSaver } from './debouncedSaver';
import { listEditors, openInEditor } from './editors';
import { ConfirmDialog } from './confirmDialog';
import { Picker, type PickerItem } from './picker';
import { CommandPalette } from './commandPalette';
import { AboutTab } from './aboutTab';
import { AppDialog } from './appDialog';
import { DIALOG_TAB_FOR_ACTION, type DialogTab } from './appDialogModel';
import { CliTab } from './cliTab';
import { HelpTab } from './helpTab';
import { SetupStatus } from './setupStatus';
import { ShortcutsTab } from './shortcutsTab';
import { gitInstall, gitInstallStatus, openGitDownload } from './gitInstall';
import { hookInstall, hookInstallPreview } from './hookInstall';
import { shellIntegrationInstall, shellIntegrationPreview } from './shellIntegration';
import { SettingsTab } from './settingsTab';
import { SetupWizard } from './setupWizard';
import { HookInstallDialog } from './hookInstallDialog';
import { moveItem, parseFavorites, samePath, type Favorite } from './favorites';
import { pinTarget } from './filesRouting';
import { layoutFromSnapshot, parseLayouts, upsertLayout, type NamedLayout } from './layouts';
import { BackdropHost } from './backdrop/backdropHost';
import { setOpenMenuGitProbe } from './openMenu';
import {
  favoritesLoad,
  favoritesSave,
  layoutsLoad,
  layoutsSave,
  onFavoritesChanged,
  onLayoutsChanged,
  onPtyActivity,
  onReposChanged,
  reposLoad,
  reposSave,
  workspaceLoad,
  workspaceSave,
} from './persistence';
import { GIT_BASH_PROFILE, loadProfiles, type ShellProfile } from './profiles';
import { fsList, repoRoot, type RepoInfo } from './repoFiles';
import {
  addPin,
  movePin,
  parseRepos,
  pinsFor,
  removePin,
  renamePin,
  setPrimaryBranch,
  resolvePin,
  toPinPath,
  type Pin,
  type ReposFile,
} from './repos';
import type { RepoPinState } from './pinsSection';
import { launchLabel, launchMenuItems, opensPane, type LaunchKind } from './launchModel';
import { LaunchPreview } from './launchPreview';
import { gitWorktrees, type Worktree } from './worktreeApi';
import { deleteWorktree } from './worktreeDelete';
import { parseSavedWorkspace } from './savedWorkspace';
import { loadSessions, onHookEvent, onSessionsChanged, type Session } from './sessions';
import { loadTextZoom, onTextZoomChange, textZoomSnapshot } from './textZoomStore';
import { showToast } from './toast';
import { trackCtrlHeld } from './ctrlHeld';
import { TabStrip } from './tabStrip';
import { closePadConfirm, closeTabConfirm, replaceConfirm } from './paneConfirm';
import type { PaneKind } from './paneKinds';
import { Workspace } from './workspace';
import { fontsReady } from './fontsReady';
import { listenFileDrops } from './fileDrop';
import { checkForUpdate } from './updater';
import { closeContextMenu, openContextMenu } from './contextMenu';
import { installTextFieldMenu } from './textFieldMenu';

// The built-in menu's Refresh reloads the page, and a reload kills every pane's pty as an orphan.
window.addEventListener('contextmenu', (e) => e.preventDefault(), { capture: true });
installTextFieldMenu();

trackCtrlHeld();

const backdrop = new BackdropHost(document.getElementById('backdrop') as HTMLCanvasElement);
const colonySync = new ColonySync(backdrop.colony);
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
// the first pane (docs/design.md section 4.4).
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
  if (backdrop.style === 'none') return;
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
// (docs/design.md section 3.1). Any of them can exit on its own before the kill lands.
const stale = await invoke<{ id: number; pid: number; startedAt: number }[]>('pty_list').catch(() => []);
await Promise.allSettled(stale.map(({ id }) => invoke('pty_kill', { id })));

setHomeDir(await homeDir().catch(() => null));

const payload = await settingsLoaded;
// Read by onAttention, so peekOnWaiting hot-reloads.
let currentSettings = payload.settings;
setKeyHintBindings(currentSettings.keybindings);
// Kept current on hot reload so the settings dialog opens with fresh warnings.
let latestPayload = payload;

// Re-read on settings hot reload, since shell.path and shell.args shape the Git Bash profile.
let profiles: ShellProfile[] = [GIT_BASH_PROFILE];
const refreshProfiles = (): Promise<void> =>
  loadProfiles()
    .then((list) => {
      profiles = list.length > 0 ? list : [GIT_BASH_PROFILE];
    })
    .catch((e: unknown) => console.warn('shell profiles unavailable:', e));
await refreshProfiles();

let sessions: Session[] = [];
try {
  sessions = await loadSessions();
} catch (err) {
  showToast(`Could not load Claude sessions: ${String(err)}`);
}

let favorites: Favorite[] = [];
try {
  favorites = parseFavorites(await favoritesLoad());
} catch (err) {
  console.warn('favorites unavailable:', err);
}

let layouts: NamedLayout[] = [];
try {
  layouts = parseLayouts(await layoutsLoad());
} catch (err) {
  console.warn('layouts unavailable:', err);
}

let repos: ReposFile = [];
try {
  repos = parseRepos(await reposLoad());
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
  return chordHint(currentSettings.keybindings, 'toggleDashboard');
}

function showFavorites(): void {
  panel.setFavorites(favorites);
  picker.setItems(favoriteItems());
}

function updateFavorites(next: Favorite[]): void {
  favorites = next;
  showFavorites();
  favoritesSave(favorites).catch((err: unknown) => showToast(`Could not save favorites: ${String(err)}`));
}

function addFavorite(path: string, profile?: string): void {
  if (favorites.some((f) => samePath(f.path, path))) return;
  updateFavorites([...favorites, { label: lastFolder(path) || path, path, ...(profile ? { profile } : {}) }]);
}

function canAddFocusedFolder(): boolean {
  const cwd = workspace.terminals().find((t) => t.focused)?.cwd;
  return !!cwd && !favorites.some((f) => samePath(f.path, cwd));
}

/** The dashboard's and the favorites menu's "+": the focused terminal's folder, and its shell when not the default. */
function addFocusedFolder(): void {
  const focused = workspace.terminals().find((t) => t.focused);
  if (!focused?.cwd) return;
  const profile = focused.profile !== currentSettings.shell.defaultProfile ? focused.profile : undefined;
  addFavorite(focused.cwd, profile);
}

/** Collapsed opens leave focus where it was, so the terminal is refocused explicitly. */
function openFolder(path: string, opts: { collapsed: boolean }): void {
  const profile = favorites.find((f) => samePath(f.path, path))?.profile;
  workspace.openTerminal(path, { collapsed: opts.collapsed, profile });
  focusTerminal();
}

function openWithProfile(profile: string, opts: { collapsed: boolean }): void {
  const cwd = workspace.terminals().find((t) => t.focused)?.cwd ?? undefined;
  workspace.openTerminal(cwd, { collapsed: opts.collapsed, profile });
  focusTerminal();
}

function showLayouts(): void {
  panel.setLayouts(layouts);
  layoutPicker.setItems(layoutItems());
}

function updateLayouts(next: NamedLayout[]): void {
  layouts = next;
  showLayouts();
  layoutsSave(layouts).catch((err: unknown) => showToast(`Could not save layouts: ${String(err)}`));
}

function saveLayout(name: string): void {
  updateLayouts(upsertLayout(layouts, layoutFromSnapshot(name, workspace.snapshot())));
}

function renameLayout(index: number, name: string): void {
  if (layouts.some((l, i) => i !== index && l.name.toLowerCase() === name.toLowerCase())) {
    showToast(`A layout named ${name} already exists.`);
    panel.setLayouts(layouts);
    return;
  }
  updateLayouts(layouts.map((l, i) => (i === index ? { ...l, name } : l)));
}

function openLayout(name: string): void {
  const layout = layouts.find((l) => l.name === name);
  if (!layout) {
    showToast(`No layout named ${name}.`);
    return;
  }
  workspace.openLayout(layout.tab, layout.name);
}

// Design 4.6 Launch and Pins: the repo of the focused pane's folder, or of the last focused pane that had one.
let currentRepo: RepoInfo | null = null;
let repoFolder: string | null = null;
let repoPins: RepoPinState[] = [];
const repoRoots = new Map<string, Promise<RepoInfo>>();
/** Whether each pinned path is a folder, or null when it no longer exists; keyed by lowercased path. */
const pinKinds = new Map<string, boolean | null>();
/** Roots whose pins have been looked up since repos.json last changed. */
const pinRootsChecked = new Set<string>();

function pathKey(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function parentFolder(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i < 0) return trimmed;
  const head = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(head) ? `${head}${trimmed[i]}` : head;
}

function cachedRepoRoot(folder: string): Promise<RepoInfo> {
  const key = pathKey(folder);
  let p = repoRoots.get(key);
  if (!p) {
    p = repoRoot(folder);
    repoRoots.set(key, p);
    p.catch(() => repoRoots.delete(key));
  }
  return p;
}

setOpenMenuGitProbe((path) => cachedRepoRoot(path).then((r) => r.isGit, () => false));

/** Looks up whether each of the root's pins exists and is a folder, one listing per parent. */
async function checkPins(root: string): Promise<void> {
  pinRootsChecked.add(pathKey(root));
  const absolutes = pinsFor(repos, root).map((pin) => resolvePin(root, pin));
  const parents = new Map<string, Promise<Map<string, boolean>>>();
  await Promise.all(
    absolutes.map(async (abs) => {
      const parent = parentFolder(abs);
      let listing = parents.get(pathKey(parent));
      if (!listing) {
        listing = fsList(parent).then(
          (entries) => new Map(entries.map((e) => [e.name.toLowerCase(), e.isDir])),
          () => new Map<string, boolean>(),
        );
        parents.set(pathKey(parent), listing);
      }
      const name = abs.slice(parent.length).replace(/^[\\/]+/, '').toLowerCase();
      pinKinds.set(pathKey(abs), (await listing).get(name) ?? null);
    }),
  );
}

function repoPinStates(root: string): RepoPinState[] {
  return pinsFor(repos, root).map((pin) => {
    const absolute = resolvePin(root, pin);
    const kind = pinKinds.get(pathKey(absolute));
    return { pin, absolute, exists: kind !== null && kind !== undefined, isDir: kind === true };
  });
}

function renderRepo(): void {
  repoPins = currentRepo ? repoPinStates(currentRepo.root) : [];
  panel.setRepo({ repo: currentRepo, pins: repoPins });
}

/** Re-checks the current repo's pins, then redraws the section and the Files panes' pin buttons. */
async function refreshPins(): Promise<void> {
  const repo = currentRepo;
  if (repo) await checkPins(repo.root);
  if (repo !== currentRepo) return;
  renderRepo();
  workspace.pinsChanged();
}

function focusedFolder(): string | null {
  const focused = workspace.panes().find((p) => p.focused);
  return focused ? ((focused.kind === 'terminal' ? focused.cwd : (focused.root ?? focused.folder)) ?? null) : null;
}

function trackRepo(): void {
  const folder = focusedFolder();
  if (!folder || (repoFolder !== null && pathKey(folder) === pathKey(repoFolder))) return;
  repoFolder = folder;
  lookUpRepo(folder);
}

/** Reads the folder's repo fresh rather than cached, since the branch changes with every checkout. */
function lookUpRepo(folder: string): void {
  const p = repoRoot(folder);
  repoRoots.set(pathKey(folder), p);
  p.then(
    (info) => {
      if (repoFolder !== folder) return;
      const same = currentRepo !== null && pathKey(currentRepo.root) === pathKey(info.root) && currentRepo.isGit === info.isGit;
      currentRepo = info;
      if (!same) void refreshPins();
    },
    (e: unknown) => {
      repoRoots.delete(pathKey(folder));
      console.warn('repo lookup failed:', e);
    },
  );
}


function pinnedFolders(root: string): string[] {
  if (!pinRootsChecked.has(pathKey(root))) {
    void checkPins(root).then(() => workspace.pinsChanged());
    return [];
  }
  return repoPinStates(root)
    .filter((p) => p.isDir)
    .map((p) => p.absolute);
}

/** Resolves once repos.json is written (or failed to be), for callers whose next read goes through the core. */
function updateRepos(next: ReposFile): Promise<void> {
  if (next === repos) return Promise.resolve();
  repos = next;
  renderRepo();
  workspace.pinsChanged();
  return reposSave(repos).catch((err: unknown) => showToast(`Could not save repos.json: ${String(err)}`));
}

function pinPath(root: string, absolute: string, isDir: boolean): void {
  pinKinds.set(pathKey(absolute), isDir);
  updateRepos(addPin(repos, root, { path: toPinPath(root, absolute) }));
}

function unpinPath(root: string, absolute: string): void {
  const index = pinsFor(repos, root).findIndex((pin) => pathKey(resolvePin(root, pin)) === pathKey(absolute));
  if (index >= 0) updateRepos(removePin(repos, root, index));
}

function openPin(pin: Pin): void {
  if (!currentRepo) return;
  const root = currentRepo.root;
  // The section keeps rows from an earlier render while its content is unchanged, so match by path.
  const state = repoPins.find((p) => p.pin.path === pin.path);
  if (!state?.exists) return;
  const t = pinTarget(root, state.absolute, state.isDir ?? false);
  workspace.showFiles({ root, folder: t.folder, select: t.select });
}

/** Design 4.6 Open menu and Launch: opens for the path's repo root. */
function openIn(kind: 'terminal' | 'files' | 'git' | 'search' | 'editor', path: string): void {
  cachedRepoRoot(path).then(
    ({ root, isGit }) => {
      if (kind === 'git') {
        if (isGit) workspace.showGit(root);
        else showToast(`${path} is not in a git repo`);
      } else if (kind === 'search') {
        workspace.showSearch(root);
      } else if (kind === 'terminal') {
        workspace.openTerminal(root);
        focusTerminal();
      } else if (kind === 'files') {
        workspace.showFiles({ root, folder: root });
      } else {
        void openInEditor(root);
      }
    },
    (err: unknown) => showToast(`Could not open ${path}: ${String(err)}`),
  );
}

// Design 4.6 Launch: the section's buttons, the top bar's + menu, and the openLaunch menu.
const launchPreview = new LaunchPreview();

function launchRoot(): string | null {
  return currentRepo?.root ?? focusedFolder();
}

function previewLaunch(kind: LaunchKind | null): void {
  const root = launchRoot();
  if (!kind || !root || !opensPane(kind)) {
    launchPreview.hide();
    return;
  }
  launchPreview.show(workspace.launchTarget(kind, root), launchLabel(kind));
}

function launch(kind: LaunchKind): void {
  launchPreview.hide();
  if (kind === 'scratch') {
    workspace.openPane({ kind: 'scratch' });
    return;
  }
  const root = launchRoot();
  if (root) openIn(kind, root);
  else showToast('No folder to open');
}

/**
 * Drops from `anchor`, or opens at the focused pane's top-left corner for the keyboard, which
 * keeps it clear of the preview's label in the middle of the new pane.
 */
function openLaunchMenu(anchor?: HTMLElement): void {
  const items = launchMenuItems(currentRepo?.isGit ?? false, launch, previewLaunch);
  const rect = anchor ? null : workspace.focusedPaneRect();
  const at = anchor
    ? { anchorEl: anchor, align: 'right' as const }
    : rect
      ? { x: rect.x + 12, y: rect.y + 32 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 3 };
  openContextMenu(items, at, { focusFirst: true, onClose: () => launchPreview.hide() });
}

/** Design 4.10: lists the panes closing the tab would lose work in; resolves true to close it. */
function confirmCloseTab(tabId: string, busyPanes: PaneCardInput[]): Promise<boolean> {
  const title = workspace.tabs().find((t) => t.id === tabId)?.title ?? 'this tab';
  return confirmDialog.open(closeTabConfirm(title, paneCards(busyPanes, sessions)));
}

function paneCard(paneId: string) {
  const input = workspace.panes().find((p) => p.paneId === paneId);
  return input ? paneCards([input], sessions)[0] : undefined;
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

const containers = new ContainersStore();
const ports = new PortsStore();
setKindMenuFilter((kind) => kind !== 'containers' || containers.available);

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
  onToggleCollapse: (paneId) => {
    if (workspace.panes().find((x) => x.paneId === paneId)?.collapsed) workspace.expandPane(paneId);
    else workspace.collapsePane(paneId);
  },
  onCardDragStart: (paneId, e) => workspace.startDrag({ kind: 'pane', paneId }, e),
  onSwitchTab: (tabId) => workspace.switchTab(tabId),
  onSectionsChange: () => saver.schedule(),
  onPanePathsChange: () => saver.schedule(),
  onWidthChange: () => saver.schedule(),
  onOrderChange: () => saver.schedule(),
  onSetElementShown: (el, shown) =>
    saveSetting(['dashboard', 'sections', el], shown).catch((err: unknown) =>
      showToast(`Could not save the setting: ${String(err)}`),
    ),
  onOpenContainers: (keys) => workspace.openContainers(keys),
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
  onOpen: openFolder,
  onInstallHooks: () => {
    hookInstallPreview()
      .then((preview) => {
        if (preview.alreadyInstalled) showToast('Claude Code hooks are already installed.');
        else hookDialog.open(preview);
      })
      .catch((err: unknown) => showToast(`Could not prepare the hook install: ${String(err)}`));
  },
  onAdd: addFocusedFolder,
  onRename: (index, label) =>
    updateFavorites(favorites.map((f, i) => (i === index ? { ...f, label } : f))),
  onRemove: (index) => updateFavorites(favorites.filter((_, i) => i !== index)),
  onReorder: (from, to) => updateFavorites(moveItem(favorites, from, to)),
  onPromote: (path) => addFavorite(path),
  onDragStart: (path, e) => workspace.startDrag({ kind: 'folder', path }, e),
  onShowHelp: () => void openDialog('help'),
  onShowSettings: () => void openDialog('settings'),
  onHide: () => {
    showToast(hiddenNotice(toggleKeys(), currentSettings.dashboard.side));
    focusTerminal();
  },
  onReveal: () => focusTerminal(),
  actionKeys: (action) => chordHint(currentSettings.keybindings, action),
  onLeave: () => focusTerminal(),
  onKey: (e): boolean => workspace.runKey(e),
  onOpenLayout: (name) => openLayout(name),
  onSaveLayout: saveLayout,
  onRenameLayout: renameLayout,
  onRemoveLayout: (index) => updateLayouts(layouts.filter((_, i) => i !== index)),
  onOpenIn: openIn,
  onLaunch: launch,
  onLaunchPreview: previewLaunch,
  onOpenLaunchMenu: (anchor) => openLaunchMenu(anchor),
  onOpenPin: openPin,
  onRenamePin: (index, label) => currentRepo && updateRepos(renamePin(repos, currentRepo.root, index, label)),
  onRemovePin: (index) => currentRepo && updateRepos(removePin(repos, currentRepo.root, index)),
  onReorderPin: (from, to) => currentRepo && updateRepos(movePin(repos, currentRepo.root, from, to)),
  onOpenFavoritesMenu: (anchor) => picker.open(favoriteItems(), 'Open a favorite folder', anchor),
  onOpenLayoutsMenu: (anchor) => layoutPicker.open(layoutItems(), 'Open a layout', anchor),
  onShownChange: () => renderRepo(),
});
panel.setFavorites(favorites);
panel.setLayouts(layouts);
const hookDialog = new HookInstallDialog({
  onConfirm: async () => {
    await hookInstall();
    panel.setHooksInstalled(true);
    showToast('Claude Code hooks installed. Claude sessions started from now on report waiting.');
  },
  onClose: focusTerminal,
});
hookInstallPreview()
  .then((p) => panel.setHooksInstalled(p.alreadyInstalled || !p.claudeDetected))
  .catch((e) => console.warn('hook install state unavailable:', e));
const picker = new Picker(
  { onOpen: openFolder, onClose: focusTerminal },
  {
    action: {
      kind: 'run',
      label: '+ Add',
      title: 'Add the focused terminal’s folder to favorites',
      enabled: canAddFocusedFolder,
      run: addFocusedFolder,
    },
  },
);
const favoriteItems = (): PickerItem[] =>
  favorites.map((f) => ({ label: f.label, detail: f.path, value: f.path }));
const profilePicker = new Picker({ onOpen: openWithProfile, onClose: focusTerminal });
const profileItems = (): PickerItem[] => profiles.map((p) => ({ label: p.name, value: p.id }));
// A layout always opens as a new tab, so Ctrl+Enter has nothing to collapse.
const layoutPicker = new Picker(
  { onOpen: (name) => openLayout(name), onClose: focusTerminal },
  {
    action: {
      kind: 'name',
      label: '+ Save',
      title: 'Save the current panes as a layout',
      placeholder: 'Name this layout',
      exists: (name) => layouts.some((l) => l.name.toLowerCase() === name.toLowerCase()),
      submit: saveLayout,
    },
  },
);
const layoutItems = (): PickerItem[] =>
  layouts.map((l) => {
    const n = l.tab.panes.length;
    return { label: l.name, detail: `${n} ${n === 1 ? 'pane' : 'panes'}`, value: l.name };
  });
/** The focused repo's worktrees, loaded when the palette opens; null until then. */
let paletteWorktreeList: Worktree[] | null = null;
/** The focused repo's worktrees for the palette; it lists none for fewer than two. */
function paletteWorktrees(): { path: string; name: string; branch: string }[] {
  const list = paletteWorktreeList;
  if (!list || list.length < 2) return [];
  return list.map((w) => ({
    path: w.path,
    name: lastFolder(w.path) || w.path,
    branch: w.branch ?? w.head?.slice(0, 7) ?? '',
  }));
}
const palette = new CommandPalette({
  input: () => ({
    panes: paneCards(workspace.panes(), sessions),
    tabs: workspace.tabs(),
    favorites,
    layouts: layouts.map((l) => ({ name: l.name, paneCount: l.tab.panes.length })),
    pins: repoPins,
    worktrees: paletteWorktrees(),
    keybindings: currentSettings.keybindings,
  }),
  refocus: focusTerminal,
  focusPane: focusCard,
  switchTab: (tabId) => workspace.switchTab(tabId),
  openFavorite: openFolder,
  openLayout,
  openPin,
  openWorktree: (path, opts) => {
    workspace.openTerminal(path, { collapsed: opts.collapsed });
    focusTerminal();
  },
  runAction: (a) => workspace.runAction(a),
  runCommand: (command) => {
    if (command === 'checkForUpdates') checkForUpdatesNow();
  },
});
/** The palette opens at once; its worktree items arrive when the load finishes. */
function openPalette(): void {
  paletteWorktreeList = null;
  palette.open();
  const root = currentRepo?.isGit ? currentRepo.root : null;
  if (!root) return;
  gitWorktrees(root).then(
    (list) => {
      paletteWorktreeList = list.worktrees;
      palette.refresh();
    },
    // The palette just lists no worktrees.
    () => {},
  );
}
const confirmDialog = new ConfirmDialog();
const checkForUpdatesNow = (): void => void checkForUpdate({ manual: true, confirm: (o) => confirmDialog.open(o) });
/** Shows the hook install preview unless the hooks are in; resolves to whether they are installed. */
const installHooks = (): Promise<boolean> =>
  hookInstallPreview().then(
    (preview) =>
      new Promise<boolean>((resolve) => {
        if (preview.alreadyInstalled) {
          panel.setHooksInstalled(true);
          resolve(true);
        } else {
          hookDialog.open(preview, resolve);
        }
      }),
    (err: unknown) => {
      showToast(`Could not prepare the hook install: ${String(err)}`);
      return false;
    },
  );
const shortcutsTab = new ShortcutsTab({
  onEdit: editKeybindings,
  confirm: (o) => confirmDialog.open(o),
});
const settingsTab = new SettingsTab({
  onSave: saveSetting,
  onOpenFile: openSettingsFile,
  getProfiles: () => profiles,
});
const helpTab = new HelpTab(
  new SetupStatus({
    getProfiles: () => profiles,
    getDefaultProfile: () => currentSettings.shell.defaultProfile,
    installGit: () => gitInstall().then(refreshProfiles),
    openGitDownload: () => {
      openGitDownload().catch((e: unknown) => console.warn('open_url failed', e));
    },
    // The hook preview stacks over the dialog and hands focus back to it when it closes.
    installHooks: () => installHooks().finally(() => appDialog.element?.focus()),
    onRunSetup: () => void showSetup(),
  }),
);
const cliTab = new CliTab();
const aboutTab = new AboutTab({ onCheckForUpdates: checkForUpdatesNow });
const appDialog: AppDialog = new AppDialog(
  {
    help: {
      mount: (host) => helpTab.mount(host, currentSettings.keybindings),
      unmount: () => helpTab.unmount(),
      show: () => helpTab.show(),
    },
    settings: {
      mount: (host) => settingsTab.mount(host, latestPayload),
      unmount: () => settingsTab.unmount(),
    },
    shortcuts: {
      mount: (host) => shortcutsTab.mount(host, appDialog.element!, currentSettings.keybindings),
      unmount: () => shortcutsTab.unmount(),
      hide: () => shortcutsTab.hide(),
      onKey: (e) => shortcutsTab.onKey(e),
    },
    cli: cliTab,
    about: aboutTab,
  },
  {
    onClose: focusTerminal,
    tabForKey: (e) => {
      const action = workspace.keyAction(e);
      return action ? (DIALOG_TAB_FOR_ACTION[action.type] ?? null) : null;
    },
  },
);
const openDialog = async (tab: DialogTab): Promise<void> => {
  // The settings tab's shell fields list only the shells installed now.
  if (tab === 'settings' || tab === 'help') await refreshProfiles();
  appDialog.open(tab);
};
const setupWizard = new SetupWizard({
  onClose: focusTerminal,
  onSave: saveSetting,
  getSettings: () => currentSettings,
  getProfiles: () => profiles,
  getEditors: listEditors,
  getFavorites: () => favorites,
  addFavorites: (list) => {
    if (list.length > 0) updateFavorites([...favorites, ...list]);
  },
  installHooks,
  getHookState: () =>
    hookInstallPreview().then((p) => ({ claudeDetected: p.claudeDetected, hooksInstalled: p.alreadyInstalled })),
  installGit: () => gitInstall().then(refreshProfiles),
  openGitDownload: () => {
    openGitDownload().catch((e: unknown) => console.warn('open_url failed', e));
  },
  getShellIntegrationPreview: shellIntegrationPreview,
  installShellIntegration: shellIntegrationInstall,
});
const showSetup = async (): Promise<void> => {
  await refreshProfiles();
  const [preview, git] = await Promise.all([
    hookInstallPreview().catch((e: unknown) => {
      console.warn('hook install state unavailable:', e);
      return null;
    }),
    gitInstallStatus().catch((e: unknown) => {
      console.warn('git install state unavailable:', e);
      return null;
    }),
  ]);
  appDialog.close();
  setupWizard.open({
    claudeDetected: preview?.claudeDetected ?? false,
    hooksInstalled: preview?.alreadyInstalled ?? false,
    // An unknown Git state skips the Git step rather than offering an install that may not apply.
    gitBashFound: git?.gitBashFound ?? true,
    wingetFound: git?.wingetFound ?? false,
  });
};
// Opened before the first pane mounts so the pane fits the narrowed area and keeps focus.
panel.setContainersStore(containers);
panel.setPortsStore(ports);
void containers.start();
panel.applyDashboardSettings(payload.settings.dashboard, payload.settings.backdrop.animate);
panel.setWindowShown(windowShown);
windowShownSink = (shown) => panel.setWindowShown(shown);
panel.setOpen(payload.settings.dashboard.visibleOnStart);

const workspace = new Workspace(document.getElementById('panes') as HTMLElement, payload, {
  onToggleDashboard: () => {
    panel.toggle();
    focusTerminal();
  },
  onFocusDashboard: (): void => (panel.hasFocus() ? panel.leave() : panel.focusIn()),
  onOpenFavoritePicker: () => picker.open(favoriteItems(), 'Open a favorite folder'),
  onOpenProfilePicker: () => profilePicker.open(profileItems(), 'Split with a shell'),
  onOpenLayoutPicker: () => layoutPicker.open(layoutItems(), 'Open a layout'),
  onOpenLaunchMenu: () => openLaunchMenu(),
  onOpenPalette: () => openPalette(),
  onOpenDialog: (tab) => void openDialog(tab),
  onToggleBackdrop: toggleBackdrop,
  onToggleFullscreen: toggleFullscreen,
  onAttention: (paneId, cause) => {
    if (appWindow && !document.hasFocus()) {
      appWindow
        .requestUserAttention(UserAttentionType.Critical)
        .catch((e) => console.warn('taskbar flash failed:', e));
      if (cause === 'waiting' && currentSettings.terminal.notifyWhenWaiting) {
        const { title, reason } = workspace.waitingNotice(paneId);
        showNotification(title, reason, paneId).catch((e) => console.warn('notification failed:', e));
      }
    }
    if (cause === 'waiting' && currentSettings.dashboard.peekOnWaiting && !panel.isOpen()) panel.peek();
  },
  onConfirmCloseTab: confirmCloseTab,
  onConfirmClosePane: confirmClosePane,
  onConfirmReplace: confirmReplace,
  onConfirm: (o) => confirmDialog.open(o),
  onDragHover: (pos) => tabStrip?.dragHover(pos),
  tabDropAt: (x, y) => panel.groupAt(x, y),
  onPin: pinPath,
  onUnpin: unpinPath,
  getPinnedFolders: pinnedFolders,
  getRepoFolder: () => currentRepo?.root ?? null,
  containers,
  ports,
  onOpenIn: openIn,
  onDeleteWorktree: (root, w) =>
    deleteWorktree(root, w, {
      panes: (): PaneCardInput[] => workspace.panes(),
      sessions: () => sessions,
      confirm: confirmDialog,
    }),
  // The core reads primaryBranch from repos.json, so the Git panes reload once it is written.
  onSetPrimaryBranch: (root, branch) =>
    void updateRepos(setPrimaryBranch(repos, root, branch)).then(() => workspace.reloadWorktrees()),
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
workspace.setSessions(sessions);
colonySync.update(sessions);

const saver = new DebouncedSaver(
  () => ({
    ...workspace.snapshot(),
    collapsedSections: panel.collapsedSections(),
    dashboardWidth: panel.width(),
    dashboardSectionOrder: panel.sectionOrder(),
    dashboardTopElements: panel.topElements(),
    showPanePaths: panel.panePathsShown(),
    textZoom: textZoomSnapshot(),
  }),
  workspaceSave,
  1000,
);
const refreshPanel = (): void => panel.update(workspace.panes(), workspace.tabs(), sessions);
workspace.onChange(() => {
  refreshPanel();
  trackRepo();
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
// listen() rejects outside Tauri (plain `pnpm dev`); live updates are simply unavailable there.
onSessionsChanged((next) => {
  sessions = next;
  colonySync.update(next);
  workspace.setSessions(next);
  refreshPanel();
  saver.schedule();
}).catch((e) => console.warn('session updates unavailable:', e));
onHookEvent((ev) => workspace.onHook(ev)).catch((e) => console.warn('hook events unavailable:', e));
const cliTarget: CliTarget = {
  terminalForPty: (ptyId) => workspace.terminalForPty(ptyId),
  anchorOn: (paneId) => workspace.anchorOn(paneId),
  showFiles: (req, opts) => workspace.showFiles(req, opts),
  showGit: (root, opts) => workspace.showGit(root, opts),
  showSearch: (root, query, opts) => workspace.showSearch(root, query, opts),
  openScratch: (text, opts) => workspace.openPane({ kind: 'scratch', text }, opts),
  openInEditor: (path, line) => void openInEditor(path, line),
};
onCliCommand((cmd) => runCliCommand(cmd, cliTarget)).catch((e) => console.warn('pane CLI unavailable:', e));
onSecondLaunch((folder) => {
  if (folder) workspace.newTab(folder);
}).catch((e) => console.warn('second-launch handoff unavailable:', e));
onNotificationActivated((paneId) => workspace.revealPane(paneId)).catch((e) =>
  console.warn('notification clicks unavailable:', e),
);
onPtyActivity((list) => workspace.setActivity(list)).catch((e) => console.warn('activity sweep unavailable:', e));
onFavoritesChanged((raw) => {
  favorites = parseFavorites(raw);
  showFavorites();
}).catch((e) => console.warn('favorites updates unavailable:', e));
onReposChanged((raw) => {
  repos = parseRepos(raw);
  pinRootsChecked.clear();
  void refreshPins();
  // A hand edit of primaryBranch changes every worktree row's comparison.
  workspace.reloadWorktrees();
}).catch((e) => console.warn('repos updates unavailable:', e));
onLayoutsChanged((raw) => {
  layouts = parseLayouts(raw);
  showLayouts();
}).catch((e) => console.warn('layouts updates unavailable:', e));
// Also fires for close_window after the last pane closes, so an empty workspace is saved.
appWindow
  ?.onCloseRequested(async () => {
    await workspace.flushPanes();
    await workspace
      .saveScrollback(currentSettings.restore.scrollback)
      .catch((e) => console.warn('scrollback save on close failed:', e));
    await saver.flush().catch((e) => console.warn('workspace save on close failed:', e));
  })
  .catch((e) => console.warn('close handling unavailable:', e));

let restored = false;
try {
  const saved = parseSavedWorkspace(await workspaceLoad());
  // Collapsed sections, the panel width, and text zoom apply even when restoring panes is switched off.
  if (saved) panel.setCollapsedSections(saved.collapsedSections);
  if (saved?.dashboardWidth !== undefined) panel.setWidth(saved.dashboardWidth);
  if (saved?.dashboardSectionOrder) panel.setSectionOrder(saved.dashboardSectionOrder);
  if (saved?.dashboardTopElements) panel.setTopElements(saved.dashboardTopElements);
  if (saved?.showPanePaths) panel.setShowPanePaths(true);
  if (saved?.textZoom) loadTextZoom(saved.textZoom);
  if (payload.settings.restore.enabled && saved && saved.tabs.length > 0) {
    workspace.restore(saved, {
      resumeClaude: payload.settings.restore.resumeClaude,
      scrollback: payload.settings.restore.scrollback,
    });
    restored = true;
  }
} catch (err) {
  showToast(`Could not restore the workspace: ${String(err)}`);
}
if (!restored) workspace.addPane();
trackRepo();
syncGitFetchRoots(workspace.panes());
if (payload.firstRun) void showSetup();
void checkForUpdate({ manual: false, confirm: (o) => confirmDialog.open(o) });
onSettingsChanged((p) => {
  currentSettings = p.settings;
  setKeyHintBindings(p.settings.keybindings);
  latestPayload = p;
  settingsTab.update(p);
  helpTab.update(p.settings.keybindings);
  if (setupWizard.isOpen()) setupWizard.update(p.settings);
  shortcutsTab.update(p.settings.keybindings);
  applyBackdropSettings(p.settings);
  workspace.applySettings(p);
  panel.applyDashboardSettings(p.settings.dashboard, p.settings.backdrop.animate);
  void refreshProfiles().then(() => settingsTab.update(latestPayload));
}).catch((e) => console.warn('settings hot reload unavailable:', e));
