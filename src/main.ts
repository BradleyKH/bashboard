import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { invoke } from '@tauri-apps/api/core';
import { homeDir } from '@tauri-apps/api/path';
import { getCurrentWindow, UserAttentionType } from '@tauri-apps/api/window';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  onSettingsChanged,
  openSettingsFile,
  saveSetting,
  type Settings,
  type SettingsPayload,
} from './settings';
import { bindBackdropVisibility } from './backdropVisibility';
import { onCliCommand } from './cli';
import { runCliCommand, type CliTarget } from './cliDispatch';
import { ColonySync } from './colonySync';
import { setHomeDir } from './displayPath';
import { containerAction, type Engine } from './containers';
import { groupContainers, type DashboardGroupRow } from './containerGroups';
import { ContainersStore } from './containersStore';
import { setKindMenuFilter } from './kindMenu';
import { DashboardPanel } from './dashboardPanel';
import { lastFolder, paneCards, type PaneCardInput } from './dashboardModel';
import { DebouncedSaver } from './debouncedSaver';
import { listEditors, openInEditor } from './editors';
import { ConfirmDialog } from './confirmDialog';
import { Picker, type PickerItem } from './picker';
import { HelpDialog } from './helpDialog';
import { helpSections } from './helpModel';
import { gitInstall, gitInstallStatus, openGitDownload } from './gitInstall';
import { hookInstall, hookInstallPreview } from './hookInstall';
import { shellIntegrationInstall, shellIntegrationPreview } from './shellIntegration';
import { SettingsDialog } from './settingsDialog';
import { SetupWizard } from './setupWizard';
import { HookInstallDialog } from './hookInstallDialog';
import { moveItem, parseFavorites, samePath, type Favorite } from './favorites';
import { pinTarget } from './filesRouting';
import { layoutFromSnapshot, parseLayouts, upsertLayout, type NamedLayout } from './layouts';
import { mountBackdrop, type BackdropHandle } from './backdrop/backdrop';
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
  resolvePin,
  toPinPath,
  type Pin,
  type ReposFile,
} from './repos';
import type { RepoPinState } from './repoSection';
import { parseSavedWorkspace } from './savedWorkspace';
import { loadSessions, onHookEvent, onSessionsChanged, type Session } from './sessions';
import { showToast } from './toast';
import { trackCtrlHeld } from './ctrlHeld';
import { TabStrip } from './tabStrip';
import { closePadConfirm, closeTabConfirm, replaceConfirm } from './paneConfirm';
import type { PaneKind } from './paneKinds';
import { Workspace } from './workspace';
import { fontsReady } from './fontsReady';
import { checkForUpdate } from './updater';

trackCtrlHeld();

// Mounted first so the backdrop is already drawing while settings load.
let backdrop: BackdropHandle | undefined;
let colonySync: ColonySync | undefined;
try {
  backdrop = mountBackdrop(document.getElementById('backdrop') as HTMLCanvasElement);
  bindBackdropVisibility(backdrop);
  colonySync = new ColonySync(backdrop.colony);
} catch (err) {
  showToast(`Could not start the background animation: ${String(err)}`);
}

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

// Tracked here rather than read from the settings so quick repeated toggles don't act on a
// value the file watcher hasn't reported back yet.
let backdropAnimated = true;

function applyBackdropSettings(settings: Settings): void {
  backdrop?.setMaxFps(settings.backdrop.maxFps);
  backdrop?.setOptions(settings.backdrop);
  backdropAnimated = settings.backdrop.animate;
  backdrop?.setAnimated(backdropAnimated);
}

function toggleBackdrop(): void {
  backdropAnimated = !backdropAnimated;
  backdrop?.setAnimated(backdropAnimated);
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

let payload: SettingsPayload;
try {
  payload = await loadSettings();
} catch (err) {
  payload = { settings: DEFAULT_SETTINGS, warnings: [], firstRun: false };
  showToast(`Could not load settings, using defaults: ${String(err)}`);
}

applyBackdropSettings(payload.settings);
// Read by onAttention, so peekOnWaiting hot-reloads.
let currentSettings = payload.settings;
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

function updateFavorites(next: Favorite[]): void {
  favorites = next;
  panel.setFavorites(favorites);
  favoritesSave(favorites).catch((err: unknown) => showToast(`Could not save favorites: ${String(err)}`));
}

function addFavorite(path: string, profile?: string): void {
  if (favorites.some((f) => samePath(f.path, path))) return;
  updateFavorites([...favorites, { label: lastFolder(path) || path, path, ...(profile ? { profile } : {}) }]);
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

function updateLayouts(next: NamedLayout[]): void {
  layouts = next;
  panel.setLayouts(layouts);
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

// Design 4.6 Repo: the repo of the focused pane's folder, or of the last focused pane that had one.
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

function trackRepo(): void {
  const focused = workspace.panes().find((p) => p.focused);
  const folder = focused ? (focused.kind === 'terminal' ? focused.cwd : (focused.root ?? focused.folder)) : null;
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
      const same = currentRepo !== null && pathKey(currentRepo.root) === pathKey(info.root) && currentRepo.branch === info.branch;
      currentRepo = info;
      if (!same) void refreshPins();
    },
    (e: unknown) => {
      repoRoots.delete(pathKey(folder));
      console.warn('repo lookup failed:', e);
    },
  );
}

// A checkout in any shell moves the branch without a folder change, so re-read it while shown.
const BRANCH_REFRESH_MS = 3000;
window.setInterval(() => {
  if (repoFolder && currentRepo?.isGit && panel.isOpen() && document.visibilityState === 'visible') {
    lookUpRepo(repoFolder);
  }
}, BRANCH_REFRESH_MS);

function pinnedFolders(root: string): string[] {
  if (!pinRootsChecked.has(pathKey(root))) {
    void checkPins(root).then(() => workspace.pinsChanged());
    return [];
  }
  return repoPinStates(root)
    .filter((p) => p.isDir)
    .map((p) => p.absolute);
}

function updateRepos(next: ReposFile): void {
  if (next === repos) return;
  repos = next;
  renderRepo();
  workspace.pinsChanged();
  reposSave(repos).catch((err: unknown) => showToast(`Could not save pins: ${String(err)}`));
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

/** Design 4.6 Open menu and the Repo section's buttons: opens for the path's repo root. */
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
setKindMenuFilter(
  (kind) => kind !== 'containers' || (containers.available && currentSettings.containers.enabled),
);

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

const panel = new DashboardPanel(document.getElementById('dashboard') as HTMLElement, {
  onFocus: (paneId) => {
    const p = workspace.panes().find((x) => x.paneId === paneId);
    if (p?.collapsed) workspace.expandPane(paneId);
    else workspace.focusPane(paneId);
  },
  onClose: (paneId) => workspace.closePane(paneId),
  onCardDragStart: (paneId, e) => workspace.startDrag({ kind: 'pane', paneId }, e),
  onSwitchTab: (tabId) => workspace.switchTab(tabId),
  onSectionsChange: () => saver.schedule(),
  onWidthChange: () => saver.schedule(),
  onOpenContainers: (keys) => workspace.openContainers(keys),
  onStart: (row) => actOnContainerRow(row, 'start'),
  onStop: (row) => actOnContainerRow(row, 'stop'),
  onOpen: openFolder,
  onInstallHooks: () => {
    hookInstallPreview()
      .then((preview) => {
        if (preview.alreadyInstalled) showToast('Claude Code hooks are already installed.');
        else hookDialog.open(preview);
      })
      .catch((err: unknown) => showToast(`Could not prepare the hook install: ${String(err)}`));
  },
  onAdd: () => {
    const focused = workspace.terminals().find((t) => t.focused);
    if (!focused?.cwd) return;
    const profile = focused.profile !== currentSettings.shell.defaultProfile ? focused.profile : undefined;
    addFavorite(focused.cwd, profile);
  },
  onRename: (index, label) =>
    updateFavorites(favorites.map((f, i) => (i === index ? { ...f, label } : f))),
  onRemove: (index) => updateFavorites(favorites.filter((_, i) => i !== index)),
  onReorder: (from, to) => updateFavorites(moveItem(favorites, from, to)),
  onPromote: (path) => addFavorite(path),
  onDragStart: (path, e) => workspace.startDrag({ kind: 'folder', path }, e),
  onShowHelp: () => showHelp(),
  onShowSettings: () => showSettings(),
  onHide: () => focusTerminal(),
  onOpenLayout: (name) => openLayout(name),
  onSaveLayout: saveLayout,
  onRenameLayout: renameLayout,
  onRemoveLayout: (index) => updateLayouts(layouts.filter((_, i) => i !== index)),
  onOpenIn: openIn,
  onOpenPin: openPin,
  onRenamePin: (index, label) => currentRepo && updateRepos(renamePin(repos, currentRepo.root, index, label)),
  onRemovePin: (index) => currentRepo && updateRepos(removePin(repos, currentRepo.root, index)),
  onReorderPin: (from, to) => currentRepo && updateRepos(movePin(repos, currentRepo.root, from, to)),
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
const picker = new Picker({ onOpen: openFolder, onClose: focusTerminal });
const favoriteItems = (): PickerItem[] =>
  favorites.map((f) => ({ label: f.label, detail: f.path, value: f.path }));
const profilePicker = new Picker({ onOpen: openWithProfile, onClose: focusTerminal });
const profileItems = (): PickerItem[] => profiles.map((p) => ({ label: p.name, value: p.id }));
// A layout always opens as a new tab, so Ctrl+Enter has nothing to collapse.
const layoutPicker = new Picker({ onOpen: (name) => openLayout(name), onClose: focusTerminal });
const layoutItems = (): PickerItem[] =>
  layouts.map((l) => {
    const n = l.tab.panes.length;
    return { label: l.name, detail: `${n} ${n === 1 ? 'pane' : 'panes'}`, value: l.name };
  });
const confirmDialog = new ConfirmDialog();
const help = new HelpDialog({ onClose: focusTerminal });
const showHelp = (): void => help.open(helpSections(currentSettings.keybindings));
const settingsDialog = new SettingsDialog({
  onClose: focusTerminal,
  onSave: saveSetting,
  onOpenFile: openSettingsFile,
  getProfiles: () => profiles,
  onRunSetup: () => void showSetup(),
  onCheckForUpdates: () => void checkForUpdate({ manual: true, confirm: (o) => confirmDialog.open(o) }),
});
const showSettings = async (): Promise<void> => {
  await refreshProfiles();
  settingsDialog.open(latestPayload);
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
  installHooks: () =>
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
    ),
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
  const [preview, git, shellIntegration] = await Promise.all([
    hookInstallPreview().catch((e: unknown) => {
      console.warn('hook install state unavailable:', e);
      return null;
    }),
    gitInstallStatus().catch((e: unknown) => {
      console.warn('git install state unavailable:', e);
      return null;
    }),
    shellIntegrationPreview().catch((e: unknown) => {
      console.warn('shell integration state unavailable:', e);
      return null;
    }),
  ]);
  if (settingsDialog.isOpen()) settingsDialog.close();
  setupWizard.open({
    claudeDetected: preview?.claudeDetected ?? false,
    hooksInstalled: preview?.alreadyInstalled ?? false,
    // An unknown Git state skips the Git step rather than offering an install that may not apply.
    gitBashFound: git?.gitBashFound ?? true,
    wingetFound: git?.wingetFound ?? false,
    shellIntegration,
  });
};
// Opened before the first pane mounts so the pane fits the narrowed area and keeps focus.
panel.setContainersStore(containers);
panel.setContainersEnabled(payload.settings.containers.enabled);
void containers.start();
panel.setOpen(payload.settings.dashboard.visibleOnStart);

const workspace = new Workspace(document.getElementById('panes') as HTMLElement, payload, {
  onToggleDashboard: () => {
    panel.toggle();
    focusTerminal();
  },
  onOpenFavoritePicker: () => picker.open(favoriteItems(), 'Open a favorite folder'),
  onOpenProfilePicker: () => profilePicker.open(profileItems(), 'Split with a shell'),
  onOpenLayoutPicker: () => layoutPicker.open(layoutItems(), 'Open a layout'),
  onShowHelp: showHelp,
  onOpenSettings: showSettings,
  onToggleBackdrop: toggleBackdrop,
  onToggleFullscreen: toggleFullscreen,
  onAttention: (_paneId, cause) => {
    if (appWindow && !document.hasFocus()) {
      appWindow
        .requestUserAttention(UserAttentionType.Critical)
        .catch((e) => console.warn('taskbar flash failed:', e));
    }
    if (cause === 'waiting' && currentSettings.dashboard.peekOnWaiting && !panel.isOpen()) panel.peek();
  },
  onConfirmCloseTab: confirmCloseTab,
  onConfirmClosePane: confirmClosePane,
  onConfirmReplace: confirmReplace,
  onConfirm: (o) => confirmDialog.open(o),
  onDragHover: (pos) => tabStrip?.dragHover(pos),
  onPin: pinPath,
  onUnpin: unpinPath,
  getPinnedFolders: pinnedFolders,
  getRepoFolder: () => currentRepo?.root ?? null,
  containers,
});
const tabStrip: TabStrip | undefined = new TabStrip(
  document.getElementById('tab-strip') as HTMLElement,
  workspace,
  focusTerminal,
);
workspace.setSessions(sessions);
colonySync?.update(sessions);

const saver = new DebouncedSaver(
  () => ({
    ...workspace.snapshot(),
    collapsedSections: panel.collapsedSections(),
    dashboardWidth: panel.width(),
  }),
  workspaceSave,
  1000,
);
const refreshPanel = (): void => panel.update(workspace.panes(), workspace.tabs(), sessions);
workspace.onChange(() => {
  refreshPanel();
  trackRepo();
  saver.schedule();
});
// listen() rejects outside Tauri (plain `pnpm dev`); live updates are simply unavailable there.
onSessionsChanged((next) => {
  sessions = next;
  colonySync?.update(next);
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
onPtyActivity((list) => workspace.setActivity(list)).catch((e) => console.warn('activity sweep unavailable:', e));
onFavoritesChanged((raw) => {
  favorites = parseFavorites(raw);
  panel.setFavorites(favorites);
}).catch((e) => console.warn('favorites updates unavailable:', e));
onReposChanged((raw) => {
  repos = parseRepos(raw);
  pinRootsChecked.clear();
  void refreshPins();
}).catch((e) => console.warn('repos updates unavailable:', e));
onLayoutsChanged((raw) => {
  layouts = parseLayouts(raw);
  panel.setLayouts(layouts);
}).catch((e) => console.warn('layouts updates unavailable:', e));
// Also fires for close_window after the last pane closes, so an empty workspace is saved.
appWindow
  ?.onCloseRequested(async () => {
    await workspace.flushPanes();
    await saver.flush().catch((e) => console.warn('workspace save on close failed:', e));
  })
  .catch((e) => console.warn('close handling unavailable:', e));

let restored = false;
try {
  const saved = parseSavedWorkspace(await workspaceLoad());
  // Collapsed sections and the panel width apply even when restoring panes is switched off.
  if (saved) panel.setCollapsedSections(saved.collapsedSections);
  if (saved?.dashboardWidth !== undefined) panel.setWidth(saved.dashboardWidth);
  if (payload.settings.restore.enabled && saved && saved.tabs.length > 0) {
    workspace.restore(saved, { resumeClaude: payload.settings.restore.resumeClaude });
    restored = true;
  }
} catch (err) {
  showToast(`Could not restore the workspace: ${String(err)}`);
}
if (!restored) workspace.addPane();
trackRepo();
if (payload.firstRun) void showSetup();
void checkForUpdate({ manual: false, confirm: (o) => confirmDialog.open(o) });
onSettingsChanged((p) => {
  currentSettings = p.settings;
  latestPayload = p;
  settingsDialog.update(p);
  if (setupWizard.isOpen()) setupWizard.update(p.settings);
  applyBackdropSettings(p.settings);
  workspace.applySettings(p);
  panel.setContainersEnabled(p.settings.containers.enabled);
  void refreshProfiles().then(() => settingsDialog.update(latestPayload));
}).catch((e) => console.warn('settings hot reload unavailable:', e));
