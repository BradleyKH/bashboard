import { describe, expect, it } from 'vitest';
import type { HostAuth } from './forgeApi';
import { hostCard, INSTALL_GH_ARGV } from './forgeAccountsModel';
import { BITBUCKET_SCOPES, BITBUCKET_TOKEN_URL } from './forgeModel';

function gh(over: Partial<HostAuth> = {}): HostAuth {
  return {
    provider: 'github',
    host: 'github.com',
    ghInstalled: true,
    accounts: [],
    activeAccount: null,
    tokenSource: null,
    bitbucketTokenStored: false,
    ghEnvToken: null,
    ...over,
  };
}

function bb(over: Partial<HostAuth> = {}): HostAuth {
  return gh({ provider: 'bitbucket', host: 'bitbucket.org', ghInstalled: false, ...over });
}

const kinds = (c: { actions: { kind: string }[] }) => c.actions.map((a) => a.kind);

describe('hostCard, GitHub', () => {
  it('offers an install, not a sign-in, when gh is missing', () => {
    const c = hostCard(gh({ ghInstalled: false }));
    expect(c.severity).toBe('missing');
    expect(c.status).toContain('not installed');
    expect(c.actions).toEqual([{ kind: 'installGh', label: 'Install GitHub CLI', argv: [...INSTALL_GH_ARGV] }]);
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
    const c = hostCard(gh({ ghInstalled: false, tokenSource: 'gitCredentialManager' }));
    expect(c.severity).toBe('ok');
    expect(kinds(c)).toEqual(['installGh', 'test']);
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
    const c = hostCard(bb({ bitbucketTokenStored: true, tokenSource: 'bashboardCredential' }));
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
    const c = hostCard(bb({ bitbucketTokenStored: true, tokenSource: 'gitCredentialManager' }));
    expect(c.severity).toBe('ok');
  });

  it('carries the token page URL and the scope list', () => {
    const c = hostCard(bb());
    expect(c.actions).toContainEqual({ kind: 'openUrl', label: 'Open the API token page', url: BITBUCKET_TOKEN_URL });
    expect(c.actions).toContainEqual({ kind: 'copyScopes', label: 'Copy scopes', text: BITBUCKET_SCOPES.join(' ') });
  });
});
