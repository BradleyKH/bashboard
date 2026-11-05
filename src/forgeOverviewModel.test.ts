import { describe, expect, it } from 'vitest';
import type { ForgeRepo, OverviewRepo, PinnedRepo, PullRequest, Run, RunStatus } from './forgeApi';
import {
  attentionRank,
  bitbucketFloorMs,
  buildRow,
  dashboardItems,
  healthBranches,
  isBitbucketPin,
  nextPollMs,
  orderRows,
  repoId,
  targetKey,
} from './forgeOverviewModel';

let seq = 0;

function run(branch: string | null, status: RunStatus = 'success', createdAt = '2026-11-01T00:00:00Z'): Run {
  seq += 1;
  return {
    id: String(seq),
    number: seq,
    name: 'CI',
    title: 't',
    branch,
    sha: null,
    event: null,
    status,
    rawStatus: status,
    actor: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
    webUrl: '',
  };
}

function pull(over: Partial<PullRequest> = {}): PullRequest {
  seq += 1;
  return {
    id: String(seq),
    number: seq,
    title: 'p',
    author: 'a',
    draft: false,
    state: 'open',
    sourceBranch: 'feat',
    targetBranch: 'main',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    webUrl: '',
    reviewDecision: null,
    reviewers: [],
    checks: 'success',
    checksPending: false,
    isMine: false,
    reviewRequested: false,
    ...over,
  };
}

const REPO = { host: 'GitHub.com', owner: 'acme', name: 'api' } as ForgeRepo;

function overview(over: { runs?: Run[]; pulls?: PullRequest[]; defaultBranch?: string | null } = {}): OverviewRepo {
  return {
    repo: REPO,
    defaultBranch: over.defaultBranch === undefined ? 'main' : over.defaultBranch,
    runs: over.runs ?? [],
    pulls: { items: over.pulls ?? [], total: null },
  };
}

const pin = (repo: string, extra: Partial<PinnedRepo> = {}): PinnedRepo => ({ repo, ...extra });

describe('targetKey and repoId', () => {
  it('prefers the clone, else the remote identity', () => {
    expect(targetKey(pin('github.com/acme/api', { root: 'C:/src/api' }))).toBe('C:/src/api');
    expect(targetKey(pin('github.com/acme/api'))).toBe('remote:github.com/acme/api');
  });

  it('lowercases the host and keeps owner and name as is', () => {
    expect(repoId(REPO)).toBe('github.com/acme/api');
    expect(repoId({ ...REPO, host: 'git.example.com:8443', owner: 'Group/Sub', name: 'Proj' })).toBe(
      'git.example.com:8443/Group/Sub/Proj',
    );
  });
});

describe('healthBranches', () => {
  it('puts the default first, then PR targets, then pinned branches, deduplicated', () => {
    const o = overview({
      runs: [run('uat'), run('main'), run('release')],
      pulls: [
        pull({ targetBranch: 'uat' }),
        pull({ targetBranch: 'main' }),
        pull({ targetBranch: 'dev' }),
        pull({ targetBranch: 'uat' }),
      ],
    });
    const h = healthBranches(o, pin('r', { branches: ['release', 'dev', 'main'] }));
    expect(h.map((x) => x.branch)).toEqual(['main', 'uat', 'dev', 'release']);
    expect(h[0].run?.branch).toBe('main');
    expect(h[1].run?.branch).toBe('uat');
    expect(h[2].run).toBeNull();
    expect(h[3].run?.branch).toBe('release');
  });

  it('takes the newest run per branch and ignores closed pull requests', () => {
    const newest = run('main', 'failure');
    const o = overview({
      runs: [newest, run('main', 'success')],
      pulls: [pull({ state: 'merged', targetBranch: 'old' })],
    });
    expect(healthBranches(o, pin('r'))).toEqual([{ branch: 'main', run: newest }]);
  });

  it('skips a missing default branch', () => {
    const o = overview({ defaultBranch: null, pulls: [pull({ targetBranch: 'dev' })] });
    expect(healthBranches(o, pin('r')).map((x) => x.branch)).toEqual(['dev']);
  });
});

describe('attentionRank', () => {
  const rank = (o: OverviewRepo) => attentionRank(o, healthBranches(o, pin('r')));

  it('ranks a failed health branch first, even over a review request', () => {
    expect(rank(overview({ runs: [run('main', 'failure')], pulls: [pull({ reviewRequested: true })] }))).toBe(1);
  });

  it('counts a failed deploy branch picked up from a PR target', () => {
    expect(rank(overview({ runs: [run('uat', 'failure')], pulls: [pull({ targetBranch: 'uat' })] }))).toBe(1);
  });

  it('does not count a failed run on a non-health branch or a cancelled health run', () => {
    expect(rank(overview({ runs: [run('feat', 'failure')] }))).toBe(5);
    expect(rank(overview({ runs: [run('main', 'cancelled')] }))).toBe(5);
  });

  it('ranks a review request second', () => {
    expect(rank(overview({ pulls: [pull({ reviewRequested: true })] }))).toBe(2);
  });

  it("ranks the viewer's own PR with changes requested or failing checks third", () => {
    expect(rank(overview({ pulls: [pull({ isMine: true, reviewDecision: 'changesRequested' })] }))).toBe(3);
    expect(rank(overview({ pulls: [pull({ isMine: true, checks: 'failure' })] }))).toBe(3);
    expect(rank(overview({ pulls: [pull({ isMine: false, checks: 'failure' })] }))).toBe(5);
    expect(rank(overview({ pulls: [pull({ isMine: true, checks: null, checksPending: true })] }))).toBe(5);
  });

  it('ranks a running health branch fourth', () => {
    expect(rank(overview({ runs: [run('main', 'running')] }))).toBe(4);
    expect(rank(overview({ runs: [run('main', 'queued')] }))).toBe(4);
  });

  it('ranks the rest fifth, including a repo with no recent run', () => {
    expect(rank(overview())).toBe(5);
  });
});

describe('orderRows', () => {
  const row = (name: string, o: OverviewRepo) => buildRow(pin(name), o);
  const names = (rows: ReturnType<typeof orderRows>) => rows.map((r) => r.pin.repo);

  it('orders by tier', () => {
    const rows = [
      row('quiet', overview()),
      row('running', overview({ runs: [run('main', 'running')] })),
      row('mine', overview({ pulls: [pull({ isMine: true, checks: 'failure' })] })),
      row('review', overview({ pulls: [pull({ reviewRequested: true })] })),
      row('red', overview({ runs: [run('main', 'failure')] })),
    ];
    expect(names(orderRows(rows))).toEqual(['red', 'review', 'mine', 'running', 'quiet']);
  });

  it('keeps pin order on ties within a needs-attention tier', () => {
    const rows = [
      row('b', overview({ runs: [run('main', 'failure', '2026-11-01T00:00:00Z')] })),
      row('a', overview({ runs: [run('main', 'failure', '2026-11-04T00:00:00Z')] })),
      row('c', overview({ runs: [run('main', 'failure', '2026-11-02T00:00:00Z')] })),
    ];
    expect(names(orderRows(rows))).toEqual(['b', 'a', 'c']);
  });

  it('orders the quiet tier by most recent activity, then pin order', () => {
    const rows = [
      row('old', overview({ runs: [run('main', 'success', '2026-10-01T00:00:00Z')] })),
      row('pr', overview({ pulls: [pull({ updatedAt: '2026-11-03T00:00:00Z' })] })),
      row('new', overview({ runs: [run('main', 'success', '2026-11-02T00:00:00Z')] })),
      row('none1', overview()),
      row('none2', overview()),
    ];
    expect(names(orderRows(rows))).toEqual(['pr', 'new', 'old', 'none1', 'none2']);
  });

  it('does not mutate its input', () => {
    const rows = [row('quiet', overview()), row('red', overview({ runs: [run('main', 'failure')] }))];
    orderRows(rows);
    expect(names(rows)).toEqual(['quiet', 'red']);
  });
});

describe('dashboardItems', () => {
  it('lists red branches, review requests, and own PRs needing work, with target and tab', () => {
    const redRun = run('uat', 'failure');
    const review = pull({ reviewRequested: true, isMine: true, targetBranch: 'uat' });
    const mine = pull({ isMine: true, reviewDecision: 'changesRequested' });
    const fine = pull({ isMine: true });
    const others = pull({ checks: 'failure' });
    const merged = pull({ state: 'merged', isMine: true, checks: 'failure' });
    const rows = [
      buildRow(
        pin('github.com/acme/api', { root: 'C:/src/api' }),
        overview({ runs: [redRun, run('main', 'success')], pulls: [review, mine, fine, others, merged] }),
      ),
      buildRow(pin('bitbucket.org/ws/app'), overview()),
    ];
    const base = { target: 'C:/src/api', repo: 'github.com/acme/api' };
    expect(dashboardItems(rows)).toEqual([
      { kind: 'branch', ...base, tab: 'pipelines', branch: 'uat', run: redRun },
      { kind: 'review', ...base, tab: 'pulls', pull: review },
      { kind: 'mine', ...base, tab: 'pulls', pull: mine },
    ]);
  });

  it('uses the remote key for a pin without a clone and omits healthy or merely running repos', () => {
    const rows = [buildRow(pin('github.com/acme/api'), overview({ pulls: [pull({ reviewRequested: true })] }))];
    expect(dashboardItems(rows)[0].target).toBe('remote:github.com/acme/api');
    expect(dashboardItems([buildRow(pin('x'), overview({ runs: [run('main', 'running')] }))])).toEqual([]);
  });
});

describe('nextPollMs', () => {
  const health = (status: RunStatus | null) => [{ branch: 'main', run: status ? run('main', status) : null }];

  it('polls every 60s while a health-branch run is queued or running, whatever the heartbeat', () => {
    expect(nextPollMs(health('running'), 10)).toBe(60_000);
    expect(nextPollMs(health('queued'), 0)).toBe(60_000);
  });

  it('uses the heartbeat otherwise', () => {
    expect(nextPollMs(health('success'), 5)).toBe(300_000);
    expect(nextPollMs(health(null), 1)).toBe(60_000);
  });

  it('is null when the heartbeat is off and nothing is running', () => {
    expect(nextPollMs(health('failure'), 0)).toBeNull();
    expect(nextPollMs([], 0)).toBeNull();
  });

  it('stretches either interval to the floor, but never turns a heartbeat of 0 on', () => {
    expect(nextPollMs(health('running'), 5, 180_000)).toBe(180_000);
    expect(nextPollMs(health('success'), 5, 540_000)).toBe(540_000);
    expect(nextPollMs(health('success'), 5, 72_000)).toBe(300_000);
    expect(nextPollMs(health('success'), 0, 540_000)).toBeNull();
  });
});

describe('Bitbucket budget', () => {
  it('spaces each pin so all of them stay inside 600 requests an hour at 3 a poll', () => {
    expect(bitbucketFloorMs(0)).toBe(0);
    expect(bitbucketFloorMs(3)).toBe(54_000);
    expect(bitbucketFloorMs(10)).toBe(180_000);
  });

  it('reads the provider from the pin id host', () => {
    expect(isBitbucketPin('bitbucket.org/keysys/api')).toBe(true);
    expect(isBitbucketPin('github.com/bitbucket/api')).toBe(false);
  });
});
