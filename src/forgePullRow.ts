import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import type { PullRequest, ReviewState } from './forgeApi';
import { relativeTime, statusInfo } from './forgeModel';

export interface PullRowHandlers {
  onOpen: (pull: PullRequest) => void;
  menuItems: (pull: PullRequest) => MenuEntry[];
}

const REVIEW_LABELS: Record<ReviewState, string> = {
  approved: 'Approved',
  changesRequested: 'Changes requested',
  pending: 'Review pending',
};

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** One pull request in the Pull requests list (docs/design.md section 4.20). */
export class ForgePullRow {
  readonly el: HTMLElement;
  private current: PullRequest;

  private readonly number: HTMLElement;
  private readonly title: HTMLElement;
  private readonly draft: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly review: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly when: HTMLElement;

  constructor(pull: PullRequest, handlers: PullRowHandlers) {
    this.current = pull;
    this.el = document.createElement('div');
    this.el.className = 'forge-pull';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'link');

    const main = document.createElement('div');
    main.className = 'forge-pull-main';
    const head = document.createElement('div');
    head.className = 'forge-pull-head';
    this.number = document.createElement('span');
    this.number.className = 'forge-pull-number';
    this.title = document.createElement('span');
    this.title.className = 'forge-pull-title';
    this.draft = document.createElement('span');
    this.draft.className = 'forge-badge';
    this.draft.textContent = 'Draft';
    head.append(this.number, this.title, this.draft);
    this.meta = document.createElement('div');
    this.meta.className = 'forge-pull-meta';
    main.append(head, this.meta);

    const side = document.createElement('div');
    side.className = 'forge-pull-side';
    this.review = document.createElement('span');
    this.review.className = 'forge-review';
    this.checks = document.createElement('span');
    this.checks.setAttribute('aria-hidden', 'true');
    this.when = document.createElement('span');
    this.when.className = 'forge-pull-when';
    side.append(this.review, this.checks, this.when);

    this.el.append(main, side);
    this.el.addEventListener('click', () => handlers.onOpen(this.current));
    this.el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      handlers.onOpen(this.current);
    });
    attachContextMenu(this.el, () => ({ entries: handlers.menuItems(this.current), target: this.el }));

    this.update(pull, Date.now());
  }

  get pull(): PullRequest {
    return this.current;
  }

  update(pull: PullRequest, nowMs: number): void {
    this.current = pull;
    setText(this.number, `#${pull.number}`);
    setText(this.title, pull.title);
    if (this.title.title !== pull.title) this.title.title = pull.title;
    this.draft.hidden = !pull.draft;
    setText(this.meta, `${pull.author}  ·  ${pull.sourceBranch} → ${pull.targetBranch}`);

    const review = pull.reviewDecision;
    this.review.hidden = review === null;
    this.review.className = `forge-review${review ? ` forge-review--${review}` : ''}`;
    setText(this.review, review ? REVIEW_LABELS[review] : '');

    const checks = pull.checks;
    this.checks.hidden = checks === null;
    if (checks !== null) {
      const info = statusInfo(checks);
      const cls = `forge-status forge-status--${info.modifier}`;
      if (this.checks.className !== cls) this.checks.className = cls;
      const tip = `Checks: ${info.label}`;
      if (this.checks.title !== tip) this.checks.title = tip;
    }

    setText(this.when, relativeTime(pull.updatedAt, nowMs));
  }
}
