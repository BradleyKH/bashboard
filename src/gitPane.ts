import './gitPane.css';
import { startSplitDrag } from './splitDrag';
import type { ConfirmOptions } from './confirmDialog';
import type { MenuEntry } from './contextMenuModel';
import { copyPath, copyText } from './copyText';
import { openInEditor } from './editors';
import { samePath } from './favorites';
import {
  gitBranches,
  gitCommit,
  gitDiff,
  gitFetch,
  gitLastFetch,
  gitLog,
  gitPull,
  gitPush,
  gitShow,
  gitStage,
  gitStatus,
  gitUndoCommit,
  gitUnstage,
  gitUnwatch,
  gitWatch,
  onGitChanged,
  onGitFetched,
  type GitBranchList,
  type GitCommit,
  type GitDiff,
  type GitLastFetch,
  type GitStatus,
} from './gitApi';
import { GitBranchActions } from './gitBranchActions';
import type { GitTab } from './gitBranchModel';
import { GitBranchRow } from './gitBranchRow';
import { GitBranchesView } from './gitBranchesView';
import { openBranchSwitcher } from './gitBranchSwitcher';
import { GitCommitBox } from './gitCommitBox';
import { codeColorsMode } from './code/schemes';
import { GitDiffView } from './gitDiffView';
import { GitFileList } from './gitFileList';
import { GitLogList } from './gitLogList';
import { GitTabStrip } from './gitTabStrip';
import { gitCommitMenuItems, gitFileMenuItems } from './gitMenus';
import {
  branchLine,
  canCommit,
  changesList,
  commitPushKind,
  lastFetchText,
  mergeUndoMessage,
  remoteButtons,
  shortHash,
  stagedList,
  togglePaths,
  undoTarget,
  type GitRow,
  type RemoteOp,
} from './gitModel';
import { lookup, type Action, type Keymap } from './keymap';
import type { OpenInHandler } from './openMenu';
import { gitWorktrees, type Worktree, type WorktreeList } from './worktreeApi';
import { isRepoRoot } from './worktreeModel';
import type { CellSize } from './layout';
import { toFontFamily } from './pane';
import { undoCommitConfirm } from './paneConfirm';
import type { PaneView } from './paneView';
import { fsList, repoRoot, type RepoInfo } from './repoFiles';
import type { Settings } from './settings';
import { textFieldOwns } from './textPaneKeys';
import { textZoom } from './textZoomStore';
import { showToast } from './toast';

export interface GitPaneOptions {
  host: HTMLElement;
  paneId: string;
  settings: Settings;
  /** The repo root, or a folder inside it (the pane adopts the resolved root). */
  root: string;
  /** Whether the pane starts on screen; refreshes are skipped while it is hidden. */
  expanded: boolean;
  keymap: () => Keymap;
  dispatch: (action: Action) => boolean;
  onFocus: () => void;
  /** The root changed (title and saved state follow). */
  onChange: () => void;
  /** Asks before Undo last commit; resolves true to go ahead. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** A file row drag began; the workspace runs the path drag. */
  onPathDragStart?: (paths: string[], e: PointerEvent) => void;
  /** Insert path on a row: the entry's absolute path and this pane's root, to make it relative to. */
  onInsertPath: (absolute: string, baseRoot: string) => void;
  /** Insert name on a branch row: the text goes into the tab's recent terminal as typed. */
  onInsertText: (text: string) => void;
  /** Opens (or focuses) a Git pane on another worktree, for a branch checked out there. */
  onOpenGit: (root: string) => void;
  /** A worktree row's Open menu. */
  onOpenIn: OpenInHandler;
  /** Asks, then removes the worktree; resolves to a message to show inline, or null when removed or cancelled. */
  onDeleteWorktree: (root: string, w: Worktree) => Promise<string | null>;
  /** The Worktrees group's compare choice for the repo whose main worktree is `root`; null is automatic. */
  onSetPrimaryBranch: (root: string, branch: string | null) => void;
  /** The tab the pane opens on; absent means Changes. */
  tab?: GitTab;
}

const LOG_COUNT = 20;

type Selection =
  | { type: 'file'; key: string; staged: boolean }
  | { type: 'commit'; hash: string }
  | null;

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? parts[parts.length - 1] : p;
}

/** Joins a repo-relative git path (always `/`) onto the root in the root's own separator style. */
function repoPath(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  const tail = sep === '\\' ? rel.replace(/\//g, '\\') : rel;
  return /[\\/]$/.test(root) ? `${root}${tail}` : `${root}${sep}${tail}`;
}

/** A repo's changes, staging, commits, and diffs (docs/design/git.md section 4.13). */
export class GitPane implements PaneView {
  readonly kind = 'git' as const;
  readonly paneId: string;
  private readonly opts: GitPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly main: HTMLElement;
  private readonly left: HTMLElement;
  private readonly divider: HTMLElement;
  /** The list column's share of the pane's width, set by dragging the divider. */
  private split = 0.4;
  private readonly right: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly branch: GitBranchRow;
  private readonly commitBox: GitCommitBox;
  private readonly stagedList: GitFileList;
  private readonly changesList: GitFileList;
  private readonly logList: GitLogList;
  private readonly diffView: GitDiffView;
  private readonly tabStrip: GitTabStrip;
  private readonly branchesView: GitBranchesView;
  private readonly branchActions: GitBranchActions;
  private tab: GitTab;
  private branches: GitBranchList | null = null;
  /** Read only while the Branches tab shows, since each read runs a rev-list per worktree. */
  private worktrees: WorktreeList | null = null;
  private worktreesLoading = false;
  private worktreesQueued = false;
  private settings: Settings;
  private rootPath: string;
  private expanded: boolean;
  /** Set once the root is known to be an existing git repo; refreshes wait for it. */
  private ready = false;
  private status: GitStatus | null = null;
  private log: GitCommit[] = [];
  private selection: Selection = null;
  private undoHash: string | null = null;
  /** A refusal outlives the refresh that follows it, while HEAD stays put. */
  private undoError: string | null = null;
  private committing = false;
  private refreshing = false;
  private refreshQueued = false;
  /** Bumped per diff request, so a late diff for an older selection is dropped. */
  private diffGen = 0;
  private watchedRoot: string | null = null;
  private unlistenChanged: (() => void) | null = null;
  private unlistenFetched: (() => void) | null = null;
  private remoteOp: RemoteOp | null = null;
  private lastFetch: GitLastFetch | null = null;
  /** Whether the error under the commit box came from a remote operation, so only those clear it. */
  private remoteError = false;
  private labelTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: GitPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.rootPath = opts.root;
    this.expanded = opts.expanded;
    this.tab = opts.tab ?? 'changes';

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body git-body';
    this.body.tabIndex = -1;

    this.left = document.createElement('div');
    this.left.className = 'git-left';
    this.branch = new GitBranchRow({
      onFetch: () => void this.runRemote('fetch'),
      onPull: () => void this.runRemote('pull'),
      onPush: () => void this.runRemote('push'),
      onBranchClick: (anchor) => this.openSwitcher(anchor),
    });
    this.commitBox = new GitCommitBox({
      onCommit: (message) => void this.commit(message),
      onInput: () => this.updateCommitEnabled(),
    });
    this.stagedList = new GitFileList({
      title: 'Staged',
      staged: true,
      onSelect: (row) => this.selectFile(row, true),
      onToggle: (row) => void this.toggle([row], true),
      onToggleAll: (rows) => void this.toggle(rows, true),
      menuItems: (row) => this.fileMenu(row, true),
      onOpen: (row) => void openInEditor(repoPath(this.rootPath, row.entry.path)),
      onDragStart: (row, e) => this.opts.onPathDragStart?.([repoPath(this.rootPath, row.entry.path)], e),
    });
    this.changesList = new GitFileList({
      title: 'Changes',
      staged: false,
      onSelect: (row) => this.selectFile(row, false),
      onToggle: (row) => void this.toggle([row], false),
      onToggleAll: (rows) => void this.toggle(rows, false),
      menuItems: (row) => this.fileMenu(row, false),
      onOpen: (row) => void openInEditor(repoPath(this.rootPath, row.entry.path)),
      onDragStart: (row, e) => this.opts.onPathDragStart?.([repoPath(this.rootPath, row.entry.path)], e),
    });
    this.logList = new GitLogList({
      onSelect: (hash) => this.selectCommit(hash),
      menuItems: (commit) =>
        gitCommitMenuItems(
          commit,
          {
            undoHash: this.undoHash,
            push: commitPushKind(commit, this.status),
            canPush: this.remoteOp === null,
          },
          {
            showDiff: (c) => {
              this.logList.select(c.hash);
              this.selectCommit(c.hash);
            },
            copyHash: (hash) => copyText(hash, 'hash'),
            copySubject: (subject) => copyText(subject, 'subject'),
            undo: (hash) => void this.undo(hash),
            push: (upTo) => void this.runRemote('push', upTo),
          },
        ),
    });
    this.left.append(this.commitBox.el, this.stagedList.el, this.changesList.el, this.logList.el);

    this.divider = document.createElement('div');
    this.divider.className = 'git-divider';

    this.right = document.createElement('div');
    this.right.className = 'git-right';
    this.diffView = new GitDiffView(
      () => {
        if (this.selection?.type === 'commit') void this.undo(this.selection.hash);
      },
      textZoom('gitDiff'),
      codeColorsMode(opts.settings.codeColors.scheme),
    );
    this.right.append(this.diffView.el);

    this.notice = document.createElement('div');
    this.notice.className = 'git-notice';

    this.branchActions = new GitBranchActions({
      root: () => this.rootPath,
      confirm: (o) => this.opts.confirm(o),
      showError: (text) => this.showBranchError(text),
      refresh: () => this.refresh(),
    });
    this.branchesView = new GitBranchesView({
      onSwitch: (b) => void this.branchActions.switchTo(b.name),
      onOpenWorktree: (path) => this.opts.onOpenGit(path),
      onCheckOut: (b) => void this.branchActions.checkOut(b.name),
      onCreate: (name, base) => this.branchActions.create(name, base),
      onRename: (from, to) => this.branchActions.rename(from, to),
      onDelete: (b) => void this.branchActions.remove(b),
      onCleanup: (bs) => void this.branchActions.cleanup(bs),
      copyName: (name) => copyText(name, 'branch name'),
      insertName: (name) => this.opts.onInsertText(name),
      onOpenIn: (kind, path) => this.opts.onOpenIn(kind, path),
      onDeleteWorktree: async (w) => {
        const message = await this.opts.onDeleteWorktree(this.mainWorktree(), w);
        // A removal also changes the branch list when it deleted the branch.
        this.refresh();
        return message;
      },
      onSetPrimaryBranch: (branch) => this.opts.onSetPrimaryBranch(this.mainWorktree(), branch),
    });
    this.tabStrip = new GitTabStrip(this.tab, (tab) => this.setTab(tab));

    const head = document.createElement('div');
    head.className = 'git-head';
    head.append(this.branch.el, this.tabStrip.el);
    this.main = document.createElement('div');
    this.main.className = 'git-main';
    this.main.append(this.left, this.divider, this.right);
    this.body.append(head, this.main, this.branchesView.el, this.notice);
    this.body.classList.toggle('tab-branches', this.tab === 'branches');
    this.host.appendChild(this.body);
    // Nothing shows until the root is checked, so a non-repo never flashes an empty pane.
    this.setBodyShown(false);
    this.notice.hidden = true;

    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.divider, 'pointerdown', (e) =>
      startSplitDrag(e as PointerEvent, this.divider, this.main, (f) => {
        this.split = f;
        this.applySplit();
      }),
    );
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'focus', () => this.refresh());

    onGitChanged((root, metadata) => {
      if (samePath(root, this.rootPath)) this.refresh();
      // A checkout or commit in another worktree moves its row.
      else if (metadata && this.worktrees && isRepoRoot(root, this.worktrees.worktrees)) this.reloadWorktrees();
    }).then(
      (off) => {
        if (this.disposed) off();
        else this.unlistenChanged = off;
      },
      () => {},
    );

    onGitFetched((roots) => {
      if (roots.some((r) => samePath(r, this.rootPath))) void this.reloadLastFetch();
      // A fetch moves the comparison ref every worktree is counted against.
      if (this.worktrees && roots.some((r) => isRepoRoot(r, this.worktrees?.worktrees ?? []))) this.reloadWorktrees();
    }).then(
      (off) => {
        if (this.disposed) off();
        else this.unlistenFetched = off;
      },
      () => {},
    );
    this.labelTimer = setInterval(() => this.renderLastFetch(), 30_000);

    void this.init();
  }

  /** The repo root, which is the pane's folder. */
  get folder(): string {
    return this.rootPath;
  }

  root(): string {
    return this.rootPath;
  }

  /** The repo folder's name, for the title strip. */
  title(): string {
    return baseName(this.rootPath);
  }

  /** The `git` saved-pane fields; `tab` only when it is not Changes. */
  saved(): { root: string; tab?: GitTab } {
    const out: { root: string; tab?: GitTab } = { root: this.rootPath };
    if (this.tab !== 'changes') out.tab = this.tab;
    return out;
  }

  private setTab(tab: GitTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    this.tabStrip.set(tab);
    this.body.classList.toggle('tab-branches', tab === 'branches');
    if (tab === 'branches') {
      this.branchesView.focus();
      this.reloadWorktrees();
    }
    this.opts.onChange();
  }

  /** The main worktree's path, which keys the repo's primary branch and removals; the pane's root until the list loads. */
  private mainWorktree(): string {
    return this.worktrees?.worktrees[0]?.path ?? this.rootPath;
  }

  /**
   * Re-reads the repo's worktrees for the Branches tab; skipped while another tab shows or the
   * pane is hidden. A call during a read queues exactly one more.
   */
  reloadWorktrees(): void {
    if (this.disposed || !this.ready || !this.expanded || this.tab !== 'branches') return;
    if (this.worktreesLoading) {
      this.worktreesQueued = true;
      return;
    }
    this.worktreesLoading = true;
    const root = this.rootPath;
    gitWorktrees(root)
      .then(
        (list) => {
          if (this.disposed || root !== this.rootPath) return;
          this.worktrees = list;
          this.branchesView.setWorktrees(list, null, root);
        },
        (err: unknown) => {
          // The last good list stays on screen under the error.
          if (!this.disposed && root === this.rootPath) this.branchesView.setWorktrees(null, errorText(err), root);
        },
      )
      .finally(() => {
        this.worktreesLoading = false;
        if (this.worktreesQueued) {
          this.worktreesQueued = false;
          this.reloadWorktrees();
        }
      });
  }

  private openSwitcher(anchor: HTMLElement): void {
    if (this.branches === null) return;
    openBranchSwitcher(anchor, this.branches, {
      onLocal: (b) => {
        if (b.worktree !== null) this.opts.onOpenGit(b.worktree);
        else void this.branchActions.switchTo(b.name);
      },
      onRemote: (b) => void this.branchActions.checkOut(b.name),
      onCreate: (name) => void this.branchActions.create(name, null),
    });
  }

  /**
   * A branch failure shows where the user is looking: in the Branches tab, or under the commit
   * box, where a remote failure shows and the next success clears it the same way.
   */
  private showBranchError(text: string | null): void {
    if (this.tab === 'branches') {
      this.branchesView.showError(text);
      return;
    }
    if (text !== null) {
      this.commitBox.showError(text);
      this.remoteError = true;
    } else if (this.remoteError) {
      this.commitBox.showError(null);
      this.remoteError = false;
    }
  }

  /**
   * Re-reads status and log and updates every region. Skipped while the pane is hidden or the
   * repo is not loaded; overlapping calls coalesce into one queued rerun.
   */
  refresh(): void {
    if (this.disposed || !this.ready || !this.expanded) return;
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    void this.load().finally(() => {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refresh();
      }
    });
  }

  focus(): void {
    this.body.focus();
  }

  setExpanded(expanded: boolean): void {
    const shown = expanded && !this.expanded;
    this.expanded = expanded;
    if (shown) this.refresh();
  }

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.diffView.setCodeColors(codeColorsMode(settings.codeColors.scheme));
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
    const row = this.body.querySelector<HTMLElement>('.git-row');
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
    this.diffGen++;
    if (this.watchedRoot !== null) void gitUnwatch(this.watchedRoot).catch(() => {});
    this.watchedRoot = null;
    this.unlistenChanged?.();
    this.unlistenChanged = null;
    this.unlistenFetched?.();
    this.unlistenFetched = null;
    if (this.labelTimer !== null) clearInterval(this.labelTimer);
    this.labelTimer = null;
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.body.remove();
  }

  private async init(): Promise<void> {
    const asked = this.rootPath;
    try {
      await fsList(asked);
    } catch (e) {
      if (this.disposed) return;
      this.showNotice('This folder could not be opened:', asked, errorText(e));
      return;
    }
    let info: RepoInfo;
    try {
      info = await repoRoot(asked);
    } catch (e) {
      if (this.disposed) return;
      this.showNotice('This folder could not be opened:', asked, errorText(e));
      return;
    }
    if (this.disposed) return;
    if (!info.isGit) {
      this.showNotice(`${asked} is not a git repo`);
      return;
    }
    if (!samePath(info.root, asked)) {
      this.rootPath = info.root;
      this.opts.onChange();
    }
    this.ready = true;
    this.startWatch(this.rootPath);
    this.refresh();
  }

  private startWatch(root: string): void {
    gitWatch(root).then(
      () => {
        if (this.disposed) void gitUnwatch(root).catch(() => {});
        else this.watchedRoot = root;
      },
      // Without the watcher the pane still refreshes on focus and when shown.
      () => {},
    );
  }

  private async load(): Promise<void> {
    const root = this.rootPath;
    let status: GitStatus;
    let log: GitCommit[];
    let lastFetch: GitLastFetch | null;
    let branches: GitBranchList | null;
    try {
      [status, log, lastFetch, branches] = await Promise.all([
        gitStatus(root),
        gitLog(root, LOG_COUNT),
        gitLastFetch(root).catch(() => null),
        // A failed branch read keeps the last list rather than blanking the tab.
        gitBranches(root).catch(() => this.branches),
      ]);
    } catch (e) {
      if (this.disposed) return;
      this.status = null;
      this.showNotice('Git could not read this repo:', root, errorText(e));
      return;
    }
    if (this.disposed) return;
    this.hideNotice();
    this.status = status;
    this.log = log;
    this.lastFetch = lastFetch;
    this.branches = branches;
    if (branches !== null) this.branchesView.setList(branches);
    this.reloadWorktrees();

    this.branch.setBranch(branchLine(status));
    this.branch.setButtons(remoteButtons(status, this.remoteOp));
    this.renderLastFetch();
    const staged = stagedList(status);
    const changes = changesList(status);
    this.stagedList.setRows(staged);
    this.changesList.setRows(changes);
    this.logList.setCommits(log);

    const undo = undoTarget(log, status)?.hash ?? null;
    if (undo !== this.undoHash) {
      this.undoHash = undo;
      if (this.undoError && !undo) showToast(this.undoError);
      this.undoError = null;
      this.updateUndo();
    }
    this.updateCommitEnabled();
    this.restoreSelection(staged, changes);
  }

  private renderLastFetch(): void {
    this.branch.setLastFetch(lastFetchText(this.lastFetch, Date.now()));
  }

  private async reloadLastFetch(): Promise<void> {
    const last = await gitLastFetch(this.rootPath).catch(() => null);
    if (this.disposed) return;
    this.lastFetch = last;
    this.renderLastFetch();
  }

  /** `upTo` applies to push only: push that commit and its ancestors rather than the branch. */
  private async runRemote(op: RemoteOp, upTo: string | null = null): Promise<void> {
    if (this.remoteOp !== null || this.status === null) return;
    this.remoteOp = op;
    this.branch.setButtons(remoteButtons(this.status, op));
    try {
      if (op === 'fetch') await gitFetch(this.rootPath);
      else if (op === 'pull') await gitPull(this.rootPath);
      else await gitPush(this.rootPath, upTo);
      if (this.disposed) return;
      if (this.remoteError) {
        this.commitBox.showError(null);
        this.remoteError = false;
      }
    } catch (e) {
      if (this.disposed) return;
      this.commitBox.showError(errorText(e));
      this.remoteError = true;
    } finally {
      this.remoteOp = null;
    }
    if (this.status !== null) this.branch.setButtons(remoteButtons(this.status, null));
    void this.reloadLastFetch();
    this.refresh();
  }

  /** Keeps the selected row's diff (re-fetched) while it still exists, else clears it. */
  private restoreSelection(staged: readonly GitRow[], changes: readonly GitRow[]): void {
    const sel = this.selection;
    if (sel === null) return;
    if (sel.type === 'commit') {
      // A commit's diff never changes, so it is only dropped once the commit leaves the log.
      if (!this.log.some((c) => c.hash === sel.hash)) this.clearSelection();
      return;
    }
    const row = (sel.staged ? staged : changes).find((r) => r.key === sel.key);
    if (row) void this.fetchDiff(() => gitDiff(this.rootPath, row.entry.path, sel.staged), false, row.entry.path);
    else this.clearSelection();
  }

  private clearSelection(): void {
    this.selection = null;
    this.diffGen++;
    this.stagedList.select(null);
    this.changesList.select(null);
    this.logList.select(null);
    this.diffView.clear();
    this.updateUndo();
  }

  /** Undo commit shows above the diff only while the selected commit is HEAD and the newest. */
  private updateUndo(): void {
    const sel = this.selection;
    const shown = sel?.type === 'commit' && sel.hash === this.undoHash;
    this.diffView.setUndo(shown, shown ? this.undoError : null);
  }

  private fileMenu(row: GitRow, staged: boolean): MenuEntry[] {
    const absolute = (r: GitRow): string => repoPath(this.rootPath, r.entry.path);
    return gitFileMenuItems(row, staged, {
      showDiff: (r) => {
        (staged ? this.stagedList : this.changesList).select(r.key);
        this.selectFile(r, staged);
      },
      toggle: (r) => void this.toggle([r], staged),
      openInEditor: (r) => void openInEditor(absolute(r)),
      copyPath: (r) => copyPath(absolute(r)),
      insertPath: (r) => this.opts.onInsertPath(absolute(r), this.rootPath),
    });
  }

  private selectFile(row: GitRow, staged: boolean): void {
    this.selection = { type: 'file', key: row.key, staged };
    (staged ? this.changesList : this.stagedList).select(null);
    this.logList.select(null);
    this.updateUndo();
    void this.fetchDiff(() => gitDiff(this.rootPath, row.entry.path, staged), true, row.entry.path);
  }

  private selectCommit(hash: string): void {
    this.selection = { type: 'commit', hash };
    this.stagedList.select(null);
    this.changesList.select(null);
    this.updateUndo();
    void this.fetchDiff(() => gitShow(this.rootPath, hash), true);
  }

  /** `path` is the selected file, which names the language of a diff text with no file header. */
  private async fetchDiff(run: () => Promise<GitDiff>, scrollTop: boolean, path?: string): Promise<void> {
    const gen = ++this.diffGen;
    const scroll = this.diffView.el.querySelector<HTMLElement>('.git-diff-body');
    const keep = scrollTop ? 0 : (scroll?.scrollTop ?? 0);
    try {
      const diff = await run();
      if (gen !== this.diffGen || this.disposed) return;
      this.diffView.show(diff, path);
      if (scroll && keep > 0) scroll.scrollTop = keep;
    } catch (e) {
      if (gen !== this.diffGen || this.disposed) return;
      this.diffView.showError(`Could not load the diff: ${errorText(e)}`);
    }
  }

  private async toggle(rows: readonly GitRow[], staged: boolean): Promise<void> {
    if (rows.length === 0) return;
    const paths = togglePaths(rows, staged);
    try {
      if (staged) await gitUnstage(this.rootPath, paths);
      else await gitStage(this.rootPath, paths);
    } catch (e) {
      showToast(`Could not ${staged ? 'unstage' : 'stage'}: ${errorText(e)}`);
    }
    this.refresh();
  }

  private updateCommitEnabled(): void {
    const ok = !this.committing && this.status !== null && canCommit(this.status, this.commitBox.message());
    this.commitBox.setEnabled(ok);
  }

  private async commit(message: string): Promise<void> {
    if (this.committing) return;
    this.committing = true;
    this.updateCommitEnabled();
    try {
      await gitCommit(this.rootPath, message);
      if (this.disposed) return;
      this.commitBox.clear();
    } catch (e) {
      if (this.disposed) return;
      this.commitBox.showError(errorText(e));
    } finally {
      this.committing = false;
    }
    this.updateCommitEnabled();
    this.refresh();
  }

  private async undo(hash: string): Promise<void> {
    const commit = this.log.find((c) => c.hash === hash);
    if (!commit) return;
    const ok = await this.opts.confirm(undoCommitConfirm(shortHash(hash), commit.subject, commit.pushed));
    if (!ok || this.disposed) return;
    try {
      const message = await gitUndoCommit(this.rootPath, hash);
      if (this.disposed) return;
      this.undoError = null;
      this.updateUndo();
      this.commitBox.setMessage(mergeUndoMessage(message, this.commitBox.message()));
      this.updateCommitEnabled();
    } catch (e) {
      if (this.disposed) return;
      this.undoError = errorText(e);
      this.updateUndo();
    }
    this.refresh();
  }

  private setBodyShown(shown: boolean): void {
    this.body.classList.toggle('regions-hidden', !shown);
  }

  private showNotice(head: string, path?: string, detail?: string): void {
    const parts: HTMLElement[] = [];
    const h = document.createElement('div');
    h.textContent = head;
    parts.push(h);
    if (path !== undefined) {
      const p = document.createElement('div');
      p.textContent = path;
      p.style.cssText = 'font-size: 14px; color: var(--git-fg); word-break: break-all;';
      parts.push(p);
    }
    if (detail !== undefined) {
      const d = document.createElement('div');
      d.textContent = detail;
      parts.push(d);
    }
    this.notice.replaceChildren(...parts);
    this.notice.hidden = false;
    this.setBodyShown(false);
  }

  private hideNotice(): void {
    this.notice.hidden = true;
    this.notice.replaceChildren();
    this.setBodyShown(true);
  }

  private onKeyDown(e: KeyboardEvent): void {
    const action = lookup(this.opts.keymap(), e);
    if (action && !textFieldOwns(action) && this.opts.dispatch(action)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  private applySplit(): void {
    this.left.style.flexBasis = `${this.split * 100}%`;
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
