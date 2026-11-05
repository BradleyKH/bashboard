// Pure view model for the Accounts tab: one card per host, generic enough that the DOM view renders
// the action unions without knowing about providers (docs/design.md section 4.20).
import type { HostAuth, TokenSourceKind } from './forgeApi';
import { signInAnotherArgv } from './shipMenus';
import { BITBUCKET_SCOPES, BITBUCKET_TOKEN_URL } from './shipModel';

export type Severity = 'ok' | 'warn' | 'missing';

/** What a GitHub account row can do; each acts on `user`. */
export interface AccountAction {
  kind: 'makeActive' | 'signOut' | 'test';
  label: string;
  user: string;
}

export interface AccountRow {
  user: string;
  active: boolean;
  actions: AccountAction[];
}

/**
 * Card-level actions. `signIn` and `installGh` carry the argv to run in a new terminal pane;
 * `test` here has no account (Bitbucket, or GitHub signed in only through Git Credential Manager).
 */
export type CardAction =
  | { kind: 'signIn'; label: string; argv: string[] }
  | { kind: 'installGh'; label: string; argv: string[] }
  | { kind: 'addToken'; label: string }
  | { kind: 'replaceToken'; label: string }
  | { kind: 'removeToken'; label: string }
  | { kind: 'test'; label: string }
  | { kind: 'openUrl'; label: string; url: string }
  | { kind: 'copyScopes'; label: string; text: string };

export interface HostCard {
  host: string;
  title: string;
  /** One line saying who or what the pane would authenticate as. */
  status: string;
  severity: Severity;
  accounts: AccountRow[];
  actions: CardAction[];
  /** A secondary line under the status, or null. */
  note: string | null;
}

export const INSTALL_GH_ARGV: readonly string[] = ['winget', 'install', '--id', 'GitHub.cli', '-e'];

const SOURCE_NAME: Record<TokenSourceKind, string> = {
  ghCli: 'GitHub CLI',
  gitCredentialManager: 'Git Credential Manager',
  bashboardCredential: 'the Bashboard credential',
};

function title(h: HostAuth): string {
  if (h.provider === 'bitbucket') return 'Bitbucket';
  return h.host === 'github.com' ? 'GitHub' : `GitHub (${h.host})`;
}

function githubStatus(h: HostAuth): { status: string; severity: Severity } {
  const n = h.accounts.length;
  if (n > 0) {
    if (h.activeAccount) return { status: `Signed in as @${h.activeAccount} through GitHub CLI`, severity: 'ok' };
    return { status: `${n} ${n === 1 ? 'account' : 'accounts'} in GitHub CLI, none active`, severity: 'warn' };
  }
  if (h.tokenSource === 'gitCredentialManager') {
    return { status: "Using Git Credential Manager's sign-in", severity: 'ok' };
  }
  if (h.tokenSource) return { status: `Using ${SOURCE_NAME[h.tokenSource]}`, severity: 'ok' };
  return {
    status: h.ghInstalled ? 'Not signed in' : 'Not signed in, and GitHub CLI is not installed',
    severity: 'missing',
  };
}

function bitbucketStatus(h: HostAuth): { status: string; severity: Severity } {
  // A stored token wins over any other source, so it decides the status.
  if (h.bitbucketTokenStored) return { status: 'API token stored', severity: 'ok' };
  if (h.tokenSource === 'gitCredentialManager') {
    return {
      status: "Using Git Credential Manager's sign-in, which can't read pipelines or pull requests",
      severity: 'warn',
    };
  }
  if (h.tokenSource) return { status: `Using ${SOURCE_NAME[h.tokenSource]}`, severity: 'ok' };
  return { status: 'No API token stored', severity: 'missing' };
}

function githubCard(h: HostAuth): HostCard {
  const accounts: AccountRow[] = h.accounts.map((user) => {
    const active = user === h.activeAccount;
    const actions: AccountAction[] = [];
    if (!active) actions.push({ kind: 'makeActive', label: 'Make active', user });
    actions.push({ kind: 'signOut', label: 'Sign out', user }, { kind: 'test', label: 'Test', user });
    return { user, active, actions };
  });
  const actions: CardAction[] = [];
  if (!h.ghInstalled) {
    actions.push({ kind: 'installGh', label: 'Install GitHub CLI', argv: [...INSTALL_GH_ARGV] });
  } else {
    actions.push({
      kind: 'signIn',
      label: accounts.length > 0 ? 'Sign in another account' : 'Sign in',
      argv: signInAnotherArgv(h.host),
    });
  }
  // With no account rows there is no per-account Test, so the card offers one for the other source.
  if (accounts.length === 0 && h.tokenSource) actions.push({ kind: 'test', label: 'Test' });
  // Bashboard reads the saved account, but `gh` in a terminal prefers the variable.
  const note = h.ghEnvToken
    ? `${h.ghEnvToken} is set, so gh in a terminal uses that token; Bashboard uses the saved account shown here.`
    : null;
  return { host: h.host, title: title(h), ...githubStatus(h), accounts, actions, note };
}

function bitbucketCard(h: HostAuth): HostCard {
  const actions: CardAction[] = [
    h.bitbucketTokenStored
      ? { kind: 'replaceToken', label: 'Replace token' }
      : { kind: 'addToken', label: 'Add token' },
  ];
  if (h.bitbucketTokenStored) actions.push({ kind: 'removeToken', label: 'Remove token' });
  if (h.bitbucketTokenStored || h.tokenSource) actions.push({ kind: 'test', label: 'Test' });
  actions.push(
    { kind: 'openUrl', label: 'Open the API token page', url: BITBUCKET_TOKEN_URL },
    { kind: 'copyScopes', label: 'Copy scopes', text: BITBUCKET_SCOPES.join(' ') },
  );
  return { host: h.host, title: title(h), ...bitbucketStatus(h), accounts: [], actions, note: null };
}

export function hostCard(h: HostAuth): HostCard {
  return h.provider === 'bitbucket' ? bitbucketCard(h) : githubCard(h);
}
