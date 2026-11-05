import { describe, expect, it } from 'vitest';
import type { PullRequest, Run } from './forgeApi';
import type { DashboardItem } from './forgeOverviewModel';
import type { OverviewEntry } from './forgeOverviewStore';
import { isAllClear, itemStatus, itemText, repoLabel } from './forgeSectionModel';

const pull = (over: Partial<PullRequest> = {}): PullRequest =>
  ({ number: 7, title: 'Fix it', reviewDecision: null, checks: null, ...over }) as PullRequest;
const run = { title: 'Merge branch', status: 'failure' } as Run;
const base = { target: 'remote:x', repo: 'bitbucket.org/keysys/kweb' };

const branch: DashboardItem = { ...base, kind: 'branch', tab: 'pipelines', branch: 'uat', run };
const review = (p = pull()): DashboardItem => ({ ...base, kind: 'review', tab: 'pulls', pull: p });
const mine = (p: PullRequest): DashboardItem => ({ ...base, kind: 'mine', tab: 'pulls', pull: p });

const entry = (loaded: boolean): OverviewEntry => ({
  pin: { repo: 'github.com/a/b' },
  row: loaded ? ({} as OverviewEntry['row']) : null,
  error: null,
  loading: !loaded,
  updatedAt: null,
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
  });
});

describe('isAllClear', () => {
  it('needs a loaded pin and no items', () => {
    expect(isAllClear([entry(true)], [])).toBe(true);
    expect(isAllClear([entry(true), entry(false)], [])).toBe(true);
  });

  it('is not clear while every pin is loading or errored', () => {
    expect(isAllClear([entry(false)], [])).toBe(false);
    expect(isAllClear([], [])).toBe(false);
  });

  it('is not clear with items', () => {
    expect(isAllClear([entry(true)], [branch])).toBe(false);
  });
});
