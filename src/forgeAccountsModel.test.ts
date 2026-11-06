import { describe, expect, it } from 'vitest';
import type { HostAuth } from './forgeApi';
import {
  AZ_LOGIN_ARGV,
  azureOrgsFromRepoIds,
  azureTestOrgs,
  azureTokenPageUrl,
  guessProvider,
  hostCard,
  INSTALL_GH_ARGV,
  INSTALL_GLAB_ARGV,
  NOT_DETECTED,
  normalizeOrg,
  splitByDetection,
} from './forgeAccountsModel';
import { AZURE_DEVOPS_SCOPE_INFO, BITBUCKET_SCOPES, BITBUCKET_TOKEN_URL } from './shipModel';

function gh(over: Partial<HostAuth> = {}): HostAuth {
  return {
    provider: 'github',
    host: 'github.com',
    cliInstalled: true,
    accounts: [],
    activeAccount: null,
    tokenSource: null,
    storedTokens: [],
    ghEnvToken: null,
    detected: true,
    detectedBy: [],
    knownOrgs: [],
    ...over,
  };
}

function bb(over: Partial<HostAuth> = {}): HostAuth {
  return gh({ provider: 'bitbucket', host: 'bitbucket.org', cliInstalled: false, ...over });
}

function gl(over: Partial<HostAuth> = {}): HostAuth {
  return gh({ provider: 'gitlab', host: 'gitlab.com', ...over });
}

function az(over: Partial<HostAuth> = {}): HostAuth {
  return gh({ provider: 'azureDevOps', host: 'dev.azure.com', ...over });
}

const kinds = (c: { actions: { kind: string }[] }) => c.actions.map((a) => a.kind);

describe('hostCard, GitHub', () => {
  it('offers an install, not a sign-in, when gh is missing', () => {
    const c = hostCard(gh({ cliInstalled: false }));
    expect(c.severity).toBe('missing');
    expect(c.status).toContain('not installed');
    expect(c.actions).toEqual([{ kind: 'installCli', label: 'Install GitHub CLI', argv: [...INSTALL_GH_ARGV] }]);
    expect(INSTALL_GH_ARGV).toEqual(['winget', 'install', '--id', 'GitHub.cli', '-e']);
  });

  it('with gh and zero accounts offers Sign in with the host in the argv', () => {
    const c = hostCard(gh({ host: 'ghe.example.com' }));
    expect(c.title).toBe('GitHub (ghe.example.com)');
    expect(c.severity).toBe('missing');
    expect(c.accounts).toEqual([]);
    expect(c.actions).toEqual([
      { kind: 'signIn', label: 'Sign in', argv: ['gh', 'auth', 'login', '--hostname', 'ghe.example.com', '--web'] },
    ]);
  });

  it('with one active account reads signed in and offers Sign out and Test but not Make active', () => {
    const c = hostCard(gh({ accounts: ['alice'], activeAccount: 'alice', tokenSource: 'ghCli' }));
    expect(c.title).toBe('GitHub');
    expect(c.status).toBe('Signed in as @alice through GitHub CLI');
    expect(c.severity).toBe('ok');
    expect(c.accounts).toEqual([
      {
        user: 'alice',
        active: true,
        actions: [
          { kind: 'signOut', label: 'Sign out', user: 'alice' },
          { kind: 'test', label: 'Test', user: 'alice' },
        ],
      },
    ]);
    expect(kinds(c)).toEqual(['signIn']);
    expect(c.actions[0]).toMatchObject({ label: 'Sign in another account' });
  });

  it('with several accounts offers Make active on the inactive ones only', () => {
    const c = hostCard(gh({ accounts: ['alice', 'bob'], activeAccount: 'bob', tokenSource: 'ghCli' }));
    expect(c.status).toBe('Signed in as @bob through GitHub CLI');
    expect(c.accounts.map((a) => [a.user, a.active])).toEqual([
      ['alice', false],
      ['bob', true],
    ]);
    expect(c.accounts[0]!.actions.map((a) => a.kind)).toEqual(['makeActive', 'signOut', 'test']);
    expect(c.accounts[1]!.actions.map((a) => a.kind)).toEqual(['signOut', 'test']);
  });

  it('warns when accounts exist but none is active', () => {
    const c = hostCard(gh({ accounts: ['alice', 'bob'], tokenSource: 'ghCli' }));
    expect(c.severity).toBe('warn');
    expect(c.status).toBe('2 accounts in GitHub CLI, none active');
    expect(c.accounts.every((a) => a.actions[0]!.kind === 'makeActive')).toBe(true);
  });

  it('treats Git Credential Manager as signed in and offers a card-level Test', () => {
    const c = hostCard(gh({ tokenSource: 'gitCredentialManager' }));
    expect(c.severity).toBe('ok');
    expect(c.status).toBe("Using Git Credential Manager's sign-in");
    expect(kinds(c)).toEqual(['signIn', 'test']);
  });

  it('still offers an install when only Git Credential Manager is present and gh is missing', () => {
    const c = hostCard(gh({ cliInstalled: false, tokenSource: 'gitCredentialManager' }));
    expect(c.severity).toBe('ok');
    expect(kinds(c)).toEqual(['installCli', 'test']);
  });

  it('adds a note, and keeps every action, when an environment token is set', () => {
    const base = gh({ accounts: ['alice', 'bob'], activeAccount: 'bob', tokenSource: 'ghCli' });
    const c = hostCard({ ...base, ghEnvToken: 'GH_TOKEN' });
    const plain = hostCard(base);
    expect(c.note).toBe(
      'GH_TOKEN is set, so gh in a terminal uses that token; Bashboard uses the saved account shown here.',
    );
    expect(c.status).toBe(plain.status);
    expect(c.severity).toBe(plain.severity);
    expect(c.accounts).toEqual(plain.accounts);
    expect(c.actions).toEqual(plain.actions);
    expect(plain.note).toBeNull();
  });

  it('names whichever variable is set and never adds a note to Bitbucket', () => {
    expect(hostCard(gh({ host: 'ghe.example.com', ghEnvToken: 'GH_ENTERPRISE_TOKEN' })).note).toContain(
      'GH_ENTERPRISE_TOKEN is set',
    );
    expect(hostCard(bb()).note).toBeNull();
  });

  it('names the Bashboard credential source if one is reported', () => {
    expect(hostCard(gh({ tokenSource: 'bashboardCredential' })).status).toBe('Using the Bashboard credential');
  });
});

describe('hostCard, Bitbucket', () => {
  it('with nothing stored reads missing and offers Add token, no Test, no Remove', () => {
    const c = hostCard(bb());
    expect(c.title).toBe('Bitbucket');
    expect(c.status).toBe('No API token stored');
    expect(c.severity).toBe('missing');
    expect(kinds(c)).toEqual(['addToken', 'openUrl', 'copyScopes']);
  });

  it('with a stored token is ok and offers Replace, Remove, and Test', () => {
    const c = hostCard(bb({ storedTokens: [{ org: null }], tokenSource: 'bashboardCredential' }));
    expect(c.severity).toBe('ok');
    expect(c.status).toBe('API token stored');
    expect(kinds(c)).toEqual(['replaceToken', 'removeToken', 'test', 'openUrl', 'copyScopes']);
  });

  it('warns when only Git Credential Manager supplies a token, and still offers Add and Test', () => {
    const c = hostCard(bb({ tokenSource: 'gitCredentialManager' }));
    expect(c.severity).toBe('warn');
    expect(c.status).toBe("Using Git Credential Manager's sign-in, which can't read pipelines or pull requests");
    expect(kinds(c)).toEqual(['addToken', 'test', 'openUrl', 'copyScopes']);
  });

  it('prefers a stored token over Git Credential Manager', () => {
    const c = hostCard(bb({ storedTokens: [{ org: null }], tokenSource: 'gitCredentialManager' }));
    expect(c.severity).toBe('ok');
  });

  it('carries the token page URL and the scope list', () => {
    const c = hostCard(bb());
    expect(c.actions).toContainEqual({ kind: 'openUrl', label: 'Open the API token page', url: BITBUCKET_TOKEN_URL });
    expect(c.actions).toContainEqual({ kind: 'copyScopes', label: 'Copy scopes', text: BITBUCKET_SCOPES.join(' ') });
  });
});

describe('hostCard, GitLab', () => {
  it('offers an install when glab is missing, and no account rows', () => {
    const c = hostCard(gl({ cliInstalled: false }));
    expect(c.title).toBe('GitLab');
    expect(c.status).toBe('Not signed in, and GitLab CLI is not installed');
    expect(c.severity).toBe('missing');
    expect(c.accounts).toEqual([]);
    expect(c.actions).toEqual([{ kind: 'installCli', label: 'Install GitLab CLI', argv: [...INSTALL_GLAB_ARGV] }]);
    expect(INSTALL_GLAB_ARGV).toEqual(['winget', 'install', '--id', 'GLab.GLab', '-e']);
  });

  it('with glab and no sign-in offers Sign in with the host in the argv, and no Test', () => {
    const c = hostCard(gl({ host: 'git.example.com' }));
    expect(c.title).toBe('GitLab (git.example.com)');
    expect(c.status).toBe('Not signed in');
    expect(c.actions).toEqual([
      { kind: 'signIn', label: 'Sign in', argv: ['glab', 'auth', 'login', '--hostname', 'git.example.com'] },
    ]);
  });

  it('signed in through glab offers Sign out for that user and Test', () => {
    const c = hostCard(gl({ accounts: ['alice'], activeAccount: 'alice', tokenSource: 'glabCli' }));
    expect(c.status).toBe('Signed in as @alice through GitLab CLI');
    expect(c.severity).toBe('ok');
    expect(c.accounts).toEqual([]);
    expect(c.actions).toEqual([
      { kind: 'signOut', label: 'Sign out', user: 'alice' },
      { kind: 'test', label: 'Test' },
    ]);
  });

  it('uses Git Credential Manager when glab has no sign-in', () => {
    const c = hostCard(gl({ tokenSource: 'gitCredentialManager' }));
    expect(c.status).toBe("Using Git Credential Manager's sign-in");
    expect(kinds(c)).toEqual(['signIn', 'test']);
  });
});

describe('hostCard, Azure DevOps', () => {
  it('with nothing reads missing and offers Add token, with no Test or Azure CLI sign-in when az is missing', () => {
    const c = hostCard(az({ cliInstalled: false }));
    expect(c.title).toBe('Azure DevOps');
    expect(c.status).toBe('No personal access token stored, and Azure CLI is not installed');
    expect(c.severity).toBe('missing');
    expect(c.tokens).toEqual([]);
    expect(kinds(c)).toEqual(['addToken', 'openTokenPage', 'copyScopes']);
  });

  it('offers Sign in with Azure CLI when az is installed', () => {
    const c = hostCard(az());
    expect(c.status).toBe('No personal access token stored');
    expect(c.actions).toContainEqual({ kind: 'signIn', label: 'Sign in with Azure CLI', argv: [...AZ_LOGIN_ARGV] });
    expect(AZ_LOGIN_ARGV).toEqual(['az', 'login']);
  });

  it('lists the organizations with a stored PAT, each with Replace, Remove, and Test', () => {
    const c = hostCard(
      az({ storedTokens: [{ org: 'contoso' }, { org: 'fabrikam' }], tokenSource: 'bashboardCredential' }),
    );
    expect(c.status).toBe('Personal access token stored for contoso, fabrikam');
    expect(c.severity).toBe('ok');
    expect(c.tokens.map((t) => t.org)).toEqual(['contoso', 'fabrikam']);
    expect(c.tokens[0]!.actions).toEqual([
      { kind: 'replaceToken', label: 'Replace', org: 'contoso' },
      { kind: 'removeToken', label: 'Remove', org: 'contoso' },
      { kind: 'test', label: 'Test', org: 'contoso' },
    ]);
    expect(kinds(c)).toEqual(['addToken', 'signIn', 'test', 'openTokenPage', 'copyScopes']);
  });

  it('names the environment variable when it supplies the token', () => {
    const c = hostCard(az({ tokenSource: 'environment' }));
    expect(c.status).toBe('Using the AZURE_DEVOPS_EXT_PAT environment variable');
    expect(c.severity).toBe('ok');
    expect(kinds(c)).toContain('test');
  });

  it('names the Azure CLI user when az supplies the token', () => {
    expect(hostCard(az({ tokenSource: 'azCli', activeAccount: 'ann@contoso.com' })).status).toBe(
      'Signed in to Azure CLI as ann@contoso.com',
    );
    expect(hostCard(az({ tokenSource: 'azCli' })).status).toBe('Signed in to Azure CLI');
  });

  it('copies the scope names from the scope list', () => {
    expect(hostCard(az()).actions).toContainEqual({
      kind: 'copyScopes',
      label: 'Copy scopes',
      text: AZURE_DEVOPS_SCOPE_INFO.map((s) => s.scope).join(', '),
    });
  });

  it('builds the token page URL for an organization', () => {
    expect(azureTokenPageUrl('contoso')).toBe('https://dev.azure.com/contoso/_usersSettings/tokens');
  });
});

describe('detection', () => {
  it('marks undetected cards and puts the reasons on detected ones', () => {
    const shown = hostCard(gh({ detectedBy: ['gh is signed in', 'a pinned repo'] }));
    expect(shown.undetected).toBeNull();
    expect(shown.tooltip).toBe('gh is signed in\na pinned repo');
    const folded = hostCard(az({ detected: false }));
    expect(folded.undetected).toBe(NOT_DETECTED);
    expect(folded.tooltip).toBeNull();
    expect(NOT_DETECTED).toBe('Not detected on this machine');
  });

  it('with every host detected has no More toggle', () => {
    const s = splitByDetection([gh(), bb()]);
    expect(s.detected.map((h) => h.host)).toEqual(['github.com', 'bitbucket.org']);
    expect(s.more).toEqual([]);
    expect(s.moreLabel).toBeNull();
  });

  it('with none detected folds them all, counted', () => {
    const s = splitByDetection([gh({ detected: false }), gl({ detected: false }), az({ detected: false })]);
    expect(s.detected).toEqual([]);
    expect(s.more.map((h) => h.provider)).toEqual(['github', 'gitlab', 'azureDevOps']);
    expect(s.moreLabel).toBe('More hosts (3)');
  });

  it('mixed keeps the core order within each group', () => {
    const s = splitByDetection([gh({ detected: false }), gl({ host: 'a.example.com' }), bb({ detected: false }), az()]);
    expect(s.detected.map((h) => h.host)).toEqual(['a.example.com', 'dev.azure.com']);
    expect(s.more.map((h) => h.host)).toEqual(['github.com', 'bitbucket.org']);
    expect(s.moreLabel).toBe('More hosts (2)');
  });
});

describe('Azure DevOps organizations', () => {
  it('parses organizations from repo ids, lowercased and deduplicated', () => {
    expect(
      azureOrgsFromRepoIds([
        'dev.azure.com/Contoso/Proj/repo',
        'github.com/a/b',
        'dev.azure.com/contoso/Other/repo',
        'fabrikam.visualstudio.com/Proj/repo',
        'dev.azure.com/my%20org/p/r',
      ]),
    ).toEqual(['contoso', 'fabrikam', 'my org']);
  });

  it('tests stored organizations first, then known ones not stored', () => {
    expect(azureTestOrgs(az({ storedTokens: [{ org: 'fabrikam' }] }), ['contoso', 'fabrikam'])).toEqual([
      'fabrikam',
      'contoso',
    ]);
    expect(azureTestOrgs(az(), [])).toEqual([]);
  });

  it('also tests organizations only the core knows of, such as a terminal folder repo', () => {
    expect(azureTestOrgs(az({ knownOrgs: ['Northwind', 'contoso'] }), ['contoso'])).toEqual(['contoso', 'northwind']);
  });

  it('normalizes a typed organization', () => {
    expect(normalizeOrg('  Contoso ')).toBe('contoso');
  });

  it('guesses a provider from a host', () => {
    expect(guessProvider('dev.azure.com')).toBe('azureDevOps');
    expect(guessProvider('contoso.visualstudio.com')).toBe('azureDevOps');
    expect(guessProvider('bitbucket.org')).toBe('bitbucket');
    expect(guessProvider('gitlab.example.com')).toBe('gitlab');
    expect(guessProvider('ghe.example.com')).toBe('github');
  });
});
