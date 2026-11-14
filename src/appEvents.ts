// The core's events wired to the workspace and the dashboard: sessions and hooks, the pane CLI,
// file watchers, the window's close, and settings hot reload.
import type { getCurrentWindow } from '@tauri-apps/api/window';
import { onAgentContext } from './agentApi';
import type { AppDialogs } from './appDialogs';
import type { AppState } from './appState';
import { onBrowserChord } from './browserChords';
import { onCliCommand } from './cli';
import { runCliCommand, type CliTarget } from './cliDispatch';
import type { DashboardPanel } from './dashboardPanel';
import type { DebouncedSaver } from './debouncedSaver';
import { openInEditor } from './editors';
import { parseFavorites } from './favorites';
import type { FavoritesLayouts } from './favoritesLayouts';
import { setKeyHintBindings } from './keyHints';
import { parseLayouts } from './layouts';
import { onNotificationActivated } from './notificationsApi';
import { onFavoritesChanged, onGlobalPinsChanged, onLayoutsChanged, onPtyActivity, onReposChanged } from './persistence';
import { parseGlobalPins } from './globalPins';
import type { RepoTracker } from './repoTracker';
import { parseRepos } from './repos';
import { onSecondLaunch } from './secondLaunch';
import { onHookEvent, onSessionsChanged } from './sessions';
import { onSettingsChanged, type Settings } from './settings';
import { shipOverviewStore } from './shipOverviewStore';
import { needsYouStore } from './needsYouStore';
import { hideIdentity, hideKey } from './needsYouModel';
import { branchSizeStore } from './branchSizeStore';
import { onUsageChanged, usageSnapshot } from './usageApi';
import { toUsageWindows } from './usageModel';
import { cloudContextStore } from './cloudContextStore';
import type { Workspace } from './workspace';
import { onWorktreeCreated } from './worktreeApi';
import { onWorktreeCreatedEvent } from './worktreeNewFlow';

/** Notification ids for Needs you rows; every other id is a pane id. */
const NEEDS_PREFIX = 'needs:';
/** How often a usage window past its reset time is dropped without a new report. */
const USAGE_EXPIRY_MS = 60_000;
/** Separates the group from the hide key in a Needs you stable key (see stableKey). */
const FIELD_SEP = '\u001f';

export interface AppEventsDeps {
  state: AppState;
  workspace: Workspace;
  saver: Pick<DebouncedSaver<unknown>, 'schedule' | 'flush'>;
  refreshPanel: () => void;
  favorites: FavoritesLayouts;
  repo: RepoTracker;
  appWindow: ReturnType<typeof getCurrentWindow> | undefined;
}

// listen() rejects outside Tauri (plain `pnpm dev`); live updates are simply unavailable there.
export function listenAppEvents(deps: AppEventsDeps): void {
  const { state, workspace, saver, refreshPanel, favorites, repo, appWindow } = deps;
  cloudContextStore.applySettings(state.settings);
  cloudContextStore.subscribe(() => workspace.refreshStatuses());
  // Listen only: AgentContexts owns the core's tracking flag, so with the Panes and Needs you
  // sections both hidden no model arrives and a Copilot pane saves without resumeModel.
  onAgentContext((ctx) => workspace.setSessionModel(ctx.sessionId, ctx.model)).catch((e) =>
    console.warn('agent context updates unavailable:', e),
  );
  listenUsage();
  onSessionsChanged((next) => {
    state.sessions = next;
    workspace.setSessions(next);
    refreshPanel();
    saver.schedule();
  }).catch((e) => console.warn('session updates unavailable:', e));
  onHookEvent((ev) => {
    workspace.onHook(ev);
    // A finished turn is when an agent's edits settle, so the size is recounted then even if the
    // watcher's debounce is still holding the change.
    if (ev.hookEventName === 'Stop' || ev.hookEventName === 'Interrupt') {
      // The store matches folders as its consumers spelled them, and the hook's cwd may be spelled
      // differently from the pane's, so both are tried; the store's debounce folds the pair.
      const paneId = ev.paneId === null ? null : workspace.terminalForPty(ev.paneId);
      const paneFolder = workspace.agentTerminals().find((t) => t.paneId === paneId)?.folder ?? null;
      if (ev.cwd !== null) branchSizeStore.refresh(ev.cwd);
      if (paneFolder !== null) branchSizeStore.refresh(paneFolder);
    }
  }).catch((e) => console.warn('hook events unavailable:', e));
  const cliTarget: CliTarget = {
    terminalForPty: (ptyId) => workspace.terminalForPty(ptyId),
    anchorOn: (paneId) => workspace.anchorOn(paneId),
    showFiles: (req, opts) => workspace.showFiles(req, opts),
    showGit: (root, opts) => workspace.showGit(root, opts),
    showSearch: (root, query, opts) => workspace.showSearch(root, query, opts),
    openScratch: (text, opts) => workspace.openPane({ kind: 'scratch', text }, opts),
    openTerminal: (cwd, command, opts) =>
      command === undefined ? workspace.openTerminal(cwd, opts) : workspace.openTerminalWithCommand(cwd, command, opts),
    openInEditor: (path, line) => void openInEditor(path, line),
    openShip: (root) => workspace.openShip(root),
    openPorts: () => workspace.openPorts(),
    openContainers: () => workspace.openContainers(),
    openLocalBrowser: (url, paneId, opts) => workspace.openLocalBrowser(url, { ...opts, fromPaneId: paneId }),
  };
  onCliCommand((cmd) => runCliCommand(cmd, cliTarget)).catch((e) => console.warn('pane CLI unavailable:', e));
  onWorktreeCreated((ev) => onWorktreeCreatedEvent(workspace, ev)).catch((e) =>
    console.warn('bb worktree new panes unavailable:', e),
  );
  onBrowserChord((action) => workspace.runAction(action)).catch((e) =>
    console.warn('app keys in Local Browser pages unavailable:', e),
  );
  onSecondLaunch((folder) => {
    if (folder) workspace.newTab(folder);
  }).catch((e) => console.warn('second-launch handoff unavailable:', e));
  onNotificationActivated((id) => {
    if (id.startsWith(NEEDS_PREFIX)) {
      // Match on identity, not the full stable key: by the time the notification is clicked the
      // row may have moved group or gained a new state version, and it should still open.
      const key = id.slice(NEEDS_PREFIX.length);
      const wanted = hideIdentity(key.slice(key.indexOf(FIELD_SEP) + 1));
      const item = needsYouStore.items().find((i) => {
        const hk = hideKey(i);
        return hk !== null && hideIdentity(hk) === wanted;
      });
      if (item) needsYouStore.activate(item);
      return;
    }
    workspace.revealPane(id);
  }).catch((e) =>
    console.warn('notification clicks unavailable:', e),
  );
  onPtyActivity((list) => workspace.setActivity(list)).catch((e) => console.warn('activity sweep unavailable:', e));
  onFavoritesChanged((raw) => {
    state.favorites = parseFavorites(raw);
    favorites.showFavorites();
  }).catch((e) => console.warn('favorites updates unavailable:', e));
  onReposChanged((raw) => {
    repo.reload(parseRepos(raw));
    // A hand edit of primaryBranch changes every worktree row's comparison.
    workspace.reloadWorktrees();
  }).catch((e) => console.warn('repos updates unavailable:', e));
  onGlobalPinsChanged((raw) => repo.reloadGlobalPins(parseGlobalPins(raw))).catch((e) =>
    console.warn('global pins updates unavailable:', e),
  );
  onLayoutsChanged((raw) => {
    state.layouts = parseLayouts(raw);
    favorites.showLayouts();
  }).catch((e) => console.warn('layouts updates unavailable:', e));
  // Also fires for close_window after the last pane closes, so an empty workspace is saved.
  appWindow
    ?.onCloseRequested(async () => {
      await workspace.flushPanes();
      await workspace
        .saveScrollback(state.settings.restore.scrollback)
        .catch((e) => console.warn('scrollback save on close failed:', e));
      await saver.flush().catch((e) => console.warn('workspace save on close failed:', e));
    })
    .catch((e) => console.warn('close handling unavailable:', e));
}

/**
 * Usage windows feed the Needs you list (docs/design/sessions.md section 3.28). A report carries
 * the whole snapshot, so one that lands before the startup snapshot resolves supersedes it.
 */
function listenUsage(): void {
  let live = false;
  onUsageChanged((windows) => {
    live = true;
    needsYouStore.setUsage(toUsageWindows(windows));
  }).catch((e) => console.warn('usage updates unavailable:', e));
  usageSnapshot()
    .then((windows) => {
      if (!live) needsYouStore.setUsage(toUsageWindows(windows));
    })
    .catch((e) => console.warn('usage snapshot unavailable:', e));
  setInterval(() => needsYouStore.refresh(), USAGE_EXPIRY_MS);
}

export interface SettingsReloadDeps {
  state: AppState;
  workspace: Workspace;
  panel: DashboardPanel;
  dialogs: AppDialogs;
  applyBackdropSettings: (settings: Settings) => void;
  refreshProfiles: () => Promise<void>;
}

/** Settings hot reload: every holder of a setting takes the saved file's new values. */
export function listenSettingsChanges({
  state,
  workspace,
  panel,
  dialogs,
  applyBackdropSettings,
  refreshProfiles,
}: SettingsReloadDeps): void {
  onSettingsChanged((p) => {
    state.settings = p.settings;
    setKeyHintBindings(p.settings.keybindings);
    state.payload = p;
    dialogs.applySettings(p);
    applyBackdropSettings(p.settings);
    workspace.applySettings(p);
    shipOverviewStore.applySettings(p.settings);
    needsYouStore.setUsagePercent(p.settings.needsYou.usagePercent);
    branchSizeStore.applySettings(p.settings);
    cloudContextStore.applySettings(p.settings);
    panel.applyDashboardSettings(p.settings.dashboard, p.settings.localModels.minContext);
    void refreshProfiles().then(() => dialogs.profilesRefreshed());
  }).catch((e) => console.warn('settings hot reload unavailable:', e));
}
