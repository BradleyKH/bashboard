// The repo of the focused pane's folder, or of the last focused pane that had one, and the pins
// repos.json lists for it: the dashboard's Pins section, the Files panes' pin buttons, and the Open
// menu (docs/design/dashboard.md section 4.6). Also the global command pins from pins.json, which
// list for every repo and run in the focused pane's folder.
import type { AppState } from './appState';
import { CommandPinDialog, type CommandPinValues } from './commandPinDialog';
import { openContextMenu } from './contextMenu';
import { item } from './contextMenuModel';
import type { DashboardPanel } from './dashboardPanel';
import { openInEditor } from './editors';
import { pinTarget } from './filesRouting';
import {
  addGlobalPin,
  alphabetizedGlobalPins,
  editGlobalPin,
  globalPinName,
  moveGlobalPin,
  removeGlobalPin,
  type GlobalPin,
  type GlobalPinsFile,
} from './globalPins';
import { globalPinsSave, reposSave } from './persistence';
import type { FolderlessLaunchKind, LaunchKind } from './launchModel';
import { setOpenMenuGitProbe } from './openMenu';
import { Picker, type PickerItem } from './picker';
import { folderName, type GlobalPinState, type RepoPinState } from './pinsSection';
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

/** Keyed by the repo it ran for, so a run in one repo leaves the row unlit in another. */
function globalKey(root: string, pin: GlobalPin): string {
  return `global\n${pathKey(root)}\n${pin.command}`;
}

export class RepoTracker {
  private repo: RepoInfo | null = null;
  private repoFolder: string | null = null;
  private repoPins: RepoPinState[] = [];
  private globalPinStates: GlobalPinState[] = [];
  private readonly repoRoots = new Map<string, Promise<RepoInfo>>();
  /** Whether each pinned path is a folder, or null when it no longer exists; keyed by lowercased path. */
  private readonly pinKinds = new Map<string, boolean | null>();
  /** Roots whose pins have been looked up since repos.json last changed. */
  private readonly pinRootsChecked = new Set<string>();
  /** The terminal each command pin last typed into, keyed by `commandKey`, for its running mark. */
  private readonly commandPanes = new Map<string, string>();
  private readonly pinDialog = new CommandPinDialog();
  private readonly pinPicker: Picker;
  /** The terminal folder the pin picker is open for, and the repo it resolved to. */
  private pickerTarget: { folder: string; root: string | null } | null = null;
  /** The terminal's selection when the pin picker opened, to prefill "+ Add". */
  private pickerSelection = '';
  private readonly filesPinPicker: Picker;
  /** The Files pane the files pin picker is open for: its repo root, folder, and how to show a pin in it. */
  private filesPickerTarget: { root: string; folder: string; show: (folder: string, select?: string) => void } | null =
    null;

  constructor(private readonly deps: RepoTrackerDeps) {
    setOpenMenuGitProbe((path) => this.cachedRepoRoot(path).then((r) => r.isGit, () => false));
    this.pinPicker = new Picker(
      { onOpen: (value) => this.runPickedPin(value), onClose: deps.focusTerminal },
      {
        action: {
          kind: 'run',
          label: '+ Add',
          title: 'Pin a command in this folder',
          enabled: () => true,
          run: () => {
            const folder = this.pickerTarget?.folder ?? null;
            this.pinPicker.close();
            this.newCommandPin(folder, this.pickerSelection);
          },
        },
      },
    );
    this.filesPinPicker = new Picker(
      { onOpen: (value) => this.openPickedPath(value), onClose: deps.focusTerminal },
      {
        action: {
          kind: 'run',
          label: '+ Add',
          title: 'Pin the folder this pane shows',
          enabled: () => {
            const t = this.filesPickerTarget;
            return t !== null && !this.isPathPinned(t.root, t.folder);
          },
          run: () => {
            const t = this.filesPickerTarget;
            if (t) this.pinPath(t.root, t.folder, true);
            this.refreshFilesPinPicker();
          },
        },
        manage: {
          noun: 'pin',
          rename: (value, name) => {
            const t = this.filesPickerTarget;
            if (t) void this.updateRepos(renamePin(this.deps.state.repos, t.root, Number(value), name));
            this.refreshFilesPinPicker();
          },
          remove: (value) => {
            const t = this.filesPickerTarget;
            if (t) void this.updateRepos(removePin(this.deps.state.repos, t.root, Number(value)));
            this.refreshFilesPinPicker();
          },
        },
      },
    );
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

  private workingPanes(): Set<string> {
    return new Set(
      this.deps
        .workspace()
        .panes()
        .filter((p) => p.kind === 'terminal' && p.shell.status === 'working')
        .map((p) => p.paneId),
    );
  }

  private globalStates(root: string | null): GlobalPinState[] {
    // With no repo yet, render runs during startup before the workspace exists, so skip the panes.
    if (root === null) return this.deps.state.globalPins.map((pin) => ({ pin, running: false }));
    const working = this.workingPanes();
    return this.deps.state.globalPins.map((pin) => {
      const paneId = this.commandPanes.get(globalKey(root, pin));
      return { pin, running: paneId !== undefined && working.has(paneId) };
    });
  }

  private repoPinStates(root: string): RepoPinState[] {
    const working = this.workingPanes();
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
    const globals = this.globalStates(this.repo.root);
    if (
      next.some((p, i) => (p.running ?? false) !== (this.repoPins[i]?.running ?? false)) ||
      globals.some((g, i) => g.running !== this.globalPinStates[i]?.running)
    ) {
      this.render();
    }
  }

  render(): void {
    this.repoPins = this.repo ? this.repoPinStates(this.repo.root) : [];
    this.globalPinStates = this.globalStates(this.repo?.root ?? null);
    this.deps.panel().setRepo({ repo: this.repo, pins: this.repoPins, globalPins: this.globalPinStates });
  }

  /** Takes a pins.json read from disk. */
  reloadGlobalPins(next: GlobalPinsFile): void {
    this.deps.state.globalPins = next;
    this.render();
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
    return reposSave(state.repos).catch((err: unknown) => {
      showToast(`Could not save repos.json: ${String(err)}`);
    });
  }

  private updateGlobalPins(next: GlobalPinsFile): void {
    const { state } = this.deps;
    if (next === state.globalPins) return;
    state.globalPins = next;
    this.render();
    globalPinsSave(next).catch((err: unknown) => showToast(`Could not save pins.json: ${String(err)}`));
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
    const target = folder ?? this.currentFolder();
    // A selection spanning lines is one command wrapped by the terminal; joined, it stays one line.
    const initial: CommandPinValues = {
      label: '',
      command: selection.replace(/\s*[\r\n]+\s*/g, ' ').trim(),
      scope: 'repo',
    };
    if (!target) {
      // With no folder to pin to, the popup offers only a global pin.
      void this.pinDialog.open({ title: 'New pin', folder: null, isGit: false, initial }).then((values) => {
        if (values) this.updateGlobalPins(addGlobalPin(this.deps.state.globalPins, values.label, values.command));
      });
      return;
    }
    this.cachedRepoRoot(target).then(
      async ({ root, isGit }) => {
        const values = await this.pinDialog.open({ title: 'New pin', folder: target, isGit, initial });
        if (values) this.saveNewPin(values, root, target);
      },
      (err: unknown) => showToast(`Could not pin a command in ${target}: ${String(err)}`),
    );
  };

  /**
   * A terminal's pin button (docs/design/terminal.md section 4.4): its repo's command pins, then
   * the global ones, to run in that terminal's folder; "+ Add" opens the new pin popup.
   */
  readonly openPinPicker = (anchor: HTMLElement, folder: string | null, selection: string): void => {
    this.openRunPicker(anchor, folder, selection, false);
  };

  /**
   * The dashboard top bar's pin button while the Pins section is hidden (docs/design/dashboard.md
   * section 4.6): every pin of the focused pane's repo, files and folders too, then the global ones.
   */
  readonly openDashboardPinPicker = (anchor: HTMLElement): void => {
    this.openRunPicker(anchor, this.currentFolder(), '', true);
  };

  private openRunPicker(anchor: HTMLElement, folder: string | null, selection: string, withPaths: boolean): void {
    this.pickerSelection = selection;
    const show = (root: string | null): void => {
      this.pickerTarget = folder ? { folder, root } : null;
      this.pinPicker.open(this.pinPickerItems(root, withPaths), withPaths ? 'Open a pin' : 'Run a pin', anchor);
    };
    if (!folder) {
      show(null);
      return;
    }
    this.cachedRepoRoot(folder).then(
      async ({ root }) => {
        if (withPaths && !this.pinRootsChecked.has(pathKey(root))) await this.checkPins(root);
        show(root);
      },
      () => show(null),
    );
  }

  /** The repo's pins in their order, then the global ones alphabetized, keyed `repo:<index>` and `global:<index>`. */
  private pinPickerItems(root: string | null, withPaths: boolean): PickerItem[] {
    const repoItems: PickerItem[] = root
      ? pinsFor(this.deps.state.repos, root).flatMap((pin, index): PickerItem[] => {
          if (isCommandPin(pin)) {
            return [{ label: pin.label ?? pin.command, detail: pin.command, value: `repo:${index}`, category: 'Repo' }];
          }
          return withPaths ? this.pathPinItem(root, pin, `repo:${index}`) : [];
        })
      : [];
    const globalItems = alphabetizedGlobalPins(this.deps.state.globalPins).map(({ pin, index }) => ({
      label: globalPinName(pin),
      detail: pin.command,
      value: `global:${index}`,
      category: 'Global',
    }));
    return [...repoItems, ...globalItems];
  }

  /** A file or folder pin's picker row, or none while its path is missing or not yet looked up. */
  private pathPinItem(root: string, pin: Pin, value: string): PickerItem[] {
    const absolute = resolvePin(root, pin);
    const kind = this.pinKinds.get(pathKey(absolute));
    if (kind === null || kind === undefined) return [];
    const name = pin.path === '.' ? folderName(absolute) : pin.path;
    return [{ label: pin.label ?? name, detail: pin.path, value, category: kind ? 'Folder' : 'File' }];
  }

  /**
   * A Files pane's pin button (docs/design/files.md section 4.12): the file and folder pins of the
   * repo at `root`, shown in that pane when chosen; "+ Add" pins the folder it shows.
   */
  readonly openFilesPinPicker = (
    anchor: HTMLElement,
    root: string,
    folder: string,
    show: (folder: string, select?: string) => void,
  ): void => {
    this.filesPickerTarget = { root, folder, show };
    const open = (): void => this.filesPinPicker.open(this.pathPinItems(root), 'Open a pin', anchor);
    if (this.pinRootsChecked.has(pathKey(root))) open();
    else void this.checkPins(root).then(open);
  };

  private refreshFilesPinPicker(): void {
    const t = this.filesPickerTarget;
    if (t) this.filesPinPicker.setItems(this.pathPinItems(t.root));
  }

  private isPathPinned(root: string, absolute: string): boolean {
    return pinsFor(this.deps.state.repos, root).some(
      (pin) => !isCommandPin(pin) && pathKey(resolvePin(root, pin)) === pathKey(absolute),
    );
  }

  /** The root's file and folder pins that exist, keyed by their index in its list. */
  private pathPinItems(root: string): PickerItem[] {
    return pinsFor(this.deps.state.repos, root).flatMap((pin, index) =>
      isCommandPin(pin) ? [] : this.pathPinItem(root, pin, String(index)),
    );
  }

  private openPickedPath(value: string): void {
    const t = this.filesPickerTarget;
    if (!t) return;
    const pin = pinsFor(this.deps.state.repos, t.root)[Number(value)];
    if (!pin || isCommandPin(pin)) return;
    const absolute = resolvePin(t.root, pin);
    const target = pinTarget(t.root, absolute, this.pinKinds.get(pathKey(absolute)) === true);
    t.show(target.folder, target.select);
  }

  /**
   * Runs a pin chosen in the pin picker in the folder it opened for; a file or folder pin opens in
   * a Files pane.
   */
  private runPickedPin(value: string): void {
    const target = this.pickerTarget;
    const [scope, at] = value.split(':');
    const index = Number(at);
    if (scope === 'global') {
      const pin = this.deps.state.globalPins[index];
      if (!pin) return;
      if (!target) {
        showToast('Open a terminal in a folder to run a global pin there');
        return;
      }
      this.typeCommand(globalKey(target.root ?? target.folder, pin), target.folder, pin.command);
      return;
    }
    if (!target?.root) return;
    const { root } = target;
    const pin = pinsFor(this.deps.state.repos, root)[index];
    if (!pin) return;
    const absolute = resolvePin(root, pin);
    if (isCommandPin(pin)) {
      this.runCommandPin(root, absolute, pin);
      return;
    }
    const t = pinTarget(root, absolute, this.pinKinds.get(pathKey(absolute)) === true);
    this.deps.workspace().showFiles({ root, folder: t.folder, select: t.select });
  }

  /** Where a new pin and a global pin's run go: the focused pane's folder, else the last one with a folder. */
  private currentFolder(): string | null {
    return this.focusedFolder() ?? this.repoFolder;
  }

  /** Adds a pin from the popup to the repo's list or the global one, as its scope says. */
  private saveNewPin(values: CommandPinValues, root: string, folder: string): void {
    if (values.scope === 'global') {
      this.updateGlobalPins(addGlobalPin(this.deps.state.globalPins, values.label, values.command));
      return;
    }
    this.pinKinds.set(pathKey(folder), true);
    const pin: Pin = {
      path: toPinPath(root, folder),
      ...(values.label ? { label: values.label } : {}),
      command: values.command,
    };
    void this.updateRepos(addPin(this.deps.state.repos, root, pin));
  }

  /** A command pin's pencil, F2, or Edit: the popup with its values, replaced in place. */
  editCommandPin(index: number): void {
    const repo = this.repo;
    const state = this.repoPins[index];
    if (!repo || !state || !isCommandPin(state.pin)) return;
    const { pin } = state;
    void this.pinDialog
      .open({
        title: 'Edit pin',
        folder: state.absolute,
        isGit: repo.isGit,
        initial: { label: pin.label ?? '', command: pin.command, scope: 'repo' },
      })
      .then((values) => {
        if (!values || this.repo !== repo) return;
        // The list may have changed while the popup was open, so find the pin again.
        const at = pinsFor(this.deps.state.repos, repo.root).findIndex((p) => samePin(p, pin));
        if (at < 0) return;
        if (values.scope === 'global') {
          this.updateGlobalPins(addGlobalPin(this.deps.state.globalPins, values.label, values.command));
          void this.updateRepos(removePin(this.deps.state.repos, repo.root, at));
          return;
        }
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
    this.typeCommand(commandKey(root, pin), absolute, pin.command);
  }

  /** Types `command` into the focused terminal when it is idle in `folder`, else into a new one there. */
  private typeCommand(key: string, folder: string, command: string): void {
    const workspace = this.deps.workspace();
    const focused = workspace.panes().find((p) => p.focused);
    const terminal = focused?.kind === 'terminal' ? focused : null;
    // A busy terminal would hand the text to its running program, not to the shell.
    const busy = terminal !== null && workspace.busyPanes().some((p) => p.paneId === terminal.paneId);
    let paneId: string | undefined;
    if (terminal && !busy && terminal.cwd !== null && pathKey(terminal.cwd) === pathKey(folder)) {
      paneId = terminal.paneId;
      workspace.pasteIntoTerminal(paneId, command);
    } else {
      paneId = workspace.openTerminalWithPaste(folder, command, { profile: terminal?.profile });
    }
    if (paneId !== undefined) this.commandPanes.set(key, paneId);
    this.deps.focusTerminal();
  }

  /** A global pin's row, the top bar's pin menu, or the palette: types it in the focused pane's folder. */
  readonly runGlobalPin = (pin: GlobalPin): void => {
    const folder = this.currentFolder();
    if (!folder) {
      showToast('Open a terminal in a folder to run a global pin there');
      return;
    }
    this.typeCommand(globalKey(this.repo?.root ?? folder, pin), folder, pin.command);
  };

  runGlobalPinAt(index: number): void {
    const pin = this.deps.state.globalPins[index];
    if (pin) this.runGlobalPin(pin);
  }

  removeGlobalPin(index: number): void {
    this.updateGlobalPins(removeGlobalPin(this.deps.state.globalPins, index));
  }

  moveGlobalPin(from: number, to: number): void {
    this.updateGlobalPins(moveGlobalPin(this.deps.state.globalPins, from, to));
  }

  /**
   * A global pin's pencil, F2, or Edit: the popup with its values. Choosing This repo moves it into
   * the current repo's list, running in the folder the popup shows.
   */
  editGlobalPin(index: number): void {
    const pin = this.deps.state.globalPins[index];
    if (!pin) return;
    const folder = this.currentFolder();
    const open = (target: { root: string; folder: string; isGit: boolean } | null): void => {
      void this.pinDialog
        .open({
          title: 'Edit pin',
          folder: target?.folder ?? null,
          isGit: target?.isGit ?? false,
          initial: { label: pin.label ?? '', command: pin.command, scope: 'global' },
        })
        .then((values) => {
          if (!values) return;
          // The list may have changed while the popup was open, so find the pin again.
          const at = this.deps.state.globalPins.findIndex((p) => p.command === pin.command);
          if (at < 0) return;
          if (values.scope === 'global' || !target) {
            this.updateGlobalPins(editGlobalPin(this.deps.state.globalPins, at, values.label, values.command));
            return;
          }
          this.updateGlobalPins(removeGlobalPin(this.deps.state.globalPins, at));
          this.saveNewPin(values, target.root, target.folder);
        });
    };
    if (!folder) {
      open(null);
      return;
    }
    this.cachedRepoRoot(folder).then(
      ({ root, isGit }) => open({ root, folder, isGit }),
      () => open(null),
    );
  }

  /** The top bar's pin button, shown while the Pins section leaves out global pins: each one by name. */
  readonly openGlobalPinsMenu = (anchor: HTMLElement): void => {
    const sorted = alphabetizedGlobalPins(this.deps.state.globalPins);
    const entries =
      sorted.length === 0
        ? [item('No global pins', () => {}, { enabled: false })]
        : sorted.map(({ pin }) => item(globalPinName(pin), () => this.runGlobalPin(pin)));
    openContextMenu(entries, { anchorEl: anchor, align: 'left' });
  };

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
