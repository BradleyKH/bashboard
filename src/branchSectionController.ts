import type { BranchSection } from './branchSection';
import { pickPull, type BranchSectionState } from './branchSectionModel';
import { branchSizeStore } from './branchSizeStore';
import { samePath } from './favorites';
import { forgePulls, forgeRuns, type PullRequest, type Run } from './forgeApi';
import { onGitChanged } from './gitApi';
import type { RepoInfo } from './repoFiles';
import { statusInfo } from './shipModel';
import { FAST_POLL_MS } from './shipOverviewModel';
import { gitWorktreeDetail, type WorktreeDetail } from './worktreeApi';

const STORE_KEY = 'branch-section';
const DETAIL_DEBOUNCE_MS = 200;
/** A metadata change also fires for local commits and fetches; only a push moves the run list, so the forge is asked at most this often. */
const CI_THROTTLE_MS = 30_000;

type Ci = Extract<BranchSectionState, { kind: 'repo' }>['ci'];

/** The newest run by creation time; hosts disagree on list order. */
function latestRun(runs: readonly Run[]): Run | null {
  let best: Run | null = null;
  for (const r of runs) if (best === null || r.createdAt > best.createdAt) best = r;
  return best;
}

function ciFor(run: Run): NonNullable<Ci> {
  const info = statusInfo(run.status);
  const name = run.name || run.title || 'CI';
  const number = run.number === null ? '' : ` #${run.number}`;
  return { label: `${name}${number} ${info.label.toLowerCase()}`, status: info.modifier, url: run.webUrl || null };
}

/**
 * Feeds the dashboard's Branch section: follows the repo the dashboard follows, holds the branch
 * size store's interest in its worktree while the section is wanted, and fetches the worktree's
 * detail, its branch's latest CI run, and its branch's pull request.
 */
export class BranchSectionController {
  private root: string | null = null;
  private repoBranch: string | null = null;
  private detail: WorktreeDetail | null = null;
  private ci: Ci = null;
  private pull: PullRequest | null = null;
  private pullToken = 0;
  /** The latest run is queued or running, so it is polled and a return to view rechecks it at once. */
  private ciActive = false;
  private wanted = false;
  private listening = false;
  private detailTimer: ReturnType<typeof setTimeout> | undefined;
  private detailToken = 0;
  private ciToken = 0;
  private ciBranch: string | null = null;
  private ciAt = 0;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly section: BranchSection) {
    branchSizeStore.subscribe(() => this.render());
  }

  /** The dashboard's repo: the focused or last focused folder's, already resolved to its worktree root. */
  setRepo(repo: RepoInfo | null): void {
    const root = repo !== null && repo.isGit ? repo.root : null;
    this.repoBranch = repo?.branch ?? null;
    if (root === this.root || (root !== null && this.root !== null && samePath(root, this.root))) {
      this.render();
      return;
    }
    this.root = root;
    this.detail = null;
    this.ci = null;
    this.pull = null;
    this.ciActive = false;
    this.ciBranch = null;
    this.ciAt = 0;
    this.ciToken++;
    this.pullToken++;
    this.detailToken++;
    clearTimeout(this.pollTimer);
    this.syncStore();
    if (this.wanted) {
      this.fetchDetail();
      this.fetchCi(true);
    }
    this.render();
  }

  /** Shown, expanded, on screen, and the window shown; otherwise nothing is watched or polled. */
  setWanted(wanted: boolean): void {
    if (wanted === this.wanted) return;
    this.wanted = wanted;
    this.syncStore();
    if (wanted) {
      this.listen();
      this.fetchDetail();
      this.fetchCi(this.ciActive);
    } else {
      clearTimeout(this.detailTimer);
      clearTimeout(this.pollTimer);
    }
  }

  private syncStore(): void {
    branchSizeStore.setWanted(STORE_KEY, this.wanted && this.root !== null ? [this.root] : []);
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    // The controller lives for the whole session, so the subscription is never released.
    try {
      void Promise.resolve(onGitChanged((root, metadata) => this.onChanged(root, metadata))).catch(() => {});
    } catch {
      // No Tauri runtime (a plain browser): nothing emits.
    }
  }

  private onChanged(root: string, metadata: boolean): void {
    if (!this.wanted || this.root === null || !samePath(root, this.root)) return;
    clearTimeout(this.detailTimer);
    this.detailTimer = setTimeout(() => this.fetchDetail(), DETAIL_DEBOUNCE_MS);
    if (metadata) this.fetchCi(false);
  }

  private branch(): string | null {
    return this.detail?.branch ?? this.repoBranch;
  }

  private fetchDetail(): void {
    const root = this.root;
    if (root === null) return;
    const token = ++this.detailToken;
    gitWorktreeDetail(root).then(
      (detail) => {
        if (token !== this.detailToken) return;
        this.detail = detail;
        // A checkout changes the branch the CI row describes.
        if (detail.branch !== this.ciBranch) this.fetchCi(true);
        this.render();
      },
      () => {
        if (token !== this.detailToken) return;
        this.detail = null;
        this.render();
      },
    );
  }

  /**
   * `force` skips the throttle, for a new worktree or branch. The pull request is read with the
   * runs, but not by the poll of an active run (`poll`): it changes slowly and costs more on some hosts.
   */
  private fetchCi(force: boolean, poll = false): void {
    const root = this.root;
    if (root === null || !this.wanted) return;
    const branch = this.branch();
    if (!force && branch === this.ciBranch && Date.now() - this.ciAt < CI_THROTTLE_MS) return;
    clearTimeout(this.pollTimer);
    const token = ++this.ciToken;
    this.ciBranch = branch;
    this.ciAt = Date.now();
    if (branch === null) {
      this.ci = null;
      this.pull = null;
      this.pullToken++;
      this.ciActive = false;
      this.render();
      return;
    }
    if (!poll) this.fetchPull(root, branch);
    forgeRuns(root, branch).then(
      (runs) => {
        if (token !== this.ciToken) return;
        const run = latestRun(runs);
        this.ci = run === null ? null : ciFor(run);
        this.ciActive = run !== null && statusInfo(run.status).active;
        if (this.ciActive && this.wanted) {
          this.pollTimer = setTimeout(() => this.fetchCi(true, true), FAST_POLL_MS);
        }
        this.render();
      },
      () => {
        if (token !== this.ciToken) return;
        // No forge, no account, or a host error: the row is left out rather than shown stale.
        this.ci = null;
        this.ciActive = false;
        this.render();
      },
    );
  }

  private fetchPull(root: string, branch: string): void {
    const token = ++this.pullToken;
    forgePulls(root, false, branch).then(
      (list) => {
        if (token !== this.pullToken) return;
        this.pull = pickPull(list.items, branch);
        this.render();
      },
      () => {
        if (token !== this.pullToken) return;
        // Same as the CI row: no forge or a host error leaves the row out.
        this.pull = null;
        this.render();
      },
    );
  }

  private render(): void {
    if (this.root === null) {
      this.section.update({ kind: 'none' });
      return;
    }
    this.section.update({
      kind: 'repo',
      worktree: this.root,
      branch: this.branch(),
      detail: this.detail,
      size: branchSizeStore.sizeFor(this.root),
      threshold: branchSizeStore.threshold(),
      ci: this.ci,
      pull: this.pull,
    });
  }
}
