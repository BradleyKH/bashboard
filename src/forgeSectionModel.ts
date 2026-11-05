// What a dashboard Forge item says, and when the section reads "All clear" (docs/design.md section 4.20).
// Pure, no DOM.
import type { RunStatus } from './forgeApi';
import type { DashboardItem } from './forgeOverviewModel';
import type { OverviewEntry } from './forgeOverviewStore';

/** `owner/name` from a pin identity (`<host>/<path segments>`); the host is kept off the narrow dashboard. */
export function repoLabel(repo: string): string {
  const i = repo.indexOf('/');
  return i < 0 ? repo : repo.slice(i + 1);
}

export function itemText(item: DashboardItem): string {
  if (item.kind === 'branch') return `${item.branch} failed`;
  const n = `#${item.pull.number}`;
  if (item.kind === 'review') return `${n} needs your review`;
  return item.pull.reviewDecision === 'changesRequested' ? `${n} changes requested` : `${n} checks failing`;
}

/** The status icon's state: every item but a review request is a failure; a review has no state of its own. */
export function itemStatus(item: DashboardItem): RunStatus {
  return item.kind === 'review' ? 'other' : 'failure';
}

/** The failing run's title or the pull request's title, for the row's tooltip. */
export function itemTitle(item: DashboardItem): string {
  return item.kind === 'branch' ? item.run.title : item.pull.title;
}

/**
 * Whether to say "All clear": at least one pin has loaded and nothing needs attention. A pin that is
 * still loading or errored has not been checked, so it never counts toward clear.
 */
export function isAllClear(entries: readonly OverviewEntry[], items: readonly DashboardItem[]): boolean {
  return items.length === 0 && entries.some((e) => e.row !== null);
}
