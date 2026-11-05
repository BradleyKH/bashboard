import { describe, expect, it } from 'vitest';
import type { Capabilities, ForgeError, ForgeErrorKind, ForgeRepo, PullRequest, Run, RunStatus } from './forgeApi';
import { asForgeError } from './forgeApi';
import {
  BITBUCKET_SCOPES,
  cleanLog,
  duration,
  finishedSince,
  finishToast,
  groupPulls,
  isActive,
  noticeFor,
  pollSecs,
  pullLimitNote,
  pullPollSecs,
  relativeTime,
  statusInfo,
  withPullChecks,
  type NoticeAction,
} from './shipModel';

const GITHUB_CAPS: Capabilities = {
  rerun: true,
  rerunFailed: true,
  cancel: true,
  jobLogs: true,
  drafts: true,
  prNoun: 'pull request',
  runNoun: 'workflow run',
  minPollSecs: 10,
  accounts: true,
};
const BITBUCKET_CAPS: Capabilities = {
  ...GITHUB_CAPS,
  rerunFailed: false,
  runNoun: 'pipeline',
  minPollSecs: 30,
  accounts: false,
};

function run(over: Partial<Run> = {}): Run {
  return {
    id: '1',
    number: 1,
    name: 'CI',
    title: 'Fix it',
    branch: 'main',
    sha: 'abc',
    event: 'push',
    status: 'success',
    rawStatus: 'completed',
    actor: 'me',
    createdAt: '2026-11-04T10:00:00Z',
    startedAt: '2026-11-04T10:00:05Z',
    finishedAt: '2026-11-04T10:03:17Z',
    webUrl: 'https://example.com/1',
    ...over,
  };
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    id: '1',
    number: 1,
    title: 'T',
    author: 'a',
    draft: false,
    state: 'open',
    sourceBranch: 'f',
    targetBranch: 'main',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    webUrl: 'https://example.com/pull/1',
    reviewDecision: null,
    reviewers: [],
    checks: null,
    checksPending: false,
    isMine: false,
    reviewRequested: false,
    ...over,
  };
}

function repo(over: Partial<ForgeRepo> = {}): ForgeRepo {
  return {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'widgets',
    webUrl: 'https://github.com/acme/widgets',
    branch: 'main',
    capabilities: GITHUB_CAPS,
    account: 'bob',
    accountSource: 'repoConfig',
    accounts: ['bob'],
    ...over,
  };
}

function err(kind: ForgeErrorKind, over: Partial<ForgeError> = {}): ForgeError {
  return { kind, message: `msg ${kind}`, url: null, signIn: null, retryAfterSecs: null, ...over };
}

const labels = (actions: NoticeAction[]) => actions.map((a) => a.label);
const kinds = (actions: NoticeAction[]) => actions.map((a) => a.kind);

describe('statusInfo', () => {
  const table: [RunStatus, string, boolean][] = [
    ['queued', 'Queued', true],
    ['running', 'Running', true],
    ['waiting', 'Waiting for approval', false],
    ['success', 'Passed', false],
    ['failure', 'Failed', false],
    ['cancelled', 'Cancelled', false],
    ['skipped', 'Skipped', false],
    ['other', 'Unknown', false],
  ];
  it.each(table)('%s', (status, label, active) => {
    expect(statusInfo(status)).toEqual({ label, modifier: status, active });
  });
});

describe('polling', () => {
  it('isActive is true for queued or running only', () => {
    expect(isActive([])).toBe(false);
    expect(isActive([run({ status: 'waiting' }), run({ status: 'success' })])).toBe(false);
    expect(isActive([run({ status: 'success' }), run({ status: 'queued' })])).toBe(true);
  });

  it('polls runs every 15s while active and 60s idle on GitHub', () => {
    expect(pollSecs(GITHUB_CAPS, [run({ status: 'running' })])).toBe(15);
    expect(pollSecs(GITHUB_CAPS, [run()])).toBe(60);
  });

  it('never polls runs faster than the host floor', () => {
    expect(pollSecs(BITBUCKET_CAPS, [run({ status: 'running' })])).toBe(30);
    expect(pollSecs(BITBUCKET_CAPS, [run()])).toBe(60);
    expect(pollSecs({ ...GITHUB_CAPS, minPollSecs: 120 }, [run()])).toBe(120);
  });

  it('polls pulls at four times the floor, at least 60s', () => {
    expect(pullPollSecs(GITHUB_CAPS)).toBe(60);
    expect(pullPollSecs(BITBUCKET_CAPS)).toBe(120);
  });
});

describe('finishedSince', () => {
  it('announces nothing on a first load', () => {
    expect(finishedSince(undefined, [run({ status: 'failure' })])).toEqual([]);
  });

  it('returns runs that were active and are now done, matched by id', () => {
    const prev = [run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'queued' }), run({ id: 'c' })];
    const next = [
      run({ id: 'a', status: 'success' }),
      run({ id: 'b', status: 'running' }),
      run({ id: 'c', status: 'failure' }),
      run({ id: 'd', status: 'success' }),
    ];
    expect(finishedSince(prev, next).map((r) => r.id)).toEqual(['a']);
  });

  it('does not count a move to waiting, a still-active run, or a run that left the list', () => {
    const prev = [run({ id: 'a', status: 'running' }), run({ id: 'b', status: 'running' })];
    expect(finishedSince(prev, [run({ id: 'a', status: 'waiting' })])).toEqual([]);
  });
});

describe('finishToast', () => {
  it('names the run and its branch', () => {
    expect(finishToast(run(), 'workflow run')).toBe('Workflow run passed: CI on main');
    expect(finishToast(run({ status: 'failure', name: 'Build' }), 'pipeline')).toBe('Pipeline failed: Build on main');
    expect(finishToast(run({ status: 'cancelled' }), 'build')).toBe('Build was cancelled: CI on main');
  });

  it('falls back to the title and drops a missing branch', () => {
    expect(finishToast(run({ name: '', branch: null }), 'workflow run')).toBe('Workflow run passed: Fix it');
  });

  it('says finished for statuses with no verdict', () => {
    expect(finishToast(run({ status: 'other' }), 'workflow run')).toBe('Workflow run finished: CI on main');
  });
});

describe('duration', () => {
  const now = Date.parse('2026-11-04T10:10:00Z');
  it('spans start to finish', () => {
    expect(duration(run(), now)).toBe('3m 12s');
    expect(duration(run({ finishedAt: '2026-11-04T10:00:50Z' }), now)).toBe('45s');
    expect(duration(run({ finishedAt: '2026-11-04T11:05:05Z' }), now)).toBe('1h 5m');
  });

  it('counts up to now while running', () => {
    expect(duration(run({ status: 'running', finishedAt: null }), now)).toBe('9m 55s');
  });

  it('is blank for a run that has not started or has bad times', () => {
    expect(duration(run({ status: 'skipped', startedAt: null, finishedAt: null }), now)).toBe('');
    expect(duration(run({ startedAt: 'nope' }), now)).toBe('');
  });

  it('measures a queued run from its creation but ends nowhere', () => {
    expect(duration(run({ status: 'queued', startedAt: null, finishedAt: null }), now)).toBe('');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('formats each unit', () => {
    expect(relativeTime(ago(10_000), now)).toBe('just now');
    expect(relativeTime(ago(50_000), now)).toBe('1m ago');
    expect(relativeTime(ago(5 * MIN), now)).toBe('5m ago');
    expect(relativeTime(ago(3 * HOUR), now)).toBe('3h ago');
    expect(relativeTime(ago(2 * DAY), now)).toBe('2d ago');
    expect(relativeTime(ago(95 * DAY), now)).toBe('3mo ago');
    expect(relativeTime(ago(800 * DAY), now)).toBe('2y ago');
  });

  it('treats the future as just now and bad input as blank', () => {
    expect(relativeTime(new Date(now + HOUR).toISOString(), now)).toBe('just now');
    expect(relativeTime('garbage', now)).toBe('');
  });
});

describe('pullLimitNote', () => {
  it('says the list is partial only when the host counts more than were shown', () => {
    expect(pullLimitNote(50, 60, 'pull request')).toBe('Showing the latest 50 of 60 open pull requests.');
    expect(pullLimitNote(50, 61, 'merge request')).toBe('Showing the latest 50 of 61 open merge requests.');
    expect(pullLimitNote(50, 200, 'pull request', false)).toBe('Showing the latest 50 of 200 pull requests.');
    expect(pullLimitNote(50, 50, 'pull request')).toBeNull();
    expect(pullLimitNote(3, 3, 'pull request')).toBeNull();
    expect(pullLimitNote(50, null, 'pull request')).toBeNull();
  });
});

describe('groupPulls', () => {
  it('splits into Review requested, Yours, and Others, leaving empty groups out', () => {
    const groups = groupPulls([
      pr({ number: 1, isMine: true }),
      pr({ number: 2 }),
      pr({ number: 3, reviewRequested: true }),
      pr({ number: 4, isMine: true, reviewRequested: true }),
    ]);
    expect(groups.map((g) => [g.key, g.title, g.pulls.map((p) => p.number)])).toEqual([
      ['reviewRequested', 'Review requested', [4, 3]],
      ['yours', 'Yours', [1]],
      ['others', 'Others', [2]],
    ]);
    expect(groupPulls([pr({ isMine: true })]).map((g) => g.key)).toEqual(['yours']);
    expect(groupPulls([])).toEqual([]);
  });

  it('orders each group newest update first with drafts after non-drafts', () => {
    const groups = groupPulls([
      pr({ number: 1, updatedAt: '2026-11-03T00:00:00Z' }),
      pr({ number: 2, updatedAt: '2026-11-04T00:00:00Z', draft: true }),
      pr({ number: 3, updatedAt: '2026-11-02T00:00:00Z' }),
      pr({ number: 4, updatedAt: '2026-11-01T00:00:00Z', draft: true }),
    ]);
    expect(groups[0].pulls.map((p) => p.number)).toEqual([1, 3, 2, 4]);
  });

  it('puts merged and closed ones after every open one, drafts included', () => {
    const groups = groupPulls([
      pr({ number: 1, updatedAt: '2026-11-05T00:00:00Z', state: 'merged' }),
      pr({ number: 2, updatedAt: '2026-11-01T00:00:00Z', draft: true }),
      pr({ number: 3, updatedAt: '2026-11-02T00:00:00Z' }),
      pr({ number: 4, updatedAt: '2026-11-04T00:00:00Z', state: 'closed' }),
    ]);
    expect(groups[0].pulls.map((p) => p.number)).toEqual([3, 2, 1, 4]);
  });

  it('does not reorder the caller\'s array', () => {
    const input = [pr({ number: 1, updatedAt: '2026-11-01T00:00:00Z' }), pr({ number: 2, updatedAt: '2026-11-04T00:00:00Z' })];
    groupPulls(input);
    expect(input.map((p) => p.number)).toEqual([1, 2]);
  });
});

describe('withPullChecks', () => {
  it('fills pending checks by id and leaves settled rows alone', () => {
    const settled = pr({ id: 'a', checks: 'success' });
    const pending = pr({ id: 'b', checksPending: true });
    const out = withPullChecks([settled, pending], [{ id: 'b', checks: 'failure' }]);
    expect(out[0]).toBe(settled);
    expect(out[1]).toMatchObject({ checks: 'failure', checksPending: false });
  });

  it('settles a pending row the answer left out, so it stops waiting', () => {
    const out = withPullChecks([pr({ id: 'b', checksPending: true })], []);
    expect(out[0]).toMatchObject({ checks: null, checksPending: false });
  });
});

describe('cleanLog', () => {
  it('strips ANSI colors, cursor moves, and OSC sequences', () => {
    expect(cleanLog('\x1b[31;1mred\x1b[0m \x1b[2K\x1b[1Gdone')).toBe('red done');
    expect(cleanLog('\x1b]0;title\x07text \x1b]8;;http://x\x1b\\link')).toBe('text link');
  });

  it('strips GitHub timestamps at the start of each line only', () => {
    const text = '2026-11-04T10:15:30.1234567Z ##[group]Run tests\n2026-11-04T10:15:31Z ok at 2026-11-04T10:15:31Z';
    expect(cleanLog(text)).toBe('##[group]Run tests\nok at 2026-11-04T10:15:31Z');
  });

  it('strips timestamps that follow an ANSI escape, a byte order mark, and carriage returns', () => {
    expect(cleanLog('﻿2026-11-04T10:15:30Z \x1b[36mhi\x1b[0m\r\n2026-11-04T10:15:31Z bye')).toBe('hi\nbye');
  });

  it('leaves plain text alone', () => {
    expect(cleanLog('a\nb')).toBe('a\nb');
  });
});

describe('asForgeError', () => {
  it('passes a ForgeError through, filling missing optionals with null', () => {
    expect(asForgeError({ kind: 'signedOut', message: 'no' })).toEqual({
      kind: 'signedOut',
      message: 'no',
      url: null,
      signIn: null,
      retryAfterSecs: null,
    });
    const full = err('rateLimited', { url: 'https://x', signIn: ['gh'], retryAfterSecs: 5 });
    expect(asForgeError(full)).toEqual(full);
  });

  it('turns other rejections into kind other', () => {
    expect(asForgeError(new Error('boom'))).toMatchObject({ kind: 'other', message: 'boom' });
    expect(asForgeError('plain string')).toMatchObject({ kind: 'other', message: 'plain string' });
    expect(asForgeError({ kind: 'bogus', message: 'x' })).toMatchObject({ kind: 'other' });
    expect(asForgeError(undefined).kind).toBe('other');
    expect(asForgeError(null).message).not.toBe('');
  });
});

describe('BITBUCKET_SCOPES', () => {
  it('lists the five scopes', () => {
    expect(BITBUCKET_SCOPES).toEqual([
      'read:repository:bitbucket',
      'read:pullrequest:bitbucket',
      'read:pipeline:bitbucket',
      'write:pipeline:bitbucket',
      'read:user:bitbucket',
    ]);
  });
});

describe('noticeFor', () => {
  const winget = ['winget', 'install', '--id', 'GitHub.cli', '-e'];

  it('GitHub notInstalled offers install, the site, and retry, and mentions gh auth login', () => {
    const n = noticeFor(err('notInstalled', { url: 'https://cli.github.com', signIn: winget }), null);
    expect(n.title).toBe('Bashboard reads GitHub through the GitHub CLI.');
    expect(n.body.join(' ')).toContain('gh auth login');
    expect(labels(n.actions)).toEqual(['Install with winget', 'Open cli.github.com', 'Manage accounts', 'Retry']);
    expect(n.actions[2]).toEqual({ kind: 'openAccounts', label: 'Manage accounts', host: 'github.com' });
    expect(n.actions[0]).toEqual({ kind: 'runTerminal', label: 'Install with winget', argv: winget });
    expect(n.actions[1]).toMatchObject({ kind: 'openUrl', url: 'https://cli.github.com' });
  });

  it('GitHub notInstalled without a winget argv still links to the site', () => {
    const n = noticeFor(err('notInstalled'), repo());
    expect(labels(n.actions)).toEqual(['Open cli.github.com', 'Manage accounts', 'Retry']);
    expect(n.actions[0]).toMatchObject({ kind: 'openUrl', url: 'https://cli.github.com' });
  });

  it('GitHub signedOut names the host and runs the sign-in command', () => {
    const argv = ['gh', 'auth', 'login', '--hostname', 'ghe.corp.com', '--web'];
    const n = noticeFor(err('signedOut', { signIn: argv }), repo({ host: 'ghe.corp.com' }));
    expect(n.title).toBe('Sign in to ghe.corp.com with the GitHub CLI.');
    expect(n.actions[0]).toEqual({ kind: 'runTerminal', label: 'Sign in', argv });
    expect(kinds(n.actions)).toEqual(['runTerminal', 'openAccounts', 'retry']);
    expect(n.actions[1]).toEqual({ kind: 'openAccounts', label: 'Manage accounts', host: 'ghe.corp.com' });
  });

  it('GitHub signedOut builds the command itself when the error carries none', () => {
    const n = noticeFor(err('signedOut'), repo());
    expect(n.actions[0]).toMatchObject({
      kind: 'runTerminal',
      argv: ['gh', 'auth', 'login', '--hostname', 'github.com', '--web'],
    });
  });

  it('reads the provider and host from the sign-in argv when there is no repo yet', () => {
    const argv = ['gh', 'auth', 'login', '--hostname', 'ghe.corp.com', '--web'];
    expect(noticeFor(err('signedOut', { signIn: argv }), null).title).toBe('Sign in to ghe.corp.com with the GitHub CLI.');
    expect(noticeFor(err('signedOut', { signIn: ['bb', 'auth', 'bitbucket'] }), undefined).title).toBe(
      'Bitbucket needs an API token.',
    );
  });

  it('GitHub notFound with several accounts offers the account picker', () => {
    const n = noticeFor(err('notFound'), repo({ accounts: ['bob', 'alice'] }));
    expect(n.title).toBe("acme/widgets wasn't found as @bob.");
    expect(kinds(n.actions)).toEqual(['pickAccount', 'retry']);
    expect(n.actions[0].label).toBe('Use another account');
  });

  it('GitHub notFound with one account is a plain not found', () => {
    const n = noticeFor(err('notFound'), repo());
    expect(n.title).toBe('Not found');
    expect(kinds(n.actions)).toEqual(['retry']);
  });

  describe('Bitbucket', () => {
    const bb = repo({ provider: 'bitbucket', host: 'bitbucket.org', capabilities: BITBUCKET_CAPS, accounts: [] });

    it('signedOut with no token stored gives the four steps, the scopes, and the actions led by Add token', () => {
      const n = noticeFor(err('signedOut', { message: 'No Bitbucket API token is stored.' }), bb);
      expect(n.steps).toHaveLength(4);
      expect(n.steps[0]).toContain('Create API token with scopes');
      expect(n.steps[1]).toContain('"Bashboard"');
      expect(n.steps[3]).toContain('choose Add token');
      expect(n.steps[3]).toContain('bb auth bitbucket');
      expect(n.scopes.map((s) => s.scope)).toEqual([...BITBUCKET_SCOPES]);
      expect(n.scopes.find((s) => s.scope === 'write:pipeline:bitbucket')?.purpose).toContain('optional');
      expect(n.collapsedLabel).toBeNull();
      expect(n.actions).toEqual([
        { kind: 'openAccounts', label: 'Add token', host: 'bitbucket.org', openTokenForm: true },
        { kind: 'openUrl', label: 'Open the API token page', url: 'https://id.atlassian.com/manage-profile/security/api-tokens' },
        { kind: 'copyText', label: 'Copy scopes', text: BITBUCKET_SCOPES.join(' ') },
        { kind: 'retry', label: 'Retry' },
      ]);
    });

    it('signedOut with a rejected token says so and collapses the steps', () => {
      const n = noticeFor(err('signedOut', { message: 'Bitbucket rejected the stored API token.' }), bb);
      expect(n.title).toBe('Bitbucket rejected the stored API token.');
      expect(n.body.join(' ')).toContain('expired');
      expect(n.body.join(' ')).toContain('missing a scope');
      expect(n.collapsedLabel).toBe('How to make a new one');
      expect(n.steps).toHaveLength(4);
      expect(labels(n.actions)).toEqual(['Replace token', 'Open the API token page', 'Copy scopes', 'Retry']);
      expect(n.actions[0]).toMatchObject({ kind: 'openAccounts', host: 'bitbucket.org', openTokenForm: true });
    });

    it('treats the Git Credential Manager case as no token stored', () => {
      const n = noticeFor(
        err('signedOut', { message: "Git Credential Manager's Bitbucket sign-in can't read pipelines or pull requests." }),
        bb,
      );
      expect(n.title).toBe('Bitbucket needs an API token.');
      expect(n.collapsedLabel).toBeNull();
    });

    it('forbidden points at the missing scope', () => {
      const n = noticeFor(err('forbidden'), bb);
      expect(n.body.join(' ')).toContain('missing a scope');
      expect(labels(n.actions)).toContain('Copy scopes');
      expect(labels(n.actions)[0]).toBe('Replace token');
    });

    it('keeps the Bitbucket host when no repo has resolved yet', () => {
      const n = noticeFor(err('signedOut', { message: 'No Bitbucket API token is stored.', signIn: ['bb', 'auth', 'bitbucket'] }), null);
      expect(n.actions[0]).toMatchObject({ kind: 'openAccounts', host: 'bitbucket.org' });
    });
  });

  it('ssoRequired authorizes through the error url', () => {
    const n = noticeFor(err('ssoRequired', { url: 'https://github.com/orgs/acme/sso?token=1' }), repo());
    expect(n.actions).toEqual([
      { kind: 'openUrl', label: 'Authorize', url: 'https://github.com/orgs/acme/sso?token=1' },
      { kind: 'retry', label: 'Retry' },
    ]);
    expect(kinds(noticeFor(err('ssoRequired'), repo()).actions)).toEqual(['retry']);
  });

  it('rateLimited says when polling resumes', () => {
    expect(noticeFor(err('rateLimited', { retryAfterSecs: 30 }), repo()).body.join(' ')).toContain('in 30 seconds');
    expect(noticeFor(err('rateLimited', { retryAfterSecs: 300 }), repo()).body.join(' ')).toContain('in about 5 minutes');
    expect(noticeFor(err('rateLimited', { retryAfterSecs: 7200 }), repo()).body.join(' ')).toContain('in about 2 hours');
    expect(noticeFor(err('rateLimited'), repo()).body.join(' ')).toContain('shortly');
  });

  it('unsupportedHost names the host and offers the ship.hosts setting', () => {
    const n = noticeFor(err('unsupportedHost'), repo({ provider: 'gitlab', host: 'gitlab.example.com' }));
    expect(n.title).toBe("gitlab.example.com isn't supported");
    const text = n.body.join('\n');
    expect(text).toContain('"ship": { "hosts": { "gitlab.example.com": "github" } }');
    // Bitbucket hosts other than bitbucket.org are refused, so the notice never offers `bitbucket`.
    expect(text).toContain('self-hosted GitHub Enterprise Server host');
    expect(text).not.toContain('"bitbucket"');
    expect(text).not.toMatch(/github, bitbucket/);
    expect(n.actions[0]).toMatchObject({ kind: 'copyText', label: 'Copy setting' });
  });

  it('unsupportedHost without a repo still shows a usable setting', () => {
    const n = noticeFor(err('unsupportedHost'), null);
    expect(n.title).toBe("This host isn't supported");
    expect(n.body.join('\n')).toContain('"ship"');
  });

  it('unsupportedHost before the repo resolves names the host from the error URL', () => {
    const n = noticeFor(err('unsupportedHost', { url: 'https://git.corp.test' }), null);
    expect(n.title).toBe("git.corp.test isn't supported");
    expect(n.body.join('\n')).toContain('"ship": { "hosts": { "git.corp.test": "github" } }');
  });

  it('unsupportedHost for a recognized provider not served yet offers no ship.hosts setting', () => {
    const n = noticeFor(err('unsupportedHost', { message: "GitLab isn't supported yet", url: 'https://gitlab.com' }), null);
    expect(n.title).toBe("gitlab.com isn't supported");
    expect(n.body).toEqual(["GitLab isn't supported yet"]);
    expect(n.actions.map((a) => a.label)).toEqual(['Retry']);
  });

  it('covers every remaining kind with a title and the error message', () => {
    const cases: [ForgeErrorKind, string][] = [
      ['forbidden', 'Access denied'],
      ['notARepo', 'Not a git repository'],
      ['noRemote', 'No remote'],
      ['network', "Can't reach the host"],
      ['other', 'Something went wrong'],
    ];
    for (const [kind, title] of cases) {
      const n = noticeFor(err(kind), repo());
      expect(n.title).toBe(title);
      expect(n.body).toContain(`msg ${kind}`);
    }
    expect(noticeFor(err('notARepo'), null).actions).toEqual([]);
    expect(kinds(noticeFor(err('network'), null).actions)).toEqual(['retry']);
  });

  it('never uses em or en dashes', () => {
    const all: ForgeErrorKind[] = [
      'notARepo', 'noRemote', 'unsupportedHost', 'notInstalled', 'signedOut', 'ssoRequired',
      'forbidden', 'notFound', 'rateLimited', 'network', 'other',
    ];
    for (const r of [null, repo(), repo({ provider: 'bitbucket', accounts: ['a', 'b'] })]) {
      for (const k of all) {
        expect(JSON.stringify(noticeFor(err(k, { message: 'x' }), r))).not.toMatch(new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`));
      }
    }
  });
});
