// Pure view model for the Accounts tab: one card per host, generic enough that the DOM view renders
// the action unions without knowing about providers (docs/design/ship.md section 4.20).
import type { HostAuth, ProviderKind, TokenSourceKind } from './forgeApi';
import { signInAnotherArgv } from './shipMenus';
import { AZURE_DEVOPS_SCOPE_INFO, BITBUCKET_SCOPES, BITBUCKET_TOKEN_URL } from './shipModel';

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

/** What an Azure DevOps stored-token row can do; each acts on `org`. */
export interface TokenAction {
  kind: 'replaceToken' | 'removeToken' | 'test';
  label: string;
  org: string;
}

export interface TokenRow {
  org: string;
  actions: TokenAction[];
}

/**
 * Card-level actions. `signIn` and `installCli` carry the argv to run in a new terminal pane;
 * `test` here has no account (Bitbucket, GitLab, Azure DevOps, or GitHub signed in only through
 * Git Credential Manager); `signOut` is GitLab's, whose CLI holds one account per host.
 * `openTokenPage` needs an organization the view resolves when clicked, so it has no URL.
 */
export type CardAction =
  | { kind: 'signIn'; label: string; argv: string[] }
  | { kind: 'installCli'; label: string; argv: string[] }
  | { kind: 'signOut'; label: string; user: string }
  | { kind: 'addToken'; label: string }
  | { kind: 'replaceToken'; label: string }
  | { kind: 'removeToken'; label: string }
  | { kind: 'test'; label: string }
  | { kind: 'openUrl'; label: string; url: string }
  | { kind: 'openTokenPage'; label: string }
  | { kind: 'copyScopes'; label: string; text: string };

export interface HostCard {
  host: string;
  title: string;
  /** Shown ahead of the status on a card no signal detected, else null. */
  undetected: string | null;
  /** The detection reasons, for the card's tooltip; null when undetected. */
  tooltip: string | null;
  /** One line saying who or what the pane would authenticate as. */
  status: string;
  severity: Severity;
  accounts: AccountRow[];
  tokens: TokenRow[];
  actions: CardAction[];
  /** A secondary line under the status, or null. */
  note: string | null;
}

export const INSTALL_GH_ARGV: readonly string[] = ['winget', 'install', '--id', 'GitHub.cli', '-e'];
export const INSTALL_GLAB_ARGV: readonly string[] = ['winget', 'install', '--id', 'GLab.GLab', '-e'];
export const AZ_LOGIN_ARGV: readonly string[] = ['az', 'login'];
export const NOT_DETECTED = 'Not detected on this machine';
export const AZURE_DEVOPS_HOST = 'dev.azure.com';

const SOURCE_NAME: Record<TokenSourceKind, string> = {
  ghCli: 'GitHub CLI',
  glabCli: 'GitLab CLI',
  azCli: 'Azure CLI',
  gitCredentialManager: 'Git Credential Manager',
  bashboardCredential: 'the Bashboard credential',
  environment: 'an environment variable',
};

export function glabSignInArgv(host: string): string[] {
  return ['glab', 'auth', 'login', '--hostname', host];
}

export function azureTokenPageUrl(org: string): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}/_usersSettings/tokens`;
}

/** An Azure DevOps organization as it is stored and typed: trimmed and lowercased. */
export function normalizeOrg(org: string): string {
  return org.trim().toLowerCase();
}

function title(h: HostAuth): string {
  switch (h.provider) {
    case 'bitbucket':
      return 'Bitbucket';
    case 'azureDevOps':
      return 'Azure DevOps';
    case 'gitlab':
      return h.host === 'gitlab.com' ? 'GitLab' : `GitLab (${h.host})`;
    case 'github':
      return h.host === 'github.com' ? 'GitHub' : `GitHub (${h.host})`;
  }
}

function storedOrgs(h: HostAuth): string[] {
  return h.storedTokens.flatMap((t) => (t.org ? [t.org] : []));
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
    status: h.cliInstalled ? 'Not signed in' : 'Not signed in, and GitHub CLI is not installed',
    severity: 'missing',
  };
}

function gitlabStatus(h: HostAuth): { status: string; severity: Severity } {
  if (h.activeAccount) return { status: `Signed in as @${h.activeAccount} through GitLab CLI`, severity: 'ok' };
  if (h.tokenSource === 'gitCredentialManager') {
    return { status: "Using Git Credential Manager's sign-in", severity: 'ok' };
  }
  if (h.tokenSource) return { status: `Using ${SOURCE_NAME[h.tokenSource]}`, severity: 'ok' };
  return {
    status: h.cliInstalled ? 'Not signed in' : 'Not signed in, and GitLab CLI is not installed',
    severity: 'missing',
  };
}

function bitbucketStatus(h: HostAuth): { status: string; severity: Severity } {
  // A stored token wins over any other source, so it decides the status.
  if (h.storedTokens.length > 0) return { status: 'API token stored', severity: 'ok' };
  if (h.tokenSource === 'gitCredentialManager') {
    return {
      status: "Using Git Credential Manager's sign-in, which can't read pipelines or pull requests",
      severity: 'warn',
    };
  }
  if (h.tokenSource) return { status: `Using ${SOURCE_NAME[h.tokenSource]}`, severity: 'ok' };
  return { status: 'No API token stored', severity: 'missing' };
}

function azureStatus(h: HostAuth): { status: string; severity: Severity } {
  // A stored PAT outranks every other source for its organization, so the list leads.
  const orgs = storedOrgs(h);
  if (orgs.length > 0) {
    return { status: `Personal access token stored for ${orgs.join(', ')}`, severity: 'ok' };
  }
  switch (h.tokenSource) {
    case 'environment':
      return { status: 'Using the AZURE_DEVOPS_EXT_PAT environment variable', severity: 'ok' };
    case 'azCli':
      return {
        status: h.activeAccount ? `Signed in to Azure CLI as ${h.activeAccount}` : 'Signed in to Azure CLI',
        severity: 'ok',
      };
    case 'gitCredentialManager':
      return { status: "Using Git Credential Manager's sign-in", severity: 'ok' };
    case null:
      return {
        status: h.cliInstalled
          ? 'No personal access token stored'
          : 'No personal access token stored, and Azure CLI is not installed',
        severity: 'missing',
      };
    default:
      return { status: `Using ${SOURCE_NAME[h.tokenSource]}`, severity: 'ok' };
  }
}

type CardBody = Omit<HostCard, 'host' | 'title' | 'undetected' | 'tooltip'>;

function githubCard(h: HostAuth): CardBody {
  const accounts: AccountRow[] = h.accounts.map((user) => {
    const active = user === h.activeAccount;
    const actions: AccountAction[] = [];
    if (!active) actions.push({ kind: 'makeActive', label: 'Make active', user });
    actions.push({ kind: 'signOut', label: 'Sign out', user }, { kind: 'test', label: 'Test', user });
    return { user, active, actions };
  });
  const actions: CardAction[] = [];
  if (!h.cliInstalled) {
    actions.push({ kind: 'installCli', label: 'Install GitHub CLI', argv: [...INSTALL_GH_ARGV] });
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
  return { ...githubStatus(h), accounts, tokens: [], actions, note };
}

function gitlabCard(h: HostAuth): CardBody {
  const actions: CardAction[] = [];
  if (!h.cliInstalled) {
    actions.push({ kind: 'installCli', label: 'Install GitLab CLI', argv: [...INSTALL_GLAB_ARGV] });
  } else if (h.activeAccount) {
    actions.push({ kind: 'signOut', label: 'Sign out', user: h.activeAccount });
  } else {
    actions.push({ kind: 'signIn', label: 'Sign in', argv: glabSignInArgv(h.host) });
  }
  if (h.activeAccount || h.tokenSource) actions.push({ kind: 'test', label: 'Test' });
  return { ...gitlabStatus(h), accounts: [], tokens: [], actions, note: null };
}

function bitbucketCard(h: HostAuth): CardBody {
  const stored = h.storedTokens.length > 0;
  const actions: CardAction[] = [
    stored ? { kind: 'replaceToken', label: 'Replace token' } : { kind: 'addToken', label: 'Add token' },
  ];
  if (stored) actions.push({ kind: 'removeToken', label: 'Remove token' });
  if (stored || h.tokenSource) actions.push({ kind: 'test', label: 'Test' });
  actions.push(
    { kind: 'openUrl', label: 'Open the API token page', url: BITBUCKET_TOKEN_URL },
    { kind: 'copyScopes', label: 'Copy scopes', text: BITBUCKET_SCOPES.join(' ') },
  );
  return { ...bitbucketStatus(h), accounts: [], tokens: [], actions, note: null };
}

function azureCard(h: HostAuth): CardBody {
  const tokens: TokenRow[] = storedOrgs(h).map((org) => ({
    org,
    actions: [
      { kind: 'replaceToken', label: 'Replace', org },
      { kind: 'removeToken', label: 'Remove', org },
      { kind: 'test', label: 'Test', org },
    ],
  }));
  const actions: CardAction[] = [{ kind: 'addToken', label: 'Add token' }];
  if (h.cliInstalled) actions.push({ kind: 'signIn', label: 'Sign in with Azure CLI', argv: [...AZ_LOGIN_ARGV] });
  if (tokens.length > 0 || h.tokenSource) actions.push({ kind: 'test', label: 'Test' });
  actions.push(
    { kind: 'openTokenPage', label: 'Open the token page' },
    {
      kind: 'copyScopes',
      label: 'Copy scopes',
      text: AZURE_DEVOPS_SCOPE_INFO.map((s) => s.scope).join(', '),
    },
  );
  return { ...azureStatus(h), accounts: [], tokens, actions, note: null };
}

function cardBody(h: HostAuth): CardBody {
  switch (h.provider) {
    case 'bitbucket':
      return bitbucketCard(h);
    case 'azureDevOps':
      return azureCard(h);
    case 'gitlab':
      return gitlabCard(h);
    case 'github':
      return githubCard(h);
  }
}

export function hostCard(h: HostAuth): HostCard {
  return {
    host: h.host,
    title: title(h),
    undetected: h.detected ? null : NOT_DETECTED,
    tooltip: h.detected && h.detectedBy.length > 0 ? h.detectedBy.join('\n') : null,
    ...cardBody(h),
  };
}

/** Detected hosts first, in the core's order; the rest fold under a "More hosts (N)" toggle, absent at zero. */
export function splitByDetection<T extends { detected: boolean }>(
  hosts: readonly T[],
): { detected: T[]; more: T[]; moreLabel: string | null } {
  const detected = hosts.filter((h) => h.detected);
  const more = hosts.filter((h) => !h.detected);
  return { detected, more, moreLabel: more.length > 0 ? `More hosts (${more.length})` : null };
}

/**
 * Azure DevOps organizations named by repo ids (`<host>/<path>`), lowercased and deduplicated in
 * order. The core rewrites every Azure DevOps remote form to `dev.azure.com/<org>/<project>/<repo>`,
 * but an id typed by hand may still carry the old `<org>.visualstudio.com` host.
 */
export function azureOrgsFromRepoIds(ids: readonly string[]): string[] {
  const orgs: string[] = [];
  for (const id of ids) {
    const parts = id.split('/');
    const host = (parts[0] ?? '').toLowerCase();
    let org = '';
    if (host === AZURE_DEVOPS_HOST) org = parts[1] ?? '';
    else if (host.endsWith('.visualstudio.com')) org = host.slice(0, -'.visualstudio.com'.length);
    try {
      org = decodeURIComponent(org);
    } catch {
      // A malformed escape: keep it as written.
    }
    org = normalizeOrg(org);
    if (org && !orgs.includes(org)) orgs.push(org);
  }
  return orgs;
}

/** The organizations an Azure DevOps Test checks: every stored one, then the known ones not stored. */
export function azureTestOrgs(h: HostAuth, known: readonly string[]): string[] {
  const orgs = storedOrgs(h).map(normalizeOrg);
  for (const o of [...known, ...(h.knownOrgs ?? []).map(normalizeOrg)]) if (o && !orgs.includes(o)) orgs.push(o);
  return orgs;
}

/**
 * The provider a host most likely belongs to, for a host the core has not reported yet. Only a
 * guess: a self-managed host with a neutral name reads as GitHub, which the core corrects from
 * `forge.hosts` once it answers.
 */
export function guessProvider(host: string): ProviderKind {
  const h = host.toLowerCase();
  if (h === AZURE_DEVOPS_HOST || h.endsWith('.visualstudio.com')) return 'azureDevOps';
  if (h.includes('bitbucket')) return 'bitbucket';
  if (h.includes('gitlab')) return 'gitlab';
  return 'github';
}
