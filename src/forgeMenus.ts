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

/**
 * The menu on a run row (docs/design.md section 4.20). What the host cannot do is left out;
 * what the run's status rules out right now is greyed, except Cancel, which only a live run has.
 */
export function runMenuItems(run: Run, caps: Capabilities, handlers: RunMenuHandlers): MenuEntry[] {
  const active = statusInfo(run.status).active;
  const entries: MenuEntry[] = [item('Open in browser', handlers.onOpen)];
  const actions: MenuEntry[] = [];
  if (caps.rerun) actions.push(item('Re-run', handlers.onRerun, { enabled: !active }));
  if (caps.rerunFailed) {
    actions.push(item('Re-run failed jobs', handlers.onRerunFailed, { enabled: run.status === 'failure' }));
  }
  if (caps.cancel && active) actions.push(item('Cancel', handlers.onCancel));
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
