import { item, separator, type MenuEntry } from './contextMenuModel';
import type { Capabilities, ForgeRepo, PullRequest, Run } from './forgeApi';
import { statusInfo } from './forgeModel';

export interface RunMenuHandlers {
  onOpen: () => void;
  onRerun: () => void;
  onRerunFailed: () => void;
  onCancel: () => void;
  onCopyLink: () => void;
}

export type RunActionKey = 'rerun' | 'rerunFailed' | 'cancel';

export interface RunActionState {
  /** The host can do it at all. */
  offered: boolean;
  /** The run's status allows it right now. */
  enabled: boolean;
}

/** Which run actions the host offers and which the run's status allows, for the row buttons and the menu. */
export function runActionStates(run: Run, caps: Capabilities): Record<RunActionKey, RunActionState> {
  const active = statusInfo(run.status).active;
  return {
    rerun: { offered: caps.rerun, enabled: !active },
    rerunFailed: { offered: caps.rerunFailed, enabled: run.status === 'failure' },
    cancel: { offered: caps.cancel, enabled: active },
  };
}

/**
 * The menu on a run row (docs/design.md section 4.20). What the host cannot do is left out;
 * what the run's status rules out right now is greyed, except Cancel, which only a live run has.
 */
export function runMenuItems(run: Run, caps: Capabilities, handlers: RunMenuHandlers): MenuEntry[] {
  const states = runActionStates(run, caps);
  const entries: MenuEntry[] = [item('Open in browser', handlers.onOpen)];
  const actions: MenuEntry[] = [];
  if (states.rerun.offered) actions.push(item('Re-run', handlers.onRerun, { enabled: states.rerun.enabled }));
  if (states.rerunFailed.offered) {
    actions.push(item('Re-run failed jobs', handlers.onRerunFailed, { enabled: states.rerunFailed.enabled }));
  }
  if (states.cancel.offered && states.cancel.enabled) actions.push(item('Cancel', handlers.onCancel));
  if (actions.length > 0) entries.push(separator(), ...actions);
  entries.push(separator(), item('Copy link', handlers.onCopyLink));
  return entries;
}

export interface PullMenuHandlers {
  onOpen: () => void;
  onCopyLink: () => void;
  onCopyBranch: () => void;
}

export function pullMenuItems(pull: PullRequest, handlers: PullMenuHandlers): MenuEntry[] {
  return [
    item('Open in browser', handlers.onOpen),
    separator(),
    item('Copy link', handlers.onCopyLink),
    item('Copy branch name', handlers.onCopyBranch, { enabled: pull.sourceBranch !== '' }),
  ];
}

export const ACCOUNT_NOTE =
  "Sets this repo's credential.username, which Git Credential Manager also uses for push and pull";

/** The command that signs another account in to the repo's host. */
export function signInAnotherArgv(host: string): string[] {
  return ['gh', 'auth', 'login', '--hostname', host, '--web'];
}

export interface AccountMenuHandlers {
  onPick: (user: string) => void;
  /** Runs `argv` in a new terminal pane. */
  onSignIn: (argv: string[]) => void;
}

/** The account chip's menu: one radio entry per signed-in account, a note on what picking does, and sign-in. */
export function accountMenuItems(repo: ForgeRepo, handlers: AccountMenuHandlers): MenuEntry[] {
  const entries: MenuEntry[] = repo.accounts.map((name) =>
    item(`@${name}`, () => handlers.onPick(name), { checked: name === repo.account }),
  );
  if (entries.length === 0) {
    entries.push(item(`No accounts signed in to ${repo.host}`, () => {}, { enabled: false }));
  } else {
    // The menu has no note-line entry, so the note is a disabled item.
    entries.push(item(ACCOUNT_NOTE, () => {}, { enabled: false }));
  }
  entries.push(
    separator(),
    item('Sign in another account', () => handlers.onSignIn(signInAnotherArgv(repo.host))),
  );
  return entries;
}
