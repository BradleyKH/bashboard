// The repo of the focused pane's folder, or of the last focused pane that had one, and the pins
// repos.json lists for it: the dashboard's Pins section, the Files panes' pin buttons, and the Open
// menu (docs/design/dashboard.md section 4.6).
import type { AppState } from './appState';
import { CommandPinDialog } from './commandPinDialog';
import type { DashboardPanel } from './dashboardPanel';
import { openInEditor } from './editors';
import { pinTarget } from './filesRouting';
import { reposSave } from './persistence';
import type { FolderlessLaunchKind, LaunchKind } from './launchModel';
import { setOpenMenuGitProbe } from './openMenu';
import type { RepoPinState } from './pinsSection';
import { fsList, repoRoot, type RepoInfo } from './repoFiles';
import {
  addPin,
  editCommandPin,
  isCommandPin,
  movePin,
  pinsFor,
  removePin,
  renamePin,
  resolvePin,
  samePin,
  setPrimaryBranch,
  toPinPath,
  type Pin,
  type ReposFile,
} from './repos';
import { showToast } from './toast';
import type { Workspace } from './workspace';

export interface RepoTrackerDeps {
  state: AppState;
  workspace: () => Workspace;
  panel: () => DashboardPanel;
  focusTerminal: () => void;
}

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

function commandKey(root: string, pin: Pin): string {
  return `${pathKey(root)}\n${pathKey(pin.path)}\n${pin.command ?? ''}`;
}

export class RepoTracker {
  private repo: RepoInfo | null = null;
  private repoFolder: string | null = null;
  private repoPins: RepoPinState[] = [];
  private readonly repoRoots = new Map<string, Promise<RepoInfo>>();
  /** Whether each pinned path is a folder, or null when it no longer exists; keyed by lowercased path. */
  private readonly pinKinds = new Map<string, boolean | null>();
  /** Roots whose pins have been looked up since repos.json last changed. */
  private readonly pinRootsChecked = new Set<string>();
  /** The terminal each command pin last typed into, keyed by `commandKey`, for its running mark. */
  private readonly commandPanes = new Map<string, string>();
  private readonly pinDialog = new CommandPinDialog();

  constructor(private readonly deps: RepoTrackerDeps) {
    setOpenMenuGitProbe((path) => this.cachedRepoRoot(path).then((r) => r.isGit, () => false));
  }

  get currentRepo(): RepoInfo | null {
    return this.repo;
  }

  /** The current repo's pins as last rendered. */
  get pins(): RepoPinState[] {
    return this.repoPins;
  }

  cachedRepoRoot(folder: string): Promise<RepoInfo> {
    const key = pathKey(folder);
    let p = this.repoRoots.get(key);
    if (!p) {
      p = repoRoot(folder);
      this.repoRoots.set(key, p);
      p.catch(() => this.repoRoots.delete(key));
    }
    return p;
  }

  /** Looks up whether each of the root's pins exists and is a folder, one listing per parent. */
  private async checkPins(root: string): Promise<void> {
    this.pinRootsChecked.add(pathKey(root));
    const absolutes = pinsFor(this.deps.state.repos, root).map((pin) => resolvePin(root, pin));
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
        this.pinKinds.set(pathKey(abs), (await listing).get(name) ?? null);
      }),
    );
  }

  private repoPinStates(root: string): RepoPinState[] {
    const working = new Set(
      this.deps
        .workspace()
        .panes()
        .filter((p) => p.kind === 'terminal' && p.shell.status === 'working')
        .map((p) => p.paneId),
    );
    return pinsFor(this.deps.state.repos, root).map((pin) => {
      const absolute = resolvePin(root, pin);
      const kind = this.pinKinds.get(pathKey(absolute));
      const state: RepoPinState = { pin, absolute, exists: kind !== null && kind !== undefined, isDir: kind === true };
      if (isCommandPin(pin)) {
        const paneId = this.commandPanes.get(commandKey(root, pin));
        state.running = paneId !== undefined && working.has(paneId);
      }
      return state;
    });
  }

  /** Redraws when a command pin's terminal starts or stops a command, or closes. */
  private syncRunning(): void {
    if (this.commandPanes.size === 0) return;
    const live = new Set(this.deps.workspace().panes().map((p) => p.paneId));
    for (const [key, paneId] of this.commandPanes) if (!live.has(paneId)) this.commandPanes.delete(key);
    if (!this.repo) return;
    const next = this.repoPinStates(this.repo.root);
    if (next.some((p, i) => (p.running ?? false) !== (this.repoPins[i]?.running ?? false))) this.render();
  }

  render(): void {
    this.repoPins = this.repo ? this.repoPinStates(this.repo.root) : [];
    this.deps.panel().setRepo({ repo: this.repo, pins: this.repoPins });
  }

  /** Re-checks the current repo's pins, then redraws the section and the Files panes' pin buttons. */
  async refreshPins(): Promise<void> {
    const repo = this.repo;
    if (repo) await this.checkPins(repo.root);
    if (repo !== this.repo) return;
    this.render();
    this.deps.workspace().pinsChanged();
  }

  /** Takes a repos.json read from disk; every root's pins are looked up again. */
  reload(next: ReposFile): void {
    this.deps.state.repos = next;
    this.pinRootsChecked.clear();
    void this.refreshPins();
  }

  focusedFolder(): string | null {
    const focused = this.deps.workspace().panes().find((p) => p.focused);
    return focused ? ((focused.kind === 'terminal' ? focused.cwd : (focused.root ?? focused.folder)) ?? null) : null;
  }

  track(): void {
    this.syncRunning();
    const folder = this.focusedFolder();
    if (!folder || (this.repoFolder !== null && pathKey(folder) === pathKey(this.repoFolder))) return;
    this.repoFolder = folder;
    this.lookUpRepo(folder);
  }

  /** Reads the folder's repo fresh rather than cached, since the branch changes with every checkout. */
  private lookUpRepo(folder: string): void {
    const p = repoRoot(folder);
    this.repoRoots.set(pathKey(folder), p);
    p.then(
      (info) => {
        if (this.repoFolder !== folder) return;
        const same =
          this.repo !== null && pathKey(this.repo.root) === pathKey(info.root) && this.repo.isGit === info.isGit;
        this.repo = info;
        if (!same) void this.refreshPins();
      },
      (e: unknown) => {
        this.repoRoots.delete(pathKey(folder));
        console.warn('repo lookup failed:', e);
      },
    );
  }

  readonly pinnedFolders = (root: string): string[] => {
    if (!this.pinRootsChecked.has(pathKey(root))) {
      void this.checkPins(root).then(() => this.deps.workspace().pinsChanged());
      return [];
    }
    return this.repoPinStates(root)
      .filter((p) => p.isDir && !isCommandPin(p.pin))
      .map((p) => p.absolute);
  };

  /** Resolves once repos.json is written (or failed to be), for callers whose next read goes through the core. */
  private updateRepos(next: ReposFile): Promise<void> {
    const { state } = this.deps;
    if (next === state.repos) return Promise.resolve();
    state.repos = next;
    this.render();
    this.deps.workspace().pinsChanged();
    return reposSave(state.repos).catch((err: unknown) => showToast(`Could not save repos.json: ${String(err)}`));
  }

  readonly pinPath = (root: string, absolute: string, isDir: boolean): void => {
    this.pinKinds.set(pathKey(absolute), isDir);
    void this.updateRepos(addPin(this.deps.state.repos, root, { path: toPinPath(root, absolute) }));
  };

  readonly unpinPath = (root: string, absolute: string): void => {
    const { repos } = this.deps.state;
    const index = pinsFor(repos, root).findIndex(
      (pin) => !isCommandPin(pin) && pathKey(resolvePin(root, pin)) === pathKey(absolute),
    );
    if (index >= 0) void this.updateRepos(removePin(repos, root, index));
  };

  renamePin(index: number, label: string): void {
    if (this.repo) void this.updateRepos(renamePin(this.deps.state.repos, this.repo.root, index, label));
  }

  removePin(index: number): void {
    if (this.repo) void this.updateRepos(removePin(this.deps.state.repos, this.repo.root, index));
  }

  movePin(from: number, to: number): void {
    if (this.repo) void this.updateRepos(movePin(this.deps.state.repos, this.repo.root, from, to));
  }

  setPrimaryBranch(root: string, branch: string | null): Promise<void> {
    return this.updateRepos(setPrimaryBranch(this.deps.state.repos, root, branch));
  }

  /**
   * The Pins heading's "+" (no folder: the focused pane's) and a terminal's New pin
   * (docs/design/dashboard.md section 4.6). The pin goes under the folder's repo root.
   */
  readonly newCommandPin = (folder?: string | null, selection = ''): void => {
    const target = folder ?? this.focusedFolder() ?? this.repoFolder;
    if (!target) {
      showToast('Open a terminal in a folder to pin a command there');
      return;
    }
    this.cachedRepoRoot(target).then(
      async ({ root }) => {
        const values = await this.pinDialog.open({
          title: 'New pin',
          folder: target,
          // A selection spanning lines is one command wrapped by the terminal; joined, it stays one line.
          initial: { label: '', command: selection.replace(/\s*[\r\n]+\s*/g, ' ').trim() },
        });
        if (!values) return;
        this.pinKinds.set(pathKey(target), true);
        const pin: Pin = {
          path: toPinPath(root, target),
          ...(values.label ? { label: values.label } : {}),
          command: values.command,
        };
        void this.updateRepos(addPin(this.deps.state.repos, root, pin));
      },
      (err: unknown) => showToast(`Could not pin a command in ${target}: ${String(err)}`),
    );
  };

  /** A command pin's pencil, F2, or Edit: the popup with its values, replaced in place. */
  editCommandPin(index: number): void {
    const repo = this.repo;
    const state = this.repoPins[index];
    if (!repo || !state || !isCommandPin(state.pin)) return;
    const { pin } = state;
    void this.pinDialog
      .open({ title: 'Edit pin', folder: state.absolute, initial: { label: pin.label ?? '', command: pin.command } })
      .then((values) => {
        if (!values || this.repo !== repo) return;
        // The list may have changed while the popup was open, so find the pin again.
        const at = pinsFor(this.deps.state.repos, repo.root).findIndex((p) => samePin(p, pin));
        if (at < 0) return;
        const key = commandKey(repo.root, pin);
        const paneId = this.commandPanes.get(key);
        if (paneId !== undefined) {
          this.commandPanes.delete(key);
          this.commandPanes.set(commandKey(repo.root, { ...pin, command: values.command }), paneId);
        }
        void this.updateRepos(editCommandPin(this.deps.state.repos, repo.root, at, values.label, values.command));
      });
  }

  /**
   * Types a command pin's command without Enter (docs/design/dashboard.md section 4.6): into the
   * focused terminal when it is idle in the pin's folder, else into a new one opened there.
   */
  private runCommandPin(root: string, absolute: string, pin: Pin & { command: string }): void {
    const workspace = this.deps.workspace();
    const focused = workspace.panes().find((p) => p.focused);
    const terminal = focused?.kind === 'terminal' ? focused : null;
    // A busy terminal would hand the text to its running program, not to the shell.
    const busy = terminal !== null && workspace.busyPanes().some((p) => p.paneId === terminal.paneId);
    let paneId: string | undefined;
    if (terminal && !busy && terminal.cwd !== null && pathKey(terminal.cwd) === pathKey(absolute)) {
      paneId = terminal.paneId;
      workspace.pasteIntoTerminal(paneId, pin.command);
    } else {
      paneId = workspace.openTerminalWithPaste(absolute, pin.command, { profile: terminal?.profile });
    }
    if (paneId !== undefined) this.commandPanes.set(commandKey(root, pin), paneId);
    this.deps.focusTerminal();
  }

  readonly openPin = (pin: Pin): void => {
    if (!this.repo) return;
    const root = this.repo.root;
    // The section keeps rows from an earlier render while its content is unchanged, so match by value.
    const state = this.repoPins.find((p) => samePin(p.pin, pin));
    if (!state?.exists) return;
    if (isCommandPin(state.pin)) {
      this.runCommandPin(root, state.absolute, state.pin);
      return;
    }
    const t = pinTarget(root, state.absolute, state.isDir ?? false);
    this.deps.workspace().showFiles({ root, folder: t.folder, select: t.select });
  };

  /** Design 4.6 Open menu and Launch: opens for the path's repo root. */
  readonly openIn = (kind: Exclude<LaunchKind, FolderlessLaunchKind> | 'editor', path: string): void => {
    this.cachedRepoRoot(path).then(
      ({ root, isGit }) => {
        const workspace = this.deps.workspace();
        if (kind === 'git' || kind === 'ship') {
          if (!isGit) showToast(`${path} is not in a git repo`);
          else if (kind === 'git') workspace.showGit(root);
          else workspace.openPane({ kind: 'ship', root });
        } else if (kind === 'search') {
          workspace.showSearch(root);
        } else if (kind === 'terminal') {
          workspace.openTerminal(root);
          this.deps.focusTerminal();
        } else if (kind === 'files') {
          workspace.showFiles({ root, folder: root });
        } else {
          void openInEditor(root);
        }
      },
      (err: unknown) => showToast(`Could not open ${path}: ${String(err)}`),
    );
  };
}
