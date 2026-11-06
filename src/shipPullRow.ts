import { attachContextMenu } from './contextMenu';
import type { MenuEntry } from './contextMenuModel';
import type { PullRequest, ReviewState } from './forgeApi';
import { approvedByText, relativeTime, statusInfo } from './shipModel';

export interface PullRowHandlers {
  onOpen: (pull: PullRequest) => void;
  menuItems: (pull: PullRequest) => MenuEntry[];
}

const REVIEW_LABELS: Record<ReviewState, string> = {
  approved: 'Approved',
  changesRequested: 'Changes requested',
  pending: 'Review pending',
};

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** One pull request in the Pull requests list (docs/design/ship.md section 4.20). */
export class ShipPullRow {
  readonly el: HTMLElement;
  private current: PullRequest;

  private readonly number: HTMLElement;
  private readonly title: HTMLElement;
  private readonly draft: HTMLElement;
  /** Merged or Closed; hidden on an open one. */
  private readonly stateBadge: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly review: HTMLElement;
  private readonly checks: HTMLElement;
  private readonly when: HTMLElement;

  constructor(pull: PullRequest, handlers: PullRowHandlers) {
    this.current = pull;
    this.el = document.createElement('div');
    this.el.className = 'ship-pull';
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'link');

    const main = document.createElement('div');
    main.className = 'ship-pull-main';
    const head = document.createElement('div');
    head.className = 'ship-pull-head';
    this.number = document.createElement('span');
    this.number.className = 'ship-pull-number';
    this.title = document.createElement('span');
    this.title.className = 'ship-pull-title';
    this.draft = document.createElement('span');
    this.draft.className = 'ship-badge';
    this.draft.textContent = 'Draft';
    this.stateBadge = document.createElement('span');
    head.append(this.number, this.title, this.draft, this.stateBadge);
    this.meta = document.createElement('div');
    this.meta.className = 'ship-pull-meta';
    main.append(head, this.meta);

    const side = document.createElement('div');
    side.className = 'ship-pull-side';
    this.review = document.createElement('span');
    this.review.className = 'ship-review';
    this.checks = document.createElement('span');
    this.checks.setAttribute('aria-hidden', 'true');
    this.when = document.createElement('span');
    this.when.className = 'ship-pull-when';
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
    this.draft.hidden = !pull.draft || pull.state !== 'open';
    this.stateBadge.hidden = pull.state === 'open';
    const stateClass = `ship-badge ship-badge--${pull.state}`;
    if (this.stateBadge.className !== stateClass) this.stateBadge.className = stateClass;
    setText(this.stateBadge, pull.state === 'merged' ? 'Merged' : pull.state === 'closed' ? 'Closed' : '');
    this.el.classList.toggle('done', pull.state !== 'open');
    setText(this.meta, `${pull.author}  ·  ${pull.sourceBranch} → ${pull.targetBranch}`);

    const review = pull.reviewDecision;
    this.review.hidden = review === null;
    this.review.className = `ship-review${review ? ` ship-review--${review}` : ''}`;
    setText(this.review, review ? REVIEW_LABELS[review] : '');
    const reviewTip = review === 'approved' ? capitalize(approvedByText(pull)) : '';
    if (this.review.title !== reviewTip) this.review.title = reviewTip;

    const checks = pull.checks;
    this.checks.hidden = checks === null && !pull.checksPending;
    if (checks !== null || pull.checksPending) {
      const info = checks !== null ? statusInfo(checks) : { modifier: 'pending', label: 'loading' };
      const cls = `ship-status ship-status--${info.modifier}`;
      if (this.checks.className !== cls) this.checks.className = cls;
      const tip = `Checks: ${info.label}`;
      if (this.checks.title !== tip) this.checks.title = tip;
    }

    setText(this.when, relativeTime(pull.updatedAt, nowMs));
  }
}
