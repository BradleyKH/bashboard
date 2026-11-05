// Confirm dialog text for closing or replacing panes that would lose work (docs/design.md
// sections 4.10, 4.11, 4.15). Pure, no DOM.
import type { ConfirmOptions } from './confirmDialog';
import type { PaneCard } from './dashboardModel';
import type { Run } from './forgeApi';
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
  forge: 'closes it',
  search: 'closes it',
  containers: 'closes it',
  ports: 'closes it',
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

/** A Forge pane's Cancel on a run (docs/design.md section 4.20); Re-run does not ask. */
export function cancelRunConfirm(run: Run, runNoun: string): ConfirmOptions {
  const what = run.name || run.title;
  return {
    title: `Cancel ${runNoun}`,
    body: [`Cancel ${what}${run.branch ? ` on ${run.branch}` : ''}? Jobs still running stop where they are.`],
    confirmLabel: `Cancel ${runNoun}`,
  };
}

/** Asked after `branch -d` refuses a branch that is not merged (docs/design.md section 4.13). */
export function deleteUnmergedConfirm(name: string, unmerged: number): ConfirmOptions {
  const commits = unmerged === 1 ? '1 commit' : `${unmerged} commits`;
  const body =
    unmerged > 0
      ? [`${name} is not merged, and ${commits} on it ${unmerged === 1 ? 'is' : 'are'} on no other branch.`]
      : [`Git says ${name} is not merged into its upstream or the current branch, though its commits are on other branches.`];
  body.push('Right after deleting, the toast can restore it.');
  return { title: 'Delete unmerged branch', body, confirmLabel: 'Delete anyway' };
}

/** Clean up removes branches whose upstream was deleted, which squash merges leave unmerged. */
export function cleanupGoneConfirm(names: readonly string[]): ConfirmOptions {
  const n = names.length;
  return {
    title: 'Clean up gone branches',
    body: [
      `Delete ${n} ${n === 1 ? 'branch' : 'branches'} whose remote branch was deleted? A squash-merged branch looks unmerged to git, so these are deleted even when unmerged.`,
      ...names,
    ],
    confirmLabel: 'Delete',
  };
}
