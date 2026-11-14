import { describe, expect, it } from 'vitest';
import type { OverviewRepo, PullRequest, Run } from './forgeApi';
import type { DashboardItem, OverviewRow } from './shipOverviewModel';
import type { ForgeError } from './forgeApi';
import type { OverviewEntry } from './shipOverviewStore';
import { itemStatus, itemText, pullsLine, repoLabel, runningLine, signInLine } from './shipSectionModel';

const pull = (over: Partial<PullRequest> = {}): PullRequest =>
  ({ number: 7, title: 'Fix it', reviewDecision: null, checks: null, ...over }) as PullRequest;
const run = { title: 'Merge branch', status: 'failure' } as Run;
const base = { target: 'remote:x', repo: 'bitbucket.org/keysys/kweb', since: 0 };

const branch: DashboardItem = { ...base, kind: 'branch', tab: 'pipelines', branch: 'uat', run };
const review = (p = pull()): DashboardItem => ({ ...base, kind: 'review', tab: 'pulls', pull: p });
const mine = (p: PullRequest): DashboardItem => ({ ...base, kind: 'mine', tab: 'pulls', pull: p });
const approved = (...names: string[]): DashboardItem => ({
  ...base,
  kind: 'approved',
  tab: 'pulls',
  pull: pull({ reviewDecision: 'approved', reviewers: [{ login: 'Pending Pat', state: 'pending' }, ...names.map((login) => ({ login, state: 'approved' as const }))] }),
});

const NOW = Date.parse('2026-11-05T12:00:00Z');
const active = (over: Partial<Run> = {}): Run =>
  ({ name: 'Build', title: 'Ship it', branch: 'main', status: 'running', startedAt: '2026-11-05T11:57:00Z', createdAt: '2026-11-05T11:56:00Z', ...over }) as Run;
const open = (over: Partial<PullRequest> = {}): PullRequest =>
  ({ state: 'open', draft: false, reviewRequested: false, ...over }) as PullRequest;
const row = (repo: string, runs: Run[] = [], pulls: PullRequest[] = []): OverviewRow => ({
  pin: { repo },
  overview: { runs, pulls: { items: pulls, total: null } } as unknown as OverviewRepo,
  health: [],
});

describe('repoLabel', () => {
  it('drops the host', () => {
    expect(repoLabel('bitbucket.org/keysys/kweb')).toBe('keysys/kweb');
    expect(repoLabel('kweb')).toBe('kweb');
  });
});

describe('itemText', () => {
  it('names each kind of item', () => {
    expect(itemText(branch)).toBe('uat failed');
    expect(itemText(review())).toBe('#7 needs your review');
    expect(itemText(mine(pull({ reviewDecision: 'changesRequested' })))).toBe('#7 changes requested');
    expect(itemText(mine(pull({ checks: 'failure' })))).toBe('#7 checks failing');
    expect(itemText(approved('Andrew Cartwright'))).toBe('#7 approved by Andrew Cartwright');
    expect(itemText(approved('Ann', 'Bo'))).toBe('#7 approved by Ann and Bo');
    expect(itemText(approved('Ann', 'Bo', 'Cy'))).toBe('#7 approved by Ann and 2 others');
    expect(itemText(approved())).toBe('#7 approved');
  });

  it('prefers changes requested when both apply', () => {
    expect(itemText(mine(pull({ reviewDecision: 'changesRequested', checks: 'failure' })))).toBe('#7 changes requested');
  });
});

describe('itemStatus', () => {
  it('marks failures and leaves a review request neutral', () => {
    expect(itemStatus(branch)).toBe('failure');
    expect(itemStatus(mine(pull({ checks: 'failure' })))).toBe('failure');
    expect(itemStatus(review())).toBe('other');
    expect(itemStatus(approved('Ann'))).toBe('success');
  });
});

describe('runningLine', () => {
  it('says 0 pipelines running and opens the Overview', () => {
    const line = runningLine([row('github.com/a/b', [{ ...active(), status: 'success' }])], NOW);
    expect(line).toMatchObject({ text: '0 pipelines running', repo: null, target: null, status: 'other' });
  });

  it('details a single run and opens its Pipelines', () => {
    const line = runningLine([row('github.com/a/b', [active()])], NOW);
    expect(line).toMatchObject({ repo: 'a/b', text: 'main · Build · 3m ago', title: 'Ship it', target: 'remote:github.com/a/b', tab: 'pipelines' });
  });

  it('counts several runs in one repo against that repo', () => {
    const line = runningLine([row('github.com/a/b', [active(), active({ status: 'queued' })])], NOW);
    expect(line).toMatchObject({ repo: 'a/b', text: '2 pipelines running', target: 'remote:github.com/a/b', status: 'running' });
  });

  it('counts runs across repos and opens the Overview', () => {
    const line = runningLine([row('github.com/a/b', [active()]), row('github.com/c/d', [active(), active()])], NOW);
    expect(line).toMatchObject({ repo: null, text: '3 pipelines running in 2 repos', target: null });
  });
});

describe('pullsLine', () => {
  it('is absent until some pinned repo has loaded', () => {
    expect(pullsLine([])).toBeNull();
  });

  it('counts none as 0 open PRs and opens the Overview', () => {
    expect(pullsLine([row('github.com/a/b')])).toMatchObject({ text: '0 open PRs', repo: null, target: null, status: 'other' });
  });

  it('counts open pull requests across repos, leaving drafts and closed ones out', () => {
    const rows = [
      row('github.com/a/b', [], [open(), open({ draft: true }), open({ state: 'merged' })]),
      row('github.com/c/d', [], [open({ reviewRequested: true })]),
    ];
    expect(pullsLine(rows)?.text).toBe('2 open PRs');
    expect(pullsLine([row('github.com/a/b', [], [open()])])?.text).toBe('1 open PR');
  });

  it('counts every kind of open pull request, tagged or not', () => {
    const tagged = [open({ reviewRequested: true }), open({ isMine: true, reviewDecision: 'approved', checks: 'success' })];
    expect(pullsLine([row('github.com/a/b', [], tagged)])?.text).toBe('2 open PRs');
  });
});

describe('signInLine', () => {
  const failed = (repo: string, kind: ForgeError['kind'] | null): OverviewEntry => ({
    pin: { repo },
    row: null,
    error: kind ? { kind, message: '', url: null, signIn: null, retryAfterSecs: null } : null,
    loading: false,
    updatedAt: null,
  });

  it('is null when no pin lacks an account', () => {
    expect(signInLine([failed('github.com/a/b', null), failed('github.com/a/c', 'network')])).toBeNull();
  });

  it('names the one repo and opens Bitbucket on its token form', () => {
    expect(signInLine([failed('bitbucket.org/keysys/kweb', 'signedOut')])).toEqual({
      text: 'Sign in to bitbucket.org for keysys/kweb',
      title: 'Open the Accounts tab',
      host: 'bitbucket.org',
      openTokenForm: true,
    });
  });

  it('opens Azure DevOps on its token form with the shared organization', () => {
    expect(signInLine([failed('dev.azure.com/acme/proj/web', 'signedOut')])).toEqual({
      text: 'Sign in to dev.azure.com for acme/proj/web',
      title: 'Open the Accounts tab',
      host: 'dev.azure.com',
      openTokenForm: true,
      org: 'acme',
    });
    const two = signInLine([failed('dev.azure.com/acme/p/a', 'signedOut'), failed('dev.azure.com/acme/q/b', 'signedOut')]);
    expect(two).toMatchObject({ host: 'dev.azure.com', openTokenForm: true, org: 'acme' });
  });

  it('leaves the organization out when the Azure DevOps pins span several', () => {
    const line = signInLine([failed('dev.azure.com/one/p/a', 'signedOut'), failed('dev.azure.com/two/p/b', 'signedOut')]);
    expect(line).toMatchObject({ host: 'dev.azure.com', openTokenForm: true });
    expect(line).not.toHaveProperty('org');
  });

  it('reads the organization from a legacy visualstudio.com pin', () => {
    expect(signInLine([failed('acme.visualstudio.com/proj/web', 'signedOut')])).toMatchObject({
      host: 'dev.azure.com',
      openTokenForm: true,
      org: 'acme',
    });
  });

  it('does not open the token form for GitLab pins', () => {
    expect(signInLine([failed('gitlab.com/g/p', 'signedOut')])).toMatchObject({ host: 'gitlab.com', openTokenForm: false });
  });

  it('counts the repos on one GitHub host, without the token form', () => {
    const line = signInLine([failed('github.com/a/b', 'signedOut'), failed('github.com/a/c', 'notInstalled')]);
    expect(line).toMatchObject({ text: 'Sign in to github.com for 2 pinned repos', host: 'github.com', openTokenForm: false });
  });

  it('leaves the host to the Accounts tab when the repos span hosts', () => {
    const line = signInLine([failed('github.com/a/b', 'signedOut'), failed('bitbucket.org/k/w', 'signedOut')]);
    expect(line).toMatchObject({ text: 'Sign in for 2 pinned repos', host: null, openTokenForm: false });
  });
});
