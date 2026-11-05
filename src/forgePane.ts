import { invoke } from '@tauri-apps/api/core';
import './forgePane.css';
import type { ConfirmOptions } from './confirmDialog';
import { openContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import { copyText } from './copyText';
import { samePath } from './favorites';
import { ForgeAccountChip } from './forgeAccountChip';
import { asForgeError, type ForgeError, type PullRequest, type Run } from './forgeApi';
import { accountMenuItems, pullMenuItems, runMenuItems } from './forgeMenus';
import { finishToast, noticeFor, pullLimitNote, type ForgeTab } from './forgeModel';
import { ForgeNotice } from './forgeNotice';
import { ForgePullList } from './forgePullList';
import { ForgeRunList } from './forgeRunList';
import { ForgeStore } from './forgeStore';
import { ForgeTabStrip } from './forgeTabStrip';
import { lookup, type Action, type Keymap } from './keymap';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import { cancelRunConfirm } from './paneConfirm';
import type { PaneView } from './paneView';
import { repoRoot, type RepoInfo } from './repoFiles';
import type { Settings } from './settings';
import { showToast } from './toast';

export interface ForgePaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  /** The repo root, or a folder inside it (the pane adopts the resolved root). */
  root: string;
  /** Whether the pane starts on screen; the store is polled only while it is. */
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The root or tab changed (title and saved state follow). */
  onChange: () => void;
  /** Asks before cancelling a run; resolves true to go ahead. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Runs `argv` (a sign-in or install command) in a terminal split off this pane, in `cwd`. */
  onRunTerminal: (argv: string[], cwd: string) => void;
  /** The tab the pane opens on; absent means Pipelines. */
  tab?: ForgeTab;
}

const TICK_MS = 1000;

// Several panes on one root share a store, which hands each subscriber the same array per poll;
// remembering it lets only the first pane toast a finish.
const toasted = new WeakSet<readonly Run[]>();

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

function localError(message: string, kind: ForgeError['kind'] = 'other'): ForgeError {
  return { kind, message, url: null, signIn: null, retryAfterSecs: null };
}

const NOT_LOADED = localError('The repo is not loaded yet.');

/** A repo's CI runs and open pull requests, on two tabs (docs/design.md section 4.20). */
export class ForgePane implements PaneView {
  readonly kind = 'forge' as const;
  readonly paneId: string;
  private readonly opts: ForgePaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly tabStrip: ForgeTabStrip;
  private readonly scopeBox: HTMLInputElement;
  private readonly scopeLabel: HTMLElement;
  private readonly repoLink: HTMLButtonElement;
  private readonly chip: ForgeAccountChip;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly notice: ForgeNotice;
  /** Scrolls a long notice, in place of the list it stands in for. */
  private readonly noticeBox: HTMLElement;
  private readonly content: HTMLElement;
  private readonly runList: ForgeRunList;
  private readonly pullList: ForgePullList;
  private settings: Settings;
  private rootPath: string;
  private tab: ForgeTab;
  private expanded: boolean;
  /** Set once the root resolves to a repo; null while resolving or when it is not one. */
  private store: ForgeStore | null = null;
  /** An error from resolving the folder, before there is a store to hold one. */
  private initError: ForgeError | null = null;
  private shownNotice: string | null = null;
  private resolving = false;
  private storeOff: Array<() => void> = [];
  private tick: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: ForgePaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.rootPath = opts.root;
    this.tab = opts.tab ?? 'pipelines';
    this.expanded = opts.expanded;

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body forge-body';
    this.body.tabIndex = -1;

    const bar = document.createElement('div');
    bar.className = 'forge-bar';
    this.tabStrip = new ForgeTabStrip(this.tab, (tab) => this.setTab(tab));
    this.scopeBox = document.createElement('input');
    this.scopeBox.type = 'checkbox';
    this.scopeBox.checked = true;
    this.scopeLabel = document.createElement('label');
    this.scopeLabel.className = 'forge-check';
    this.scopeLabel.append(this.scopeBox, document.createTextNode('This branch'));
    const spacer = document.createElement('span');
    spacer.className = 'forge-bar-spacer';
    this.repoLink = document.createElement('button');
    this.repoLink.type = 'button';
    this.repoLink.className = 'forge-repo';
    this.repoLink.hidden = true;
    this.chip = new ForgeAccountChip((anchor) => this.openAccountMenu(anchor));
    this.refreshBtn = document.createElement('button');
    this.refreshBtn.type = 'button';
    this.refreshBtn.className = 'forge-button';
    this.refreshBtn.textContent = 'Refresh';
    this.refreshBtn.title = 'Look again now';
    bar.append(this.tabStrip.el, this.scopeLabel, spacer, this.repoLink, this.chip.el, this.refreshBtn);

    this.notice = new ForgeNotice({
      onRunTerminal: (argv) => this.opts.onRunTerminal(argv, this.rootPath),
      onOpenUrl: (url) => this.openUrl(url),
      onCopy: (text, label) => void copyText(text, label.replace(/^Copy\s+/i, '')),
      onPickAccount: (anchor) => this.openAccountMenu(anchor),
      onRetry: () => this.retry(),
    });
    this.noticeBox = document.createElement('div');
    this.noticeBox.className = 'forge-content';
    this.noticeBox.hidden = true;
    this.noticeBox.append(this.notice.el);

    this.runList = new ForgeRunList({
      loadJobs: (runId) => this.store?.jobs(runId) ?? Promise.reject(NOT_LOADED),
      loadLog: (runId, jobId) => this.store?.log(runId, jobId) ?? Promise.reject(NOT_LOADED),
      logs: () => this.store?.repo?.capabilities.jobLogs ?? false,
      menuItems: (run) => this.runMenu(run),
    });
    this.pullList = new ForgePullList({
      onOpen: (pull) => this.openUrl(pull.webUrl),
      menuItems: (pull) => this.pullMenu(pull),
    });
    this.content = document.createElement('div');
    this.content.className = 'forge-content';

    this.body.append(bar, this.noticeBox, this.content);
    this.host.appendChild(this.body);

    this.listen(this.scopeBox, 'change', () => {
      void this.store?.setBranchScope(this.scopeBox.checked ? 'branch' : 'all');
    });
    this.listen(this.repoLink, 'click', () => {
      const url = this.store?.repo?.webUrl;
      if (url) this.openUrl(url);
    });
    this.listen(this.refreshBtn, 'click', () => this.retry());
    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    // Back from a browser sign-in or token page: look again rather than waiting out the poll.
    this.listen(window, 'focus', () => this.refreshIfStuck());

    this.render();
    this.updateTick();
    void this.init();
  }

  /** The repo root, which is the pane's folder. */
  get folder(): string {
    return this.rootPath;
  }

  root(): string {
    return this.rootPath;
  }

  /** The repo folder's name, for the title strip; the kind's name while there is no folder. */
  title(): string {
    return baseName(this.rootPath) || 'Forge';
  }

  /** The `forge` saved-pane fields; `tab` only when it is not the default. */
  saved(): { root: string; tab?: ForgeTab } {
    return this.tab === 'pipelines' ? { root: this.rootPath } : { root: this.rootPath, tab: this.tab };
  }

  focus(): void {
    this.body.focus();
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
    const row = this.body.querySelector<HTMLElement>('.forge-run-row, .forge-pull');
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
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private async init(): Promise<void> {
    // A Retry while the folder is still resolving would take a second store reference.
    if (this.resolving || this.store) return;
    this.resolving = true;
    try {
      await this.resolve();
    } finally {
      this.resolving = false;
    }
  }

  private async resolve(): Promise<void> {
    const asked = this.rootPath;
    this.initError = null;
    let info: RepoInfo;
    try {
      info = await repoRoot(asked);
    } catch (e) {
      if (this.disposed) return;
      this.initError = asForgeError(e);
      this.render();
      return;
    }
    if (this.disposed) return;
    if (!info.isGit) {
      this.initError = localError(`${asked || 'This folder'} is not a git repo.`, 'notARepo');
      this.render();
      return;
    }
    if (!samePath(info.root, asked)) {
      this.rootPath = info.root;
      this.opts.onChange();
    }
    const store = ForgeStore.for(this.rootPath);
    this.store = store;
    this.storeOff = [store.subscribe(() => this.render()), store.onFinished((runs) => this.announce(runs))];
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
    this.store?.setWanted(this.wantedKey(), this.expanded && !this.disposed, this.tab);
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

  private setTab(tab: ForgeTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.tabStrip.set(tab);
    this.updateWanted();
    this.render();
    this.opts.onChange();
  }

  /** Retry and Refresh: resolve the folder again when that is what failed, else poll now. */
  private retry(): void {
    if (this.store) void this.store.refresh();
    else void this.init();
  }

  /** Refreshes after a likely fix outside the app (sign-in, a new token), never against a rate limit. */
  private refreshIfStuck(): void {
    if (!this.expanded || this.disposed) return;
    const err = this.store ? this.store.errorFor(this.tab) : this.initError;
    if (err && err.kind !== 'rateLimited') this.retry();
  }

  private render(): void {
    if (this.disposed) return;
    const store = this.store;
    const repo = store?.repo ?? null;

    this.scopeLabel.hidden = this.tab !== 'pipelines';
    this.scopeBox.checked = (store?.branchScope ?? 'branch') === 'branch';
    this.scopeLabel.title = repo?.branch
      ? `Only runs on ${repo.branch}; clear to show every branch`
      : 'Only runs on the checked-out branch; clear to show every branch';
    if (repo) {
      this.tabStrip.setPrNoun(repo.capabilities.prNoun);
      const name = `${repo.owner}/${repo.name}`;
      if (this.repoLink.textContent !== name) this.repoLink.textContent = name;
      this.repoLink.title = `Open ${repo.webUrl}`;
    }
    this.repoLink.hidden = repo === null;
    this.chip.update(repo);

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
    const pipelines = this.tab === 'pipelines';
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
    return pullLimitNote(store.pulls.length, store.pullsTotal, store.repo?.capabilities.prNoun ?? 'pull request');
  }

  private pullsEmptyText(): string {
    const store = this.store;
    if (!store || !store.pullsReady) return 'Loading…';
    return `No open ${store.repo?.capabilities.prNoun ?? 'pull request'}s.`;
  }

  private announce(runs: Run[]): void {
    if (toasted.has(runs)) return;
    toasted.add(runs);
    const noun = this.store?.repo?.capabilities.runNoun ?? 'run';
    for (const run of runs) {
      showToast(finishToast(run, noun), 6000, { label: 'Open', run: () => this.openUrl(run.webUrl) });
    }
  }

  private runMenu(run: Run): MenuEntry[] {
    const caps = this.store?.repo?.capabilities;
    if (!caps) return [];
    return runMenuItems(run, caps, {
      onOpen: () => this.openUrl(run.webUrl),
      onRerun: () => void this.act(this.store?.rerun(run.id, false)),
      onRerunFailed: () => void this.act(this.store?.rerun(run.id, true)),
      onCancel: () => void this.cancel(run),
      onCopyLink: () => void copyText(run.webUrl, 'link'),
    });
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
        onSignIn: (argv) => this.opts.onRunTerminal(argv, this.rootPath),
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
