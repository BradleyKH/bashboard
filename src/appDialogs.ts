// The app dialog (Help, Settings, Shortcuts, Accounts, CLI, and About tabs) and the setup wizard,
// with the hot-reload updates each one takes.
import { invoke } from '@tauri-apps/api/core';
import { AboutTab } from './aboutTab';
import { AccountsTab } from './accountsTab';
import { AppDialog } from './appDialog';
import { DIALOG_TAB_FOR_ACTION, type DialogTab } from './appDialogModel';
import type { AppState } from './appState';
import { pickBackdropImage } from './backdrop/image/imagePick';
import { CliTab } from './cliTab';
import type { ConfirmDialog } from './confirmDialog';
import { listEditors } from './editors';
import type { FavoritesLayouts } from './favoritesLayouts';
import type { ProviderKind } from './forgeApi';
import { gitInstall, gitInstallStatus, openGitDownload } from './gitInstall';
import { HelpTab } from './helpTab';
import type { HookOffer } from './hookOffer';
import { editKeybindings, openSettingsFile, saveSetting, type SettingsPayload } from './settings';
import { SettingsTab } from './settingsTab';
import { agentHooksFrom } from './setupModel';
import { SetupStatus } from './setupStatus';
import { SetupWizard } from './setupWizard';
import { shellIntegrationInstall, shellIntegrationPreview } from './shellIntegration';
import { shipOverviewStore } from './shipOverviewStore';
import { pinProvider } from './shipOverviewText';
import { ShortcutsTab } from './shortcutsTab';
import type { Workspace } from './workspace';

export interface AppDialogsDeps {
  state: AppState;
  workspace: () => Workspace;
  confirmDialog: ConfirmDialog;
  hooks: HookOffer;
  favorites: FavoritesLayouts;
  refreshProfiles: () => Promise<void>;
  focusTerminal: () => void;
  checkForUpdatesNow: () => void;
}

export class AppDialogs {
  private readonly shortcutsTab: ShortcutsTab;
  private readonly settingsTab: SettingsTab;
  private readonly helpTab: HelpTab;
  private readonly accountsTab: AccountsTab;
  private readonly appDialog: AppDialog;
  private readonly setupWizard: SetupWizard;

  constructor(private readonly deps: AppDialogsDeps) {
    const { state, confirmDialog, hooks, refreshProfiles } = deps;
    this.shortcutsTab = new ShortcutsTab({
      onEdit: editKeybindings,
      confirm: (o) => confirmDialog.open(o),
    });
    this.settingsTab = new SettingsTab({
      onSave: saveSetting,
      onOpenFile: openSettingsFile,
      getProfiles: () => state.profiles,
      onBrowse: pickBackdropImage,
    });
    this.helpTab = new HelpTab(
      new SetupStatus({
        getProfiles: () => state.profiles,
        getDefaultProfile: () => state.settings.shell.defaultProfile,
        installGit: () => gitInstall().then(refreshProfiles),
        openGitDownload: () => {
          openGitDownload().catch((e: unknown) => console.warn('open_url failed', e));
        },
        // The hook preview stacks over the dialog and hands focus back to it when it closes.
        installHooks: (agent) => hooks.install(agent).finally(() => this.appDialog.element?.focus()),
        onRunSetup: () => void this.showSetup(),
      }),
    );
    const cliTab = new CliTab();
    const aboutTab = new AboutTab({ onCheckForUpdates: deps.checkForUpdatesNow });
    this.accountsTab = new AccountsTab({
      // The dialog is modal, so close it first or the sign-in device code opens hidden behind it.
      onRunTerminal: (argv) => {
        this.appDialog.close();
        deps.workspace().openPane({ kind: 'terminal', command: argv });
      },
      onOpenUrl: (url) => void invoke('open_url', { url }).catch((e: unknown) => console.warn('open_url failed', e)),
      confirm: (o) => confirmDialog.open(o),
      known: () => this.knownForgeRepos(),
    });
    this.appDialog = new AppDialog(
      {
        help: {
          mount: (host) => this.helpTab.mount(host, state.settings.keybindings),
          unmount: () => this.helpTab.unmount(),
          show: () => this.helpTab.show(),
        },
        settings: {
          mount: (host) => this.settingsTab.mount(host, state.payload),
          unmount: () => this.settingsTab.unmount(),
        },
        shortcuts: {
          mount: (host) => this.shortcutsTab.mount(host, this.appDialog.element!, state.settings.keybindings),
          unmount: () => this.shortcutsTab.unmount(),
          hide: () => this.shortcutsTab.hide(),
          onKey: (e) => this.shortcutsTab.onKey(e),
        },
        accounts: this.accountsTab,
        cli: cliTab,
        about: aboutTab,
      },
      {
        onClose: deps.focusTerminal,
        tabForKey: (e) => {
          const action = deps.workspace().keyAction(e);
          return action ? (DIALOG_TAB_FOR_ACTION[action.type] ?? null) : null;
        },
      },
    );
    this.setupWizard = new SetupWizard({
      onClose: deps.focusTerminal,
      onSave: saveSetting,
      getSettings: () => state.settings,
      getProfiles: () => state.profiles,
      getEditors: listEditors,
      getFavorites: () => state.favorites,
      addFavorites: (list) => {
        if (list.length > 0) deps.favorites.updateFavorites([...state.favorites, ...list]);
      },
      installHooks: hooks.install,
      getHookState: () => hooks.detectedPreviews().then(agentHooksFrom),
      installGit: () => gitInstall().then(refreshProfiles),
      openGitDownload: () => {
        openGitDownload().catch((e: unknown) => console.warn('open_url failed', e));
      },
      getShellIntegrationPreview: shellIntegrationPreview,
      installShellIntegration: shellIntegrationInstall,
    });
  }

  /**
   * Where the user has code to read, for the Accounts tab's detection of cards in use: Overview pins
   * (the resolved repo when a pin has polled, else its host's name) and open Ship panes' hosts, plus
   * the folders of open terminals. Deduplicated; a pin on a host that can't be told apart is left out.
   */
  private knownForgeRepos(): { hosts: { provider: ProviderKind; host: string }[]; dirs: string[]; repos: string[] } {
    const found = this.deps.workspace().knownForgeSources();
    const hosts = [...found.hosts];
    for (const entry of shipOverviewStore.rows()) {
      const repo = entry.row?.overview.repo;
      const known = repo ? { provider: repo.provider, host: repo.host } : pinProvider(entry.pin.repo);
      if (known) hosts.push(known);
    }
    const seen = new Set<string>();
    return {
      hosts: hosts.filter((h) => {
        const key = `${h.provider} ${h.host.toLowerCase()}`;
        return seen.has(key) ? false : (seen.add(key), true);
      }),
      dirs: [...new Set(found.dirs)],
      repos: [...new Set(found.repos)],
    };
  }

  async open(tab: DialogTab): Promise<void> {
    // The settings tab's shell fields list only the shells installed now.
    if (tab === 'settings' || tab === 'help') await this.deps.refreshProfiles();
    this.appDialog.open(tab);
  }

  openAccounts(host: string | null, opts?: { openTokenForm?: boolean; org?: string }): void {
    void this.open('accounts').then(() => {
      if (host) this.accountsTab.focusHost(host, opts);
    });
  }

  async showSetup(): Promise<void> {
    await this.deps.refreshProfiles();
    const [previews, git] = await Promise.all([
      this.deps.hooks.detectedPreviews().catch((e: unknown) => {
        console.warn('hook install state unavailable:', e);
        return [];
      }),
      gitInstallStatus().catch((e: unknown) => {
        console.warn('git install state unavailable:', e);
        return null;
      }),
    ]);
    this.appDialog.close();
    this.setupWizard.open({
      agents: agentHooksFrom(previews),
      // An unknown Git state skips the Git step rather than offering an install that may not apply.
      gitBashFound: git?.gitBashFound ?? true,
      wingetFound: git?.wingetFound ?? false,
    });
  }

  /** A settings hot reload: the tabs and the wizard show the new values and warnings. */
  applySettings(p: SettingsPayload): void {
    this.settingsTab.update(p);
    this.helpTab.update(p.settings.keybindings);
    if (this.setupWizard.isOpen()) this.setupWizard.update(p.settings);
    this.shortcutsTab.update(p.settings.keybindings);
  }

  /** Redraws the settings tab once the shell list has been read again. */
  profilesRefreshed(): void {
    this.settingsTab.update(this.deps.state.payload);
  }
}
