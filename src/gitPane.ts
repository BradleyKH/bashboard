import './gitPane.css';
import type { ConfirmOptions } from './confirmDialog';
import { openInEditor } from './editors';
import { samePath } from './favorites';
import {
  gitCommit,
  gitDiff,
  gitLog,
  gitShow,
  gitStage,
  gitStatus,
  gitUndoCommit,
  gitUnstage,
  gitUnwatch,
  gitWatch,
  onGitChanged,
  type GitCommit,
  type GitDiff,
  type GitStatus,
} from './gitApi';
import { GitCommitBox } from './gitCommitBox';
import { GitDiffView } from './gitDiffView';
import { GitFileList } from './gitFileList';
import { GitLogList } from './gitLogList';
import {
  branchLine,
  canCommit,
  changesList,
  mergeUndoMessage,
  shortHash,
  stagedList,
  undoTarget,
  type GitRow,
} from './gitModel';
import { lookup, type Action, type Keymap } from './keymap';
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

/** A renamed row's original path goes with it, so unstaging a rename unstages both halves. */
function pathsOf(rows: readonly GitRow[]): string[] {
  const out: string[] = [];
  for (const { entry } of rows) {
    if (entry.origPath) out.push(entry.origPath);
    out.push(entry.path);
  }
  return out;
}

/** A repo's changes, staging, commits, and diffs (docs/design.md section 4.13). */
export class GitPane implements PaneView {
  readonly kind = 'git' as const;
  readonly paneId: string;
  private readonly opts: GitPaneOptions;
  private readonly host: HTMLElement;
  private readonly body: HTMLElement;
  private readonly left: HTMLElement;
  private readonly right: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly branch: HTMLElement;
  private readonly commitBox: GitCommitBox;
  private readonly stagedList: GitFileList;
  private readonly changesList: GitFileList;
  private readonly logList: GitLogList;
  private readonly diffView: GitDiffView;
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
  private disposed = false;
  private readonly listeners: Array<() => void> = [];

  constructor(opts: GitPaneOptions) {
    this.opts = opts;
    this.host = opts.host;
    this.paneId = opts.paneId;
    this.settings = opts.settings;
    this.rootPath = opts.root;
    this.expanded = opts.expanded;

    this.host.style.display = 'flex';
    this.host.style.flexDirection = 'column';
    this.body = document.createElement('div');
    this.body.className = 'pane-body git-body';
    this.body.tabIndex = -1;

    this.left = document.createElement('div');
    this.left.className = 'git-left';
    this.branch = document.createElement('div');
    this.branch.className = 'git-branch';
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
      onOpen: (row) => void openInEditor(repoPath(this.rootPath, row.entry.path)),
    });
    this.changesList = new GitFileList({
      title: 'Changes',
      staged: false,
      onSelect: (row) => this.selectFile(row, false),
      onToggle: (row) => void this.toggle([row], false),
      onToggleAll: (rows) => void this.toggle(rows, false),
      onOpen: (row) => void openInEditor(repoPath(this.rootPath, row.entry.path)),
    });
    this.logList = new GitLogList({
      onSelect: (hash) => this.selectCommit(hash),
    });
    this.left.append(this.branch, this.commitBox.el, this.stagedList.el, this.changesList.el, this.logList.el);

    this.right = document.createElement('div');
    this.right.className = 'git-right';
    this.diffView = new GitDiffView(() => {
      if (this.selection?.type === 'commit') void this.undo(this.selection.hash);
    }, textZoom('gitDiff'));
    this.right.append(this.diffView.el);

    this.notice = document.createElement('div');
    this.notice.className = 'git-notice';

    this.body.append(this.left, this.right, this.notice);
    this.host.appendChild(this.body);
    // Nothing shows until the root is checked, so a non-repo never flashes an empty pane.
    this.setBodyShown(false);
    this.notice.hidden = true;

    this.listen(this.host, 'focusin', () => opts.onFocus());
    this.listen(this.host, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, 'focus', () => this.refresh());

    onGitChanged((root) => {
      if (samePath(root, this.rootPath)) this.refresh();
    }).then(
      (off) => {
        if (this.disposed) off();
        else this.unlistenChanged = off;
      },
      () => {},
    );

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

  /** The `git` saved-pane fields. */
  saved(): { root: string } {
    return { root: this.rootPath };
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
    try {
      [status, log] = await Promise.all([gitStatus(root), gitLog(root, LOG_COUNT)]);
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

    this.branch.textContent = branchLine(status);
    this.branch.title = this.branch.textContent;
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
    if (row) void this.fetchDiff(() => gitDiff(this.rootPath, row.entry.path, sel.staged), false);
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

  private selectFile(row: GitRow, staged: boolean): void {
    this.selection = { type: 'file', key: row.key, staged };
    (staged ? this.changesList : this.stagedList).select(null);
    this.logList.select(null);
    this.updateUndo();
    void this.fetchDiff(() => gitDiff(this.rootPath, row.entry.path, staged), true);
  }

  private selectCommit(hash: string): void {
    this.selection = { type: 'commit', hash };
    this.stagedList.select(null);
    this.changesList.select(null);
    this.updateUndo();
    void this.fetchDiff(() => gitShow(this.rootPath, hash), true);
  }

  private async fetchDiff(run: () => Promise<GitDiff>, scrollTop: boolean): Promise<void> {
    const gen = ++this.diffGen;
    const scroll = this.diffView.el.querySelector<HTMLElement>('.git-diff-body');
    const keep = scrollTop ? 0 : (scroll?.scrollTop ?? 0);
    try {
      const diff = await run();
      if (gen !== this.diffGen || this.disposed) return;
      this.diffView.show(diff);
      if (scroll && keep > 0) scroll.scrollTop = keep;
    } catch (e) {
      if (gen !== this.diffGen || this.disposed) return;
      this.diffView.showError(`Could not load the diff: ${errorText(e)}`);
    }
  }

  private async toggle(rows: readonly GitRow[], staged: boolean): Promise<void> {
    if (rows.length === 0) return;
    const paths = pathsOf(rows);
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

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.listeners.push(() => target.removeEventListener(type, fn));
  }
}
