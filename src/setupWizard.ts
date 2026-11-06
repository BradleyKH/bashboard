import './setupWizard.css';
import { agentName, isPreviewAgent } from './agentNames';
import type { Editor } from './editors';
import { samePath, type Favorite } from './favorites';
import { forgeRepo } from './forgeApi';
import type { ShellProfile } from './profiles';
import type { AgentId } from './savedWorkspace';
import { repoCandidates } from './repoCandidates';
import type { Settings } from './settings';
import { renderGitStep } from './setupGitStep';
import { renderLookStep } from './setupLookStep';
import {
  editorChoices,
  effectiveProfile,
  favoritesToAdd,
  pinsToAdd,
  setupSteps,
  type AgentHooks,
  type AutoColors,
  type Choice,
  type SetupStep,
  type SetupStepOptions,
  type SetupStepUi,
} from './setupModel';
import { renderShellIntegrationStep } from './setupShellIntegrationStep';
import { repoId } from './shipOverviewModel';
import { shipOverviewStore } from './shipOverviewStore';
import {
  isIntegrationShell,
  type IntegrationShell,
  type ShellIntegrationPreview,
} from './shellIntegration';

export interface SetupWizardCallbacks {
  /** Closed by Escape, Skip setup, or Done; the caller refocuses the terminal. */
  onClose(): void;
  onSave(path: string[], value: unknown): Promise<void>;
  getSettings(): Settings;
  getProfiles(): ShellProfile[];
  getEditors(): Promise<Editor[]>;
  getFavorites(): Favorite[];
  addFavorites(list: Favorite[]): void;
  /** Runs the agent's install with its confirmation; resolves when that closes, true if installed. */
  installHooks(agent: AgentId): Promise<boolean>;
  /** Re-read after Git installs, since the hook install's contents depend on Git Bash. */
  getHookState(): Promise<AgentHooks[]>;
  /** Installs Git and refreshes the shell profiles; rejects with the installer's error. */
  installGit(): Promise<void>;
  openGitDownload(): void;
  getShellIntegrationPreview(shell: IntegrationShell): Promise<ShellIntegrationPreview>;
  installShellIntegration(shell: IntegrationShell): Promise<void>;
}

export interface SetupWizardOpenOptions {
  agents: AgentHooks[];
  gitBashFound: boolean;
  wingetFound: boolean;
}

type BaseStepOptions = Omit<SetupStepOptions, 'defaultShell' | 'shellIntegrationStatus'>;

interface Repo {
  name: string;
  path: string;
}

/** How many repos resolve their remote at once; each runs git. */
const RESOLVE_PARALLEL = 4;

const STEP_TEXT: Record<SetupStep, { title: string; intro: string }> = {
  git: { title: 'Git', intro: 'Install Git for Windows, which brings Git Bash.' },
  shell: { title: 'Shell', intro: 'The shell new panes open with.' },
  shellIntegration: { title: 'Shell integration', intro: "A few lines in your shell's startup file that report each prompt to the app." },
  editor: { title: 'Editor', intro: 'Where files and folders open from the Files pane, the Git pane, and search.' },
  favorites: { title: 'Favorites', intro: 'The repos you work in, one click away in the dashboard.' },
  agents: { title: 'Coding agents', intro: 'Let the dashboard follow your coding agent sessions.' },
  look: { title: 'Look', intro: 'The background behind the panes, and the colors the app draws with.' },
};

/** First-run setup, one choice per step, each saved as it is made (docs/design.md section 4.17). */
export class SetupWizard {
  private backdrop: HTMLElement | null = null;
  private box!: HTMLElement;
  private counter!: HTMLElement;
  private title!: HTMLElement;
  private intro!: HTMLElement;
  private content!: HTMLElement;
  private error!: HTMLElement;
  private back!: HTMLButtonElement;
  private next!: HTMLButtonElement;
  private steps: SetupStep[] = [];
  private index = 0;
  /** Resyncs the shown step's selection from the settings; null for steps with nothing to sync. */
  private refresh: ((s: Settings) => void) | null = null;

  /** Null until the list arrives; a failed read leaves just the default app. */
  private editors: Editor[] | null = null;
  private editorsFailed = false;

  private folder = '';
  /** Null while listing. */
  private repos: Repo[] | null = null;
  private repoError = '';
  private repoSeq = 0;
  /** The folder last sent to repoCandidates, so a blur without an edit does not list again. */
  private listedFolder: string | null = null;
  private checked = new Set<string>();
  private added: string[] = [];
  /** Listed repo path to its Ship pin identity, for the repos on a supported code host. */
  private pinnable = new Map<string, string>();
  private pinOn = false;

  private hooksDone = new Set<AgentId>();
  /** The agent whose install is running. */
  private installing: AgentId | null = null;

  private base!: BaseStepOptions;
  private wingetFound = false;
  private gitInstalling = false;
  private gitDone = false;
  /** Per shell; absent while it is read, null when it could not be. */
  private previews = new Map<IntegrationShell, ShellIntegrationPreview | null>();
  private shellInstalling = false;
  private shellDone = new Set<IntegrationShell>();
  /** The shell just picked in the Shell step, until the settings file catches up. */
  private pickedProfile: string | null = null;
  private autoColors: AutoColors = { accent: false };

  private readonly ui: SetupStepUi = {
    note: (text) => this.note(text),
    button: (text, onClick) => this.button(text, onClick),
  };

  constructor(private readonly callbacks: SetupWizardCallbacks) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(opts: SetupWizardOpenOptions): void {
    if (this.backdrop) this.close();
    this.base = {
      agents: opts.agents,
      gitBashFound: opts.gitBashFound,
    };
    this.wingetFound = opts.wingetFound;
    this.gitInstalling = false;
    this.gitDone = false;
    this.previews = new Map();
    this.shellInstalling = false;
    this.shellDone = new Set();
    this.pickedProfile = null;
    this.autoColors = { accent: false };
    this.steps = setupSteps(this.stepOptions());
    this.index = 0;
    this.editors = null;
    this.editorsFailed = false;
    this.folder = '';
    this.repos = null;
    this.repoError = '';
    this.listedFolder = null;
    this.checked = new Set();
    this.added = [];
    this.pinnable = new Map();
    this.pinOn = false;
    this.hooksDone = new Set();
    this.installing = null;

    const backdrop = document.createElement('div');
    backdrop.className = 'setup-wizard-backdrop';
    // A first-run wizard should not vanish on a stray click, so outside clicks do nothing.
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) e.preventDefault();
    });

    const box = document.createElement('div');
    box.className = 'setup-wizard';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'setup-wizard-title');
    box.addEventListener('keydown', (e) => this.onKey(e));
    this.box = box;

    const header = document.createElement('div');
    header.className = 'setup-wizard-header';
    this.counter = document.createElement('div');
    this.counter.className = 'setup-wizard-counter';
    this.title = document.createElement('h2');
    this.title.id = 'setup-wizard-title';
    this.intro = document.createElement('p');
    this.intro.className = 'setup-wizard-intro';
    header.append(this.counter, this.title, this.intro);

    this.content = document.createElement('div');
    this.content.className = 'setup-wizard-content';

    this.error = document.createElement('div');
    this.error.className = 'setup-wizard-error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;

    box.append(header, this.content, this.error, this.footer());
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;

    this.show(0);
    box.focus();
    void this.loadEditors(backdrop);
    void this.listRepos(undefined, backdrop);
    // Each installed shell's file is read up front, so switching shells in the Shell step shows
    // the right lines at once. PowerShell has to start to report its profile path, which takes
    // a moment, hence in the background.
    for (const p of this.callbacks.getProfiles()) {
      if (isIntegrationShell(p.id)) void this.loadPreview(p.id, backdrop);
    }
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
    this.refresh = null;
  }

  /** Reflects a reloaded settings file in the shown step, leaving typed input alone. */
  update(settings: Settings): void {
    if (!this.backdrop) return;
    this.pickedProfile = null;
    this.refresh?.(settings);
    this.syncSteps();
  }

  /** The shell new panes open with, as the step list sees it. */
  private defaultShell(): string | null {
    const saved = this.pickedProfile ?? this.callbacks.getSettings().shell.defaultProfile;
    return effectiveProfile(saved, this.callbacks.getProfiles().map((p) => p.id));
  }

  private stepOptions(): SetupStepOptions {
    const shell = this.defaultShell();
    let status: SetupStepOptions['shellIntegrationStatus'] = null;
    if (shell !== null && isIntegrationShell(shell)) {
      const preview = this.previews.get(shell);
      status = preview === undefined ? 'loading' : (preview?.status ?? null);
    }
    return { ...this.base, defaultShell: shell, shellIntegrationStatus: status };
  }

  private async loadPreview(shell: IntegrationShell, owner: HTMLElement): Promise<void> {
    let preview: ShellIntegrationPreview | null;
    try {
      preview = await this.callbacks.getShellIntegrationPreview(shell);
    } catch (err) {
      console.warn(`shell integration state for ${shell} unavailable:`, err);
      preview = null;
    }
    if (this.backdrop !== owner) return;
    this.previews.set(shell, preview);
    this.syncSteps();
    this.rerender('shellIntegration');
  }

  private footer(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'setup-wizard-footer';

    const skip = this.button('Skip setup', () => this.finish());
    skip.classList.add('setup-wizard-skip');
    this.back = this.button('Back', () => this.show(this.index - 1));
    this.next = this.button('Next', () => {
      if (this.index >= this.steps.length - 1) this.finish();
      else this.show(this.index + 1);
    });
    this.next.classList.add('setup-wizard-primary');

    const nav = document.createElement('div');
    nav.className = 'setup-wizard-nav';
    nav.append(this.back, this.next);
    footer.append(skip, nav);
    return footer;
  }

  private show(index: number): void {
    if (!this.backdrop || index < 0 || index >= this.steps.length) return;
    const moved = index !== this.index;
    this.index = index;
    const step = this.steps[index];
    this.showChrome();
    this.setError('');
    this.refresh = null;
    this.content.replaceChildren();
    if (step === 'git') this.renderGit();
    else if (step === 'shell') this.renderShell();
    else if (step === 'shellIntegration') this.renderShellIntegration();
    else if (step === 'editor') this.renderEditor();
    else if (step === 'favorites') this.renderFavorites();
    else if (step === 'agents') this.renderAgents();
    else this.renderLook();
    if (moved) this.box.focus();
  }

  /** The header and footer for the shown step, which depend on the step list too. */
  private showChrome(): void {
    const step = this.steps[this.index];
    this.counter.textContent = `Step ${this.index + 1} of ${this.steps.length}`;
    this.title.textContent = STEP_TEXT[step].title;
    this.intro.textContent = STEP_TEXT[step].intro;
    this.back.disabled = this.index === 0;
    this.next.textContent = this.index === this.steps.length - 1 ? 'Done' : 'Next';
  }

  private rerender(step: SetupStep): void {
    if (this.backdrop && this.steps[this.index] === step) {
      const active = document.activeElement;
      const focusedId = active && this.content.contains(active) ? active.id || null : undefined;
      const caret = active instanceof HTMLInputElement ? [active.selectionStart, active.selectionEnd] : null;
      this.show(this.index);
      if (focusedId === undefined) return;
      const again = focusedId ? document.getElementById(focusedId) : null;
      if (again && this.content.contains(again)) {
        again.focus();
        if (caret && again instanceof HTMLInputElement && caret[0] !== null) {
          again.setSelectionRange(caret[0], caret[1]);
        }
      } else this.box.focus();
    }
  }

  /**
   * Recomputes the step list after something changes what applies. The shown step stays as it
   * is, with only the counter updated, so a choice made in it keeps its focus; if the shown step
   * dropped out, the one now in its place shows.
   */
  private syncSteps(): void {
    if (!this.backdrop) return;
    const was = this.index;
    const current = this.steps[was];
    const next = setupSteps(this.stepOptions());
    if (next.join() === this.steps.join()) return;
    this.steps = next;
    const at = next.indexOf(current);
    if (at >= 0) {
      this.index = at;
      this.showChrome();
    } else {
      // -1 so show() counts it as a move and takes focus off the removed step's content.
      this.index = -1;
      this.show(Math.min(was, next.length - 1));
    }
  }

  private renderGit(): void {
    renderGitStep(
      this.content,
      { wingetFound: this.wingetFound, installing: this.gitInstalling, done: this.gitDone },
      this.ui,
      { install: () => void this.installGit(), openDownload: () => this.callbacks.openGitDownload() },
    );
  }

  private async installGit(): Promise<void> {
    if (this.gitInstalling) return;
    const owner = this.backdrop;
    this.gitInstalling = true;
    this.rerender('git');
    let failure = '';
    try {
      await this.callbacks.installGit();
    } catch (err) {
      failure = errorText(err);
    }
    let preview: ShellIntegrationPreview | null = null;
    let agents: AgentHooks[] | null = null;
    if (!failure) {
      [preview, agents] = await Promise.all([
        this.callbacks.getShellIntegrationPreview('gitBash').catch(() => null),
        this.callbacks.getHookState().catch(() => null),
      ]);
    }
    this.gitInstalling = false;
    if (this.backdrop !== owner) return;
    if (failure) {
      this.rerender('git');
      if (this.steps[this.index] === 'git') this.setError(failure);
    } else {
      this.gitDone = true;
      this.previews.set('gitBash', preview);
      this.base = { ...this.base, ...(agents ? { agents } : {}), gitInstalled: true };
      this.syncSteps();
      this.rerender('git');
    }
    if (this.steps[this.index] === 'git') this.box.focus();
  }

  private renderShellIntegration(): void {
    const shell = this.defaultShell();
    if (shell === null || !isIntegrationShell(shell)) return;
    const preview = this.previews.get(shell);
    // Null hides the step; this render only happens in the moment before the list catches up.
    if (preview === null) return;
    renderShellIntegrationStep(
      this.content,
      { shell, preview, installing: this.shellInstalling, done: this.shellDone.has(shell) },
      this.ui,
      () => void this.installShellIntegration(shell),
    );
  }

  private async installShellIntegration(shell: IntegrationShell): Promise<void> {
    if (this.shellInstalling) return;
    const owner = this.backdrop;
    this.shellInstalling = true;
    this.rerender('shellIntegration');
    let failure = '';
    try {
      await this.callbacks.installShellIntegration(shell);
    } catch (err) {
      failure = errorText(err);
    }
    this.shellInstalling = false;
    if (this.backdrop !== owner) return;
    if (!failure) this.shellDone.add(shell);
    this.rerender('shellIntegration');
    if (failure && this.steps[this.index] === 'shellIntegration') this.setError(failure);
    this.box.focus();
  }

  private renderShell(): void {
    const profiles = this.callbacks.getProfiles();
    if (profiles.length === 0) {
      this.content.append(this.note('No shells were found.'));
      return;
    }
    const choices = profiles.map((p) => ({ value: p.id, label: p.name }));
    // The shell integration step follows this choice, so the step count can change here.
    this.radioList(choices, ['shell', 'defaultProfile'], (s) => s.shell.defaultProfile, (id) => {
      this.pickedProfile = id;
      this.syncSteps();
    });
  }

  private renderEditor(): void {
    if (!this.editors) {
      this.content.append(this.note('Looking for editors...'));
      return;
    }
    const saved = this.callbacks.getSettings().editor.preferred;
    this.radioList(editorChoices(this.editors, saved), ['editor', 'preferred'], (s) => s.editor.preferred);
    if (this.editorsFailed) this.content.append(this.note('The installed editors could not be listed.'));
  }

  private async loadEditors(owner: HTMLElement): Promise<void> {
    let found: Editor[];
    try {
      found = await this.callbacks.getEditors();
      this.editorsFailed = false;
    } catch {
      found = [];
      this.editorsFailed = true;
    }
    if (this.backdrop !== owner) return;
    this.editors = found;
    this.rerender('editor');
  }

  /** One radio per choice; picking one saves `path`, and a failure shows the file's value again. */
  private radioList(
    choices: Choice[],
    path: string[],
    read: (s: Settings) => string,
    onPick?: (value: string) => void,
  ): void {
    const list = document.createElement('div');
    list.className = 'setup-wizard-choices';
    list.setAttribute('role', 'radiogroup');
    const name = `setup-wizard-${path.join('-')}`;
    const inputs: HTMLInputElement[] = [];
    const sync = (s: Settings) => {
      const current = read(s);
      for (const input of inputs) input.checked = input.value === current;
    };
    for (const choice of choices) {
      const label = document.createElement('label');
      label.className = 'setup-wizard-choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = choice.value;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.save(path, choice.value, () => {
          const s = this.callbacks.getSettings();
          sync(s);
          onPick?.(read(s));
        });
        onPick?.(choice.value);
      });
      inputs.push(input);
      const text = document.createElement('span');
      text.textContent = choice.label;
      label.append(input, text);
      list.append(label);
    }
    this.content.append(list);
    sync(this.callbacks.getSettings());
    this.refresh = sync;
  }

  private renderFavorites(): void {
    const field = document.createElement('div');
    field.className = 'setup-wizard-folder';
    const label = document.createElement('label');
    label.htmlFor = 'setup-wizard-folder';
    label.textContent = 'Folder';
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'setup-wizard-folder';
    input.className = 'setup-wizard-input';
    input.spellcheck = false;
    input.value = this.folder;
    input.placeholder = 'C:\\Users\\you\\source\\repos';
    input.addEventListener('input', () => (this.folder = input.value));
    input.addEventListener('blur', () => {
      if (input.value.trim() !== this.listedFolder) void this.listRepos(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.listRepos(input.value);
      }
    });
    field.append(label, input);
    this.content.append(field);

    if (this.repoError) {
      const err = this.note(this.repoError);
      err.classList.add('setup-wizard-error');
      this.content.append(err);
      return;
    }
    if (this.repos === null) {
      this.content.append(this.note('Looking for git repos...'));
      return;
    }
    if (this.listedFolder === '') {
      this.content.append(this.note('Enter a folder to list the git repos in it.'));
      return;
    }
    if (this.repos.length === 0) {
      this.content.append(this.note('No git repos were found in that folder.'));
      return;
    }

    const favorites = this.callbacks.getFavorites();
    const isFavorite = (path: string) =>
      favorites.some((f) => samePath(f.path, path)) || this.added.some((p) => samePath(p, path));
    const list = document.createElement('div');
    list.className = 'setup-wizard-repos';
    // The pin choice is offered only when some listed repo is on a host Ship can read.
    const offerPin = this.pinnable.size > 0;
    const add = this.button('Add to favorites', () => {
      const paths = this.repos?.filter((r) => this.checked.has(r.path)).map((r) => r.path) ?? [];
      const list = favoritesToAdd(paths, this.callbacks.getFavorites());
      if (list.length > 0) this.callbacks.addFavorites(list);
      if (offerPin && this.pinOn) {
        const pins = pinsToAdd(paths, this.pinnable, (repo) => shipOverviewStore.isPinned(repo));
        if (pins.length > 0) {
          shipOverviewStore.pinAll(pins).catch((err: unknown) => this.setError(`Could not pin: ${errorText(err)}`));
        }
      }
      this.added.push(...paths);
      this.checked.clear();
      this.rerender('favorites');
    });
    add.classList.add('setup-wizard-primary');
    const syncAdd = () => {
      add.disabled = ![...this.checked].some((p) => !isFavorite(p));
      const pinning = offerPin && this.pinOn && [...this.checked].some((p) => !isFavorite(p) && this.pinnable.has(p));
      add.textContent = pinning ? 'Add and pin' : 'Add to favorites';
    };

    for (const repo of this.repos) {
      const already = isFavorite(repo.path);
      const row = document.createElement('label');
      row.className = 'setup-wizard-repo';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = already || this.checked.has(repo.path);
      box.disabled = already;
      box.addEventListener('change', () => {
        if (box.checked) this.checked.add(repo.path);
        else this.checked.delete(repo.path);
        syncAdd();
      });
      const text = document.createElement('span');
      text.className = 'setup-wizard-repo-text';
      const name = document.createElement('span');
      name.className = 'setup-wizard-repo-name';
      name.textContent = repo.name;
      const path = document.createElement('span');
      path.className = 'setup-wizard-repo-path';
      path.textContent = repo.path;
      text.append(name, path);
      row.append(box, text);
      if (already) {
        const tag = document.createElement('span');
        tag.className = 'setup-wizard-repo-tag';
        tag.textContent = 'already a favorite';
        row.append(tag);
      }
      list.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'setup-wizard-actions';
    actions.append(add);
    this.content.append(list);
    if (offerPin) {
      const pin = document.createElement('label');
      pin.className = 'setup-wizard-choice';
      const pinBox = document.createElement('input');
      pinBox.type = 'checkbox';
      pinBox.id = 'setup-wizard-pin';
      pinBox.checked = this.pinOn;
      pinBox.addEventListener('change', () => {
        this.pinOn = pinBox.checked;
        syncAdd();
      });
      const pinText = document.createElement('span');
      pinText.textContent = 'Also pin them to the Ship Overview, for pull request and pipeline alerts';
      pin.append(pinBox, pinText);
      this.content.append(
        pin,
        this.note('Only repos on a supported code host (GitHub, GitLab, Bitbucket, or Azure DevOps) are pinned. Private ones need a sign-in, which the dashboard and the Ship Overview ask for.'),
      );
    }
    syncAdd();
    this.content.append(actions);
  }

  /** Finds which listed repos Ship can pin, for the latest listing only. */
  private async resolvePinnable(seq: number, owner: HTMLElement | null): Promise<void> {
    this.pinnable = new Map();
    const queue = [...(this.repos ?? [])];
    const found = new Map<string, string>();
    const worker = async (): Promise<void> => {
      for (let repo = queue.shift(); repo !== undefined; repo = queue.shift()) {
        if (seq !== this.repoSeq || this.backdrop !== owner) return;
        try {
          found.set(repo.path, repoId(await forgeRepo(repo.path)));
        } catch {
          // No remote, or not on a supported host; it simply is not pinnable.
        }
      }
    };
    await Promise.all(Array.from({ length: RESOLVE_PARALLEL }, worker));
    if (seq !== this.repoSeq || this.backdrop !== owner || found.size === 0) return;
    this.pinnable = found;
    this.rerender('favorites');
  }

  /** Lists the repos under `raw`, or under the core's default folder when `raw` is undefined. */
  private async listRepos(raw: string | undefined, owner: HTMLElement | null = this.backdrop): Promise<void> {
    const dir = raw?.trim();
    const seq = ++this.repoSeq;
    this.listedFolder = dir ?? null;
    this.repoError = '';
    this.checked.clear();
    if (dir === '') {
      this.repos = [];
      this.rerender('favorites');
      return;
    }
    this.repos = null;
    this.rerender('favorites');
    try {
      const result = await repoCandidates(dir);
      if (seq !== this.repoSeq || this.backdrop !== owner) return;
      this.repos = result.repos;
      if (dir === undefined) {
        this.folder = result.dir ?? '';
        this.listedFolder = this.folder;
      }
      void this.resolvePinnable(seq, owner);
    } catch (err) {
      if (seq !== this.repoSeq || this.backdrop !== owner) return;
      this.repos = [];
      this.repoError = errorText(err);
    }
    this.rerender('favorites');
  }

  private renderAgents(): void {
    this.content.append(
      this.note(
        "Each agent's hooks tell this app when a session is working, waiting for you, or done, so the dashboard and the pane borders can show it.",
      ),
      this.note(
        "The install adds a hook script and entries in the agent's hook config, and shows them for confirmation first. Sessions outside this app's panes are not affected.",
      ),
    );
    for (const { agent, installed, update, trust } of this.base.agents) {
      const name = agentName(agent);
      const row = document.createElement('div');
      row.className = 'setup-wizard-actions';
      const label = document.createElement('span');
      label.textContent = isPreviewAgent(agent) ? `${name} (preview)` : name;
      row.append(label);
      const done = this.hooksDone.has(agent);
      if (installed || done) {
        const status = document.createElement('span');
        status.className = 'setup-wizard-done';
        status.textContent =
          agent === 'codex' && (done || trust === 'untrusted')
            ? 'Hooks installed; Codex will ask you to trust them on its next start'
            : 'Hooks installed';
        row.append(status);
      } else {
        if (update) {
          const status = document.createElement('span');
          status.textContent = 'Hook script out of date';
          row.append(status);
        }
        const install = this.button(`${update ? 'Update' : 'Install'} ${name} hooks`, () => void this.install(agent));
        install.classList.add('setup-wizard-primary');
        install.disabled = this.installing !== null;
        row.append(install);
      }
      this.content.append(row);
    }
  }

  private async install(agent: AgentId): Promise<void> {
    if (this.installing !== null) return;
    const owner = this.backdrop;
    this.installing = agent;
    this.rerender('agents');
    let installed = false;
    let failure = '';
    try {
      installed = await this.callbacks.installHooks(agent);
    } catch (err) {
      failure = errorText(err);
    }
    this.installing = null;
    if (this.backdrop !== owner) return;
    if (installed) this.hooksDone.add(agent);
    this.rerender('agents');
    if (failure && this.steps[this.index] === 'agents') this.setError(failure);
    // The hook dialog's own close path is replaced by the caller's callback, so nothing else
    // takes focus back.
    this.box.focus();
  }

  private renderLook(): void {
    this.refresh = renderLookStep(this.content, {
      ui: this.ui,
      getSettings: () => this.callbacks.getSettings(),
      save: (path, value, revert) => this.save(path, value, revert),
      autoColors: { get: () => this.autoColors, set: (next) => (this.autoColors = next) },
    });
  }

  /** Saves one value; a failure shows inline, then `revert` shows the file's value again. */
  private save(path: string[], value: unknown, revert: () => void): void {
    this.setError('');
    const owner = this.backdrop;
    const step = this.steps[this.index];
    let pending: Promise<void>;
    try {
      pending = this.callbacks.onSave(path, value);
    } catch (err) {
      pending = Promise.reject(err);
    }
    pending.catch((err: unknown) => {
      if (this.backdrop !== owner || this.steps[this.index] !== step) return;
      this.setError(errorText(err));
      revert();
    });
  }

  private finish(): void {
    this.close();
    this.callbacks.onClose();
  }

  private setError(message: string): void {
    this.error.textContent = message;
    this.error.hidden = message === '';
  }

  private note(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'setup-wizard-note';
    p.textContent = text;
    return p;
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'setup-wizard-button';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.finish();
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
