import { invoke } from '@tauri-apps/api/core';
import './shipPane.css';
import type { ConfirmOptions } from './confirmDialog';
import { openContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import { copyText } from './copyText';
import { samePath } from './favorites';
import { ShipAccountChip } from './shipAccountChip';
import { asForgeError, forgeFixPrompt, type ForgeError, type ProviderKind, type PullRequest, type Run } from './forgeApi';
import { accountMenuItems, pullMenuItems, runMenuItems, type RunActionKey } from './shipMenus';
import { finishToast, noticeFor, prNounOf, pullLimitNote, type ShipTab } from './shipModel';
import { ShipNotice } from './shipNotice';
import { ShipOverview } from './shipOverview';
import { shipOverviewStore } from './shipOverviewStore';
import { ShipPinButton } from './shipPinButton';
import { ShipPullList } from './shipPullList';
import { ShipRunList } from './shipRunList';
import { ShipStore, type BranchScope } from './shipStore';
import { ShipTabStrip } from './shipTabStrip';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import { cancelRunConfirm } from './paneConfirm';
import type { PaneView } from './paneView';
import { repoRoot, type RepoInfo } from './repoFiles';
import type { Settings } from './settings';
import { showToast } from './toast';

export interface ShipPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  /**
   * The repo root or a folder inside it (the pane adopts the resolved root), or `remote:<repo>`
   * for a pinned repo with no clone; null opens on the Overview.
   */
  root: string | null;
  /** Whether the pane starts on screen; the store is polled only while it is. */
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The root, tab, branch scope, or pull request filter changed (title and saved state follow). */
  onChange: () => void;
  /** Asks before cancelling a run; resolves true to go ahead. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Runs `argv` (a sign-in or install command) in a terminal split off this pane, in `cwd` ('' for none). */
  onRunTerminal: (argv: string[], cwd: string) => void;
  /** Opens a terminal in a pinned repo's clone, from the Overview. */
  onOpenTerminal: (root: string) => void;
  /** Delivers a fix prompt for the repo at `root` to its agent terminal, opening one if needed. */
  fixWithAgent: (root: string, prompt: string, fromPaneId: string) => Promise<void>;
  /** Opens the Accounts tab on `host` (null leaves the choice to the tab), with the token form open when asked. */
  onOpenAccounts: (host: string | null, opts?: { openTokenForm?: boolean; org?: string }) => void;
  /** The tab the pane opens on; absent means Pipelines. */
  tab?: ShipTab;
  /** Whether Pipelines lists only the checked-out branch; absent means every branch. */
  thisBranch?: boolean;
  /** Whether Pull requests lists only the checked-out branch's; absent means every branch. */
  thisBranchPulls?: boolean;
  /** Whether Pull requests lists every state rather than open ones only; absent means open only. */
  allPulls?: boolean;
}

const TICK_MS = 1000;
/** Focusing the Overview refreshes it when its newest poll is older than this. */
const STALE_ON_FOCUS_MS = 30_000;
const REMOTE_PREFIX = 'remote:';

// Several panes on one root share a store, which hands each subscriber the same array per poll;
// remembering it lets only the first pane toast a finish.
const toasted = new WeakSet<readonly Run[]>();

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function isRemote(target: string): boolean {
  return target.startsWith(REMOTE_PREFIX);
}

function localError(message: string, kind: ForgeError['kind'] = 'other'): ForgeError {
  return { kind, message, url: null, signIn: null, retryAfterSecs: null };
}

const NOT_LOADED = localError('The repo is not loaded yet.');

/**
 * The Ship pane (docs/design/ship.md section 4.20): the Overview of pinned repos when it has no
 * target, else one repo's CI runs and pull requests on two tabs, with a crumb back.
 */
export class ShipPane implements PaneView {
  readonly kind = 'ship' as const;
  readonly paneId: string;
  private readonly opts: ShipPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly tabStrip: ShipTabStrip;
  private readonly pinButton: ShipPinButton;
  private readonly scopeBox: HTMLInputElement;
  private readonly scopeLabel: HTMLElement;
  private readonly scopeText: HTMLElement;
  private readonly openBox: HTMLInputElement;
  private readonly openLabel: HTMLElement;
  private readonly repoLink: HTMLButtonElement;
  private readonly chip: ShipAccountChip;
  private readonly accountsBtn: HTMLButtonElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly notice: ShipNotice;
  /** Scrolls a long notice, in place of the list it stands in for. */
  private readonly noticeBox: HTMLElement;
  private readonly content: HTMLElement;
  private readonly runList: ShipRunList;
  private readonly pullList: ShipPullList;
  private settings: Settings;
  /** A local repo root or `remote:<repo>`; null on the Overview. */
  private target: string | null;
  /** Mounted while on the Overview. */
  private overview: ShipOverview | null = null;
  private tab: ShipTab;
  /** Pipelines' branch scope; follows the store's once there is one, so saved state tracks another pane's change. */
  private scope: BranchScope;
  /** Pull requests' branch scope, kept apart from Pipelines' and following the store the same way. */
  private pullScope: BranchScope;
  /** Follows the store's filter the same way as `scope`. */
  private openOnly: boolean;
  private expanded: boolean;
  /** Set once the root resolves to a repo; null while resolving or when it is not one. */
  private store: ShipStore | null = null;
  /** An error from resolving the folder, before there is a store to hold one. */
  private initError: ForgeError | null = null;
  private shownNotice: string | null = null;
  /** Bumped on every drill, so a resolve for an earlier target lands nowhere. */
  private epoch = 0;
  /** The epoch a resolve is running for, or null when none is. */
  private resolving: number | null = null;
  private storeOff: Array<() => void> = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: ShipPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.target = opts.root || null;
    this.tab = opts.tab ?? 'pipelines';
    this.scope = opts.thisBranch ? 'branch' : 'all';
    this.pullScope = opts.thisBranchPulls ? 'branch' : 'all';
    this.openOnly = !opts.allPulls;
    this.expanded = opts.expanded;

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body ship-body';
    this.body.tabIndex = -1;

    const bar = document.createElement('div');
    bar.className = 'ship-bar';
    this.bar = bar;
    this.tabStrip = new ShipTabStrip(
      this.tab,
      (tab) => this.setTab(tab),
      () => this.drill(null),
    );
    this.pinButton = new ShipPinButton();
    this.scopeBox = document.createElement('input');
    this.scopeBox.type = 'checkbox';
    this.scopeLabel = document.createElement('label');
    this.scopeLabel.className = 'ship-check ship-scope';
    this.scopeText = document.createElement('span');
    this.scopeText.className = 'ship-scope-text';
    this.scopeText.textContent = 'This branch';
    this.scopeLabel.append(this.scopeBox, this.scopeText);
    this.openBox = document.createElement('input');
    this.openBox.type = 'checkbox';
    this.openLabel = document.createElement('label');
    this.openLabel.className = 'ship-check';
    this.openLabel.title = 'Only open ones; clear to show the latest in every state';
    this.openLabel.append(this.openBox, document.createTextNode('Open'));
    const spacer = document.createElement('span');
    spacer.className = 'ship-bar-spacer';
    this.repoLink = document.createElement('button');
    this.repoLink.type = 'button';
    this.repoLink.className = 'ship-repo';
    this.repoLink.hidden = true;
    this.chip = new ShipAccountChip((anchor) => this.openAccountMenu(anchor));
    this.accountsBtn = document.createElement('button');
    this.accountsBtn.type = 'button';
    this.accountsBtn.className = 'ship-button';
    this.accountsBtn.textContent = 'Accounts';
    this.accountsBtn.title = 'Manage code host accounts';
    this.refreshBtn = document.createElement('button');
    this.refreshBtn.type = 'button';
    this.refreshBtn.className = 'ship-button';
    this.refreshBtn.textContent = 'Refresh';
    this.refreshBtn.title = 'Look again now';
    bar.append(
      this.tabStrip.el,
      this.scopeLabel,
      this.openLabel,
      spacer,
      this.repoLink,
      this.chip.el,
      this.pinButton.el,
      this.accountsBtn,
      this.refreshBtn,
    );

    this.notice = new ShipNotice({
      onRunTerminal: (argv) => this.opts.onRunTerminal(argv, this.localRoot() ?? ''),
      onOpenUrl: (url) => this.openUrl(url),
      onCopy: (text, label) => void copyText(text, label.replace(/^Copy\s+/i, '')),
      onPickAccount: (anchor) => this.openAccountMenu(anchor),
      onOpenAccounts: (host, o) => this.opts.onOpenAccounts(host, o),
      onRetry: () => this.retry(),
    });
    this.noticeBox = document.createElement('div');
    this.noticeBox.className = 'ship-content';
    this.noticeBox.hidden = true;
    this.noticeBox.append(this.notice.el);

    this.runList = new ShipRunList({
      loadJobs: (runId) => this.store?.jobs(runId) ?? Promise.reject(NOT_LOADED),
      loadLog: (runId, jobId) => this.store?.log(runId, jobId) ?? Promise.reject(NOT_LOADED),
      logs: () => this.store?.repo?.capabilities.jobLogs ?? false,
      menuItems: (run) => this.runMenu(run),
      caps: () => this.store?.repo?.capabilities ?? null,
      onOpen: (run) => this.openUrl(run.webUrl),
      onAction: (run, action) => this.runAction(run, action),
      onCopyLink: (run) => void copyText(run.webUrl, 'link'),
    });
    this.pullList = new ShipPullList({
      onOpen: (pull) => this.openUrl(pull.webUrl),
      menuItems: (pull) => this.pullMenu(pull),
    });
    this.content = document.createElement('div');
    this.content.className = 'ship-content';

    this.body.append(bar, this.noticeBox, this.content);
    this.host.appendChild(this.body);

    // One checkbox serves both tabs, each with its own scope.
    this.listen(this.scopeBox, 'change', () => {
      const scope = this.scopeBox.checked ? 'branch' : 'all';
      if (this.tab === 'pipelines') {
        this.setScope(scope);
        void this.store?.setBranchScope(scope);
      } else {
        this.setPullScope(scope);
        void this.store?.setPullsBranchScope(scope);
      }
    });
    this.listen(this.openBox, 'change', () => {
      this.setOpenOnly(this.openBox.checked);
      void this.store?.setPullsOpenOnly(this.openOnly);
    });
    this.listen(this.repoLink, 'click', () => {
      const url = this.store?.repo?.webUrl;
      if (url) this.openUrl(url);
    });
    this.listen(this.accountsBtn, 'click', () => this.opts.onOpenAccounts(this.store?.repo?.host ?? null));
    this.listen(this.refreshBtn, 'click', () => this.retry());
    this.listen(this.host, 'focusin', () => {
      opts.onFocus();
      this.refreshOverviewIfStale();
    });
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    // Back from a browser sign-in or token page: look again rather than waiting out the poll.
    this.listen(window, 'focus', () => this.refreshIfStuck());

    if (this.target === null) this.mountOverview();
    this.render();
    this.updateTick();
    void this.init();
  }

  /** The local repo root; null on the Overview or a remote-only repo, which have no folder. */
  get folder(): string | null {
    return this.localRoot();
  }

  /** The drilled repo's provider and host once it has resolved; null on the Overview or before then. */
  knownHost(): { provider: ProviderKind; host: string } | null {
    const repo = this.store?.repo;
    return repo ? { provider: repo.provider, host: repo.host } : null;
  }

  /** The resolved repo as `<host>/<owner>/<name>`, the shape pins use; null until it resolves. */
  knownRepoId(): string | null {
    const repo = this.store?.repo;
    return repo ? `${repo.host}/${repo.owner}/${repo.name}` : null;
  }

  /** The drilled target (a local root or `remote:<repo>`); null on the Overview. */
  root(): string | null {
    return this.target;
  }

  /** The repo's name for the title strip; "Ship" on the Overview. */
  title(): string {
    const t = this.target;
    if (t === null) return 'Ship';
    return baseName(isRemote(t) ? t.slice(REMOTE_PREFIX.length) : t) || 'Ship';
  }

  /** The `forge` saved-pane fields; `root` only when drilled, the rest only when not the default. */
  saved(): {
    root?: string;
    tab?: ShipTab;
    thisBranch?: boolean;
    thisBranchPulls?: boolean;
    allPulls?: boolean;
  } {
    return {
      ...(this.target !== null && { root: this.target }),
      ...(this.tab !== 'pipelines' && { tab: this.tab }),
      ...(this.scope === 'branch' && { thisBranch: true }),
      ...(this.pullScope === 'branch' && { thisBranchPulls: true }),
      ...(!this.openOnly && { allPulls: true }),
    };
  }

  focus(): void {
    this.body.focus();
  }

  /**
   * Drills into `target` (a folder in a repo or `remote:<repo>`) on `tab`, or returns to the
   * Overview for null. The same target only switches the tab.
   */
  drill(target: string | null, tab?: ShipTab): void {
    if (this.disposed) return;
    const same = target === null || this.target === null ? target === this.target : samePath(target, this.target);
    if (!same) {
      this.epoch++;
      this.releaseStore();
      this.initError = null;
      this.shownNotice = null;
      this.target = target;
      if (target === null) this.mountOverview();
      else this.unmountOverview();
    }
    if (tab !== undefined && tab !== this.tab) {
      this.tab = tab;
      this.tabStrip.set(tab);
    }
    this.updateWanted();
    this.render();
    if (!same) void this.init();
    this.opts.onChange();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.updateWanted();
    this.updateTick();
    if (expanded) this.render();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
  }

  cellSize(): CellSize {
    const probe = document.createElement('span');
    probe.textContent = 'M'.repeat(10);
    probe.style.cssText = 'position: absolute; visibility: hidden; white-space: pre;';
    probe.style.fontFamily = toFontFamily(this.settings.font.family);
    probe.style.fontSize = `${this.settings.font.size}px`;
    this.body.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 10;
    const probeHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const row = this.body.querySelector<HTMLElement>('.ship-run-row, .ship-pull');
    const height = row?.offsetHeight || probeHeight || this.settings.font.size * 1.2;
    return {
      width,
      height,
      // Everything outside the body: borders and the title strip.
      padX: Math.max(0, this.host.offsetWidth - this.body.clientWidth) + 1,
      padY: Math.max(0, this.host.offsetHeight - this.body.clientHeight) + 1,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.updateTick();
    this.releaseStore();
    this.unmountOverview();
    this.pinButton.dispose();
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private async init(): Promise<void> {
    // A Retry while the folder is still resolving would take a second store reference.
    if (this.target === null || this.resolving === this.epoch || this.store) return;
    const epoch = this.epoch;
    this.resolving = epoch;
    try {
      await this.resolve(epoch);
    } finally {
      if (this.resolving === epoch) this.resolving = null;
    }
  }

  private async resolve(epoch: number): Promise<void> {
    const asked = this.target;
    if (asked === null) return;
    this.initError = null;
    // A remote-only target has no folder to resolve; the store looks the repo up by its key.
    if (!isRemote(asked)) {
      let info: RepoInfo;
      try {
        info = await repoRoot(asked);
      } catch (e) {
        if (this.disposed || epoch !== this.epoch) return;
        this.initError = asForgeError(e);
        this.render();
        return;
      }
      if (this.disposed || epoch !== this.epoch) return;
      if (!info.isGit) {
        this.initError = localError(`${asked} is not a git repo.`, 'notARepo');
        this.render();
        return;
      }
      if (!samePath(info.root, asked)) {
        this.target = info.root;
        this.opts.onChange();
      }
    }
    const key = this.target ?? asked;
    // A store another pane already holds keeps that pane's filters; a new one takes this pane's.
    const fresh = !ShipStore.has(key);
    const store = ShipStore.for(key);
    this.store = store;
    if (fresh) {
      // A remote-only repo has no checked-out branch to scope to.
      void store.setBranchScope(isRemote(key) ? 'all' : this.scope);
      void store.setPullsBranchScope(isRemote(key) ? 'all' : this.pullScope);
      void store.setPullsOpenOnly(this.openOnly);
    } else {
      this.setScope(store.branchScope);
      this.setPullScope(store.pullsBranchScope);
      this.setOpenOnly(store.pullsOpenOnly);
    }
    this.storeOff = [
      store.subscribe(() => {
        this.setScope(store.branchScope);
        this.setPullScope(store.pullsBranchScope);
        this.setOpenOnly(store.pullsOpenOnly);
        this.render();
      }),
      store.onFinished((runs) => this.announce(runs)),
    ];
    this.updateWanted();
    this.render();
  }

  private releaseStore(): void {
    const store = this.store;
    if (!store) return;
    store.setWanted(this.wantedKey(), false);
    for (const off of this.storeOff) off();
    this.storeOff = [];
    this.store = null;
    store.release();
  }

  private wantedKey(): string {
    return `pane:${this.paneId}`;
  }

  private updateWanted(): void {
    const on = this.expanded && !this.disposed;
    this.store?.setWanted(this.wantedKey(), on, this.tab);
    this.overview?.setWanted(on);
  }

  private mountOverview(): void {
    if (this.overview) return;
    this.overview = new ShipOverview({
      onDrill: (target, tab) => this.drill(target, tab),
      onRunTerminal: (argv) => this.opts.onRunTerminal(argv, ''),
      onOpenTerminal: (root) => this.opts.onOpenTerminal(root),
      onOpenUrl: (url) => this.openUrl(url),
      onCopy: (text) => void copyText(text, 'link'),
      onOpenAccounts: (host, o) => this.opts.onOpenAccounts(host, o),
    });
    this.body.append(this.overview.el);
  }

  private unmountOverview(): void {
    const overview = this.overview;
    if (!overview) return;
    this.overview = null;
    overview.dispose();
    overview.el.remove();
  }

  /** The drilled target when it is a local clone; null on the Overview or a remote-only repo. */
  private localRoot(): string | null {
    const t = this.target;
    return t === null || isRemote(t) ? null : t;
  }

  /** Back from elsewhere to a stale Overview: poll now rather than waiting out the heartbeat. */
  private refreshOverviewIfStale(): void {
    if (!this.overview || !this.expanded || this.disposed) return;
    const last = shipOverviewStore.lastUpdated();
    if (last !== null && Date.now() - last > STALE_ON_FOCUS_MS) void shipOverviewStore.refresh();
  }

  /** Keeps relative times and durations current while the pane is on screen. */
  private updateTick(): void {
    const want = this.expanded && !this.disposed;
    if (want && this.tick === null) {
      this.tick = setInterval(() => {
        if (document.visibilityState === 'visible') this.render();
      }, TICK_MS);
    } else if (!want && this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
  }

  private setScope(scope: BranchScope): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.opts.onChange();
  }

  private setPullScope(scope: BranchScope): void {
    if (scope === this.pullScope) return;
    this.pullScope = scope;
    this.opts.onChange();
  }

  private setOpenOnly(on: boolean): void {
    if (on === this.openOnly) return;
    this.openOnly = on;
    this.opts.onChange();
  }

  private setTab(tab: ShipTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.tabStrip.set(tab);
    this.updateWanted();
    this.render();
    this.opts.onChange();
  }

  /** Retry and Refresh: resolve the folder again when that is what failed, else poll now. */
  private retry(): void {
    if (this.target === null) return;
    if (this.store) void this.store.refresh();
    else void this.init();
  }

  /** Refreshes after a likely fix outside the app (sign-in, a new token), never against a rate limit. */
  private refreshIfStuck(): void {
    if (!this.expanded || this.disposed || this.target === null) return;
    const err = this.store ? this.store.errorFor(this.tab) : this.initError;
    if (err && err.kind !== 'rateLimited') this.retry();
  }

  private render(): void {
    if (this.disposed) return;
    const onOverview = this.target === null;
    this.bar.hidden = onOverview;
    if (onOverview) {
      this.noticeBox.hidden = true;
      this.content.hidden = true;
      return;
    }
    const store = this.store;
    const repo = store?.repo ?? null;
    const remote = this.localRoot() === null;

    const pipelines = this.tab === 'pipelines';
    const branch = remote ? null : (repo?.branch ?? null);
    this.scopeBox.disabled = remote;
    this.scopeLabel.classList.toggle('disabled', remote);
    this.scopeBox.checked = (pipelines ? this.scope : this.pullScope) === 'branch';
    const text = branch ? `This branch (${branch})` : 'This branch';
    if (this.scopeText.textContent !== text) this.scopeText.textContent = text;
    this.openLabel.hidden = pipelines;
    this.openBox.checked = this.openOnly;
    const what = pipelines ? 'runs on' : `${prNounOf(repo)}s from`;
    this.scopeLabel.title = remote
      ? 'This repo has no clone here, so there is no checked-out branch'
      : `Only ${what} ${branch ?? 'the checked-out branch'}; clear to show every branch`;
    this.tabStrip.setPrNoun(prNounOf(repo));
    if (repo) {
      const name = `${repo.owner}/${repo.name}`;
      if (this.repoLink.textContent !== name) this.repoLink.textContent = name;
      this.repoLink.title = `Open ${repo.webUrl}`;
    }
    this.repoLink.hidden = repo === null;
    this.chip.update(remote ? null : repo);
    this.pinButton.update(repo, this.localRoot());

    const err = store ? store.errorFor(this.tab) : this.initError;
    if (err) {
      // Rebuilt only when it changes: the tick renders every second, and a rebuild would close an
      // open "How to make a new one" and drop a click landing mid-rebuild.
      const notice = noticeFor(err, repo);
      const key = JSON.stringify(notice);
      if (key !== this.shownNotice) {
        this.shownNotice = key;
        this.notice.set(notice);
      }
      this.noticeBox.hidden = false;
      this.content.hidden = true;
      return;
    }
    this.shownNotice = null;
    this.noticeBox.hidden = true;
    this.content.hidden = false;

    const now = Date.now();
    if (pipelines) this.runList.update(store?.runs ?? [], now, this.runsEmptyText());
    else this.pullList.update(store?.pulls ?? [], now, this.pullsEmptyText(), this.pullsLimitText());
    // Hidden rather than detached: detaching resets an open log's scroll, which starts at the end.
    if (this.content.childElementCount === 0) this.content.append(this.runList.el, this.pullList.el);
    this.runList.el.hidden = !pipelines;
    this.pullList.el.hidden = pipelines;
  }

  private runsEmptyText(): string {
    const store = this.store;
    if (!store || !store.runsReady) return 'Loading…';
    const noun = store.repo?.capabilities.runNoun ?? 'run';
    const branch = store.repo?.branch;
    return store.branchScope === 'branch' && branch ? `No ${noun}s on ${branch}.` : `No ${noun}s yet.`;
  }

  private pullsLimitText(): string | null {
    const store = this.store;
    if (!store) return null;
    const noun = prNounOf(store.repo);
    return pullLimitNote(store.pulls.length, store.pullsTotal, noun, this.openOnly);
  }

  private pullsEmptyText(): string {
    const store = this.store;
    if (!store || !store.pullsReady) return 'Loading…';
    const noun = prNounOf(store.repo);
    const branch = store.repo?.branch;
    if (store.pullsBranchScope === 'branch' && branch) {
      return this.openOnly ? `No open ${noun}s from ${branch}.` : `No ${noun}s from ${branch}.`;
    }
    return this.openOnly ? `No open ${noun}s.` : `No ${noun}s yet.`;
  }

  private announce(runs: Run[]): void {
    if (toasted.has(runs)) return;
    toasted.add(runs);
    const noun = this.store?.repo?.capabilities.runNoun ?? 'run';
    for (const run of runs) {
      showToast(finishToast(run, noun), 6000, { label: 'Open', run: () => this.openUrl(run.webUrl) });
    }
  }

  private runAction(run: Run, action: RunActionKey): void {
    if (action === 'cancel') void this.cancel(run);
    else void this.act(this.store?.rerun(run.id, action === 'rerunFailed'));
  }

  private runMenu(run: Run): MenuEntry[] {
    const caps = this.store?.repo?.capabilities;
    if (!caps) return [];
    const root = this.localRoot();
    return runMenuItems(run, caps, {
      onOpen: () => this.openUrl(run.webUrl),
      onRerun: () => this.runAction(run, 'rerun'),
      onRerunFailed: () => this.runAction(run, 'rerunFailed'),
      onCancel: () => this.runAction(run, 'cancel'),
      onCopyLink: () => void copyText(run.webUrl, 'link'),
      ...(root !== null && { onFixWithAgent: () => void this.fixWithAgent(run, root) }),
    });
  }

  /** Builds the run's failure report and hands it to the repo's agent (design 4.20). */
  private async fixWithAgent(run: Run, root: string): Promise<void> {
    showToast("Gathering the failed jobs' logs", 3000);
    await this.act(forgeFixPrompt(root, run.id).then((prompt) => this.opts.fixWithAgent(root, prompt, this.paneId)));
  }

  private pullMenu(pull: PullRequest): MenuEntry[] {
    return pullMenuItems(pull, {
      onOpen: () => this.openUrl(pull.webUrl),
      onCopyLink: () => void copyText(pull.webUrl, 'link'),
      onCopyBranch: () => void copyText(pull.sourceBranch, 'branch name'),
    });
  }

  private async cancel(run: Run): Promise<void> {
    const store = this.store;
    if (!store) return;
    const noun = store.repo?.capabilities.runNoun ?? 'run';
    if (!(await this.opts.confirm(cancelRunConfirm(run, noun)))) return;
    if (this.store !== store) return;
    await this.act(store.cancel(run.id));
  }

  /** A re-run, cancel, or account switch: a failure shows as a toast, since the list stays as it was. */
  private async act(p: Promise<void> | undefined): Promise<void> {
    try {
      await p;
    } catch (e) {
      showToast(asForgeError(e).message);
    }
  }

  private openAccountMenu(anchor: HTMLElement): void {
    const store = this.store;
    const repo = store?.repo;
    if (!store || !repo) return;
    openContextMenu(
      accountMenuItems(repo, {
        onPick: (user) => {
          if (user !== repo.account) void this.act(store.setAccount(user));
        },
        onSignIn: (argv) => this.opts.onRunTerminal(argv, this.localRoot() ?? ''),
        onManage: () => this.opts.onOpenAccounts(repo.host),
      }),
      { anchorEl: anchor },
    );
  }

  private openUrl(url: string): void {
    void invoke('open_url', { url }).catch((err: unknown) => console.warn('open_url failed', err));
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = lookup(this.opts.keymap(), e);
    if (action && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
