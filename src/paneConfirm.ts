// Confirm dialog text for closing or replacing panes that would lose work (docs/design.md
// sections 4.10, 4.11, 4.15). Pure, no DOM.
import type { ConfirmOptions } from './confirmDialog';
import type { PaneCard } from './dashboardModel';
import { paneKindInfo, type PaneKind } from './paneKinds';

function describePane(card: PaneCard): string {
  return card.path && card.path !== card.title ? `${card.title} (${card.path})` : card.title;
}

export function closeTabConfirm(tabTitle: string, busy: PaneCard[]): ConfirmOptions {
  const n = busy.length;
  return {
    title: 'Close tab',
    body: [`Closing ${tabTitle} closes ${n} ${n === 1 ? 'pane' : 'panes'} still in use:`, ...busy.map(describePane)],
    confirmLabel: 'Close tab',
  };
}

export function closePadConfirm(card: PaneCard): ConfirmOptions {
  return {
    title: 'Close scratch pad',
    body: [`Closing ${card.title} deletes its text.`],
    confirmLabel: 'Close',
  };
}

/** What replacing a pane of each kind loses; only kinds that confirm are ever asked about. */
const REPLACE_LOSES: Record<PaneKind, string> = {
  terminal: 'ends what is running in it',
  scratch: 'deletes its text',
  files: 'closes it',
  git: 'closes it',
  search: 'closes it',
  containers: 'closes it',
};

/** The undo dialog for the newest commit (docs/design.md section 4.13). */
export function undoCommitConfirm(shortHash: string, subject: string, pushed: boolean): ConfirmOptions {
  const body = [`Undoing commit ${shortHash} (${subject}) keeps its changes staged and puts its message back in the commit box.`];
  if (pushed) body.push('This commit is already pushed, so publishing the result will need a force push.');
  return {
    title: 'Undo last commit',
    body,
    confirmLabel: 'Undo',
  };
}

export function replaceConfirm(card: PaneCard, kind: PaneKind): ConfirmOptions {
  const loses = REPLACE_LOSES[card.kind];
  return {
    title: 'Change pane kind',
    body: [`Replacing ${describePane(card)} with a ${paneKindInfo(kind).label.toLowerCase()} pane ${loses}.`],
    confirmLabel: 'Replace',
  };
}
