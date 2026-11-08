// The repo of the focused pane's folder, or of the last focused pane that had one, and the pins
// repos.json lists for it: the dashboard's Pins section, the Files panes' pin buttons, and the Open
// menu (docs/design/dashboard.md section 4.6).
import type { AppState } from './appState';
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
  movePin,
  pinsFor,
  removePin,
  renamePin,
  resolvePin,
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

export class RepoTracker {
  private repo: RepoInfo | null = null;
  private repoFolder: string | null = null;
  private repoPins: RepoPinState[] = [];
  private readonly repoRoots = new Map<string, Promise<RepoInfo>>();
  /** Whether each pinned path is a folder, or null when it no longer exists; keyed by lowercased path. */
  private readonly pinKinds = new Map<string, boolean | null>();
  /** Roots whose pins have been looked up since repos.json last changed. */
  private readonly pinRootsChecked = new Set<string>();

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
    return pinsFor(this.deps.state.repos, root).map((pin) => {
      const absolute = resolvePin(root, pin);
      const kind = this.pinKinds.get(pathKey(absolute));
      return { pin, absolute, exists: kind !== null && kind !== undefined, isDir: kind === true };
    });
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
      .filter((p) => p.isDir)
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
    const index = pinsFor(repos, root).findIndex((pin) => pathKey(resolvePin(root, pin)) === pathKey(absolute));
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

  readonly openPin = (pin: Pin): void => {
    if (!this.repo) return;
    const root = this.repo.root;
    // The section keeps rows from an earlier render while its content is unchanged, so match by path.
    const state = this.repoPins.find((p) => p.pin.path === pin.path);
    if (!state?.exists) return;
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
