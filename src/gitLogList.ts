import type { GitCommit } from './gitApi';
import { relativeTime, shortHash } from './gitModel';

export interface GitLogListOptions {
  /** A commit row was clicked; the caller shows its diff. */
  onSelect: (hash: string) => void;
}

/** "Recent commits" (docs/design.md section 4.13). */
export class GitLogList {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private commits: GitCommit[] = [];
  private selectedHash: string | null = null;

  constructor(private readonly opts: GitLogListOptions) {
    this.el = document.createElement('div');
    this.el.className = 'git-log';
    const head = document.createElement('div');
    head.className = 'git-section-head';
    const title = document.createElement('span');
    title.className = 'git-section-title';
    title.textContent = 'Recent commits';
    head.append(title);
    this.list = document.createElement('div');
    this.list.className = 'git-rows';
    this.list.setAttribute('role', 'listbox');
    this.el.append(head, this.list);
    this.render();
  }

  /** Replaces the commits (newest first); relative times are computed at this call. */
  setCommits(commits: readonly GitCommit[]): void {
    this.commits = [...commits];
    this.render();
  }

  /** Highlights a commit without firing `onSelect`; null clears. */
  select(hash: string | null): void {
    this.selectedHash = hash;
    this.render();
  }

  private render(): void {
    if (this.commits.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'git-empty';
      empty.textContent = 'No commits yet';
      this.list.replaceChildren(empty);
      return;
    }
    const now = Date.now();
    this.list.replaceChildren(...this.commits.map((c) => this.renderRow(c, now)));
  }

  private renderRow(c: GitCommit, now: number): HTMLElement {
    const el = document.createElement('div');
    el.className = 'git-row git-commit-row';
    if (c.hash === this.selectedHash) el.classList.add('selected');
    el.setAttribute('role', 'option');
    el.addEventListener('click', () => {
      this.selectedHash = c.hash;
      this.render();
      this.opts.onSelect(c.hash);
    });

    const subject = document.createElement('span');
    subject.className = 'git-row-path';
    subject.textContent = c.subject;
    subject.title = c.subject;

    const meta = document.createElement('span');
    meta.className = 'git-row-meta';
    meta.textContent = `${shortHash(c.hash)} · ${relativeTime(c.time, now)}`;

    el.append(subject);
    if (!c.pushed) {
      const mark = document.createElement('span');
      mark.className = 'git-unpushed';
      mark.textContent = 'unpushed';
      mark.title = 'No remote-tracking branch contains this commit';
      el.append(mark);
    }
    el.append(meta);
    return el;
  }
}
