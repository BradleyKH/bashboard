import { describe, expect, it, vi } from 'vitest';
import { isEnabled, type MenuEntry, type MenuItem } from './contextMenuModel';
import type { Capabilities, ForgeRepo, PullRequest, Run, RunStatus } from './forgeApi';
import {
  ACCOUNT_NOTE,
  accountMenuItems,
  pullMenuItems,
  runActionStates,
  runMenuItems,
  signInAnotherArgv,
  type AccountMenuHandlers,
  type RunMenuHandlers,
} from './forgeMenus';

const GITHUB: Capabilities = {
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
const BITBUCKET: Capabilities = { ...GITHUB, rerun: false, rerunFailed: false, cancel: true, accounts: false };
const READ_ONLY: Capabilities = { ...GITHUB, rerun: false, rerunFailed: false, cancel: false };

function run(status: RunStatus): Run {
  return {
    id: '1',
    number: 7,
    name: 'CI',
    title: 'Fix it',
    branch: 'main',
    sha: null,
    event: null,
    status,
    rawStatus: status,
    actor: null,
    createdAt: '2026-11-04T10:00:00Z',
    startedAt: null,
    finishedAt: null,
    webUrl: 'https://example.com/run/1',
  };
}

function handlers(): RunMenuHandlers {
  return { onOpen: vi.fn(), onRerun: vi.fn(), onRerunFailed: vi.fn(), onCancel: vi.fn(), onCopyLink: vi.fn() };
}

const items = (entries: MenuEntry[]) => entries.filter((e): e is MenuItem => e.kind === 'item');
const labels = (entries: MenuEntry[]) => items(entries).map((e) => e.label);
const find = (entries: MenuEntry[], label: string) => items(entries).find((e) => e.label === label);

describe('runActionStates', () => {
  it('enables re-run for a finished run, re-run failed for a failure, and cancel for a live one', () => {
    expect(runActionStates(run('failure'), GITHUB)).toEqual({
      rerun: { offered: true, enabled: true },
      rerunFailed: { offered: true, enabled: true },
      cancel: { offered: true, enabled: false },
    });
    expect(runActionStates(run('running'), GITHUB)).toEqual({
      rerun: { offered: true, enabled: false },
      rerunFailed: { offered: true, enabled: false },
      cancel: { offered: true, enabled: true },
    });
  });

  it('marks what the host cannot do as not offered', () => {
    const states = runActionStates(run('success'), BITBUCKET);
    expect([states.rerun.offered, states.rerunFailed.offered, states.cancel.offered]).toEqual([false, false, true]);
  });
});

describe('runMenuItems', () => {
  it('offers re-run for a failed run, with Cancel left out', () => {
    const entries = runMenuItems(run('failure'), GITHUB, handlers());
    expect(labels(entries)).toEqual(['Open in browser', 'Re-run', 'Re-run failed jobs', 'Copy link']);
    expect(isEnabled(find(entries, 'Re-run')!)).toBe(true);
    expect(isEnabled(find(entries, 'Re-run failed jobs')!)).toBe(true);
  });

  it('greys Re-run failed jobs for a run that did not fail', () => {
    const entries = runMenuItems(run('success'), GITHUB, handlers());
    expect(isEnabled(find(entries, 'Re-run')!)).toBe(true);
    expect(isEnabled(find(entries, 'Re-run failed jobs')!)).toBe(false);
  });

  it.each<RunStatus>(['queued', 'running'])('offers Cancel and greys the re-runs while %s', (status) => {
    const entries = runMenuItems(run(status), GITHUB, handlers());
    expect(labels(entries)).toContain('Cancel');
    expect(isEnabled(find(entries, 'Re-run')!)).toBe(false);
    expect(isEnabled(find(entries, 'Re-run failed jobs')!)).toBe(false);
  });

  it('leaves Cancel out once a run is done or waiting', () => {
    for (const status of ['success', 'failure', 'cancelled', 'waiting'] as RunStatus[]) {
      expect(labels(runMenuItems(run(status), GITHUB, handlers()))).not.toContain('Cancel');
    }
  });

  it('leaves out what the host cannot do', () => {
    expect(labels(runMenuItems(run('failure'), BITBUCKET, handlers()))).toEqual(['Open in browser', 'Copy link']);
    expect(labels(runMenuItems(run('running'), BITBUCKET, handlers()))).toEqual([
      'Open in browser',
      'Cancel',
      'Copy link',
    ]);
    expect(labels(runMenuItems(run('running'), READ_ONLY, handlers()))).toEqual(['Open in browser', 'Copy link']);
  });

  it('runs the matching handler', () => {
    const h = handlers();
    const entries = runMenuItems(run('failure'), GITHUB, h);
    find(entries, 'Open in browser')!.run();
    find(entries, 'Re-run')!.run();
    find(entries, 'Re-run failed jobs')!.run();
    find(entries, 'Copy link')!.run();
    expect(h.onOpen).toHaveBeenCalledOnce();
    expect(h.onRerun).toHaveBeenCalledOnce();
    expect(h.onRerunFailed).toHaveBeenCalledOnce();
    expect(h.onCopyLink).toHaveBeenCalledOnce();
    expect(h.onCancel).not.toHaveBeenCalled();
  });

  it('never starts or ends with a separator, or doubles one', () => {
    for (const caps of [GITHUB, BITBUCKET, READ_ONLY]) {
      for (const status of ['queued', 'success', 'failure'] as RunStatus[]) {
        const entries = runMenuItems(run(status), caps, handlers());
        expect(entries[0].kind).toBe('item');
        expect(entries[entries.length - 1].kind).toBe('item');
        entries.forEach((e, i) => {
          if (e.kind === 'separator') expect(entries[i - 1].kind).not.toBe('separator');
        });
      }
    }
  });
});

describe('pullMenuItems', () => {
  const pull = { sourceBranch: 'feature/x', webUrl: 'https://example.com/pr/3' } as PullRequest;

  it('offers open, link, and branch copies', () => {
    const h = { onOpen: vi.fn(), onCopyLink: vi.fn(), onCopyBranch: vi.fn() };
    const entries = pullMenuItems(pull, h);
    expect(labels(entries)).toEqual(['Open in browser', 'Copy link', 'Copy branch name']);
    find(entries, 'Copy branch name')!.run();
    expect(h.onCopyBranch).toHaveBeenCalledOnce();
  });

  it('greys the branch copy when there is no source branch', () => {
    const entries = pullMenuItems({ ...pull, sourceBranch: '' }, { onOpen() {}, onCopyLink() {}, onCopyBranch() {} });
    expect(isEnabled(find(entries, 'Copy branch name')!)).toBe(false);
  });
});

describe('accountMenuItems', () => {
  function repo(accounts: string[], account: string | null): ForgeRepo {
    return {
      provider: 'github',
      host: 'github.com',
      owner: 'o',
      name: 'r',
      webUrl: 'https://github.com/o/r',
      branch: 'main',
      capabilities: GITHUB,
      account,
      accountSource: 'repoConfig',
      accounts,
    };
  }
  function acct(): AccountMenuHandlers {
    return { onPick: vi.fn(), onSignIn: vi.fn(), onManage: vi.fn() };
  }

  it('checks the current account among several and notes what picking does', () => {
    const entries = accountMenuItems(repo(['alice', 'bob'], 'bob'), acct());
    expect(labels(entries)).toEqual(['@alice', '@bob', ACCOUNT_NOTE, 'Sign in another account', 'Manage accounts']);
    expect(find(entries, '@alice')!.checked).toBe(false);
    expect(find(entries, '@bob')!.checked).toBe(true);
    expect(isEnabled(find(entries, ACCOUNT_NOTE)!)).toBe(false);
  });

  it('lists a single account, checked', () => {
    const entries = accountMenuItems(repo(['alice'], 'alice'), acct());
    expect(labels(entries)).toEqual(['@alice', ACCOUNT_NOTE, 'Sign in another account', 'Manage accounts']);
    expect(find(entries, '@alice')!.checked).toBe(true);
  });

  it('checks nothing when the repo has no account of its own', () => {
    const entries = accountMenuItems(repo(['alice', 'bob'], null), acct());
    expect(items(entries).filter((e) => e.checked === true)).toHaveLength(0);
  });

  it('offers only sign-in for zero accounts, with no note', () => {
    const entries = accountMenuItems(repo([], null), acct());
    expect(labels(entries)).toEqual(['No accounts signed in to github.com', 'Sign in another account', 'Manage accounts']);
    expect(isEnabled(entries[0])).toBe(false);
  });

  it('picks an account and signs in with the host-scoped command', () => {
    const h = acct();
    const entries = accountMenuItems(repo(['alice', 'bob'], 'bob'), h);
    find(entries, '@alice')!.run();
    expect(h.onPick).toHaveBeenCalledWith('alice');
    find(entries, 'Sign in another account')!.run();
    expect(h.onSignIn).toHaveBeenCalledWith(['gh', 'auth', 'login', '--hostname', 'github.com', '--web']);
    find(entries, 'Manage accounts')!.run();
    expect(h.onManage).toHaveBeenCalledTimes(1);
    expect(signInAnotherArgv('ghe.example.com')).toContain('ghe.example.com');
  });
});
