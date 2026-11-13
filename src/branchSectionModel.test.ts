import { describe, expect, it } from 'vitest';
import type { BranchSize } from './branchSizeApi';
import { branchSectionView, folderName, pickPull, sameView, type BranchSectionState } from './branchSectionModel';
import type { PullRequest } from './forgeApi';
import type { WorktreeDetail } from './worktreeApi';

const detail = (over: Partial<WorktreeDetail> = {}): WorktreeDetail =>
  ({
    path: 'C:/src/app',
    branch: 'feat',
    head: null,
    comparison: 'origin/main',
    ahead: 3,
    behind: 1,
    merged: 'notMerged',
    upstream: 'origin/feat',
    upstreamGone: false,
    upstreamAhead: 0,
    upstreamBehind: 0,
    staged: 0,
    changed: 0,
    untracked: 0,
    ...over,
  }) as WorktreeDetail;

const size = (over: Partial<BranchSize> = {}): BranchSize => ({
  worktree: 'C:/src/app',
  branch: 'feat',
  comparison: 'origin/main',
  lines: 120,
  added: 100,
  removed: 20,
  files: 4,
  excludedLines: 0,
  excludedFiles: 0,
  ...over,
});

const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  id: '1',
  number: 95,
  title: 'Fix the parser',
  author: 'me',
  draft: false,
  state: 'open',
  sourceBranch: 'feat',
  targetBranch: 'main',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  webUrl: 'https://x/pull/95',
  reviewDecision: null,
  reviewers: [],
  checks: null,
  checksPending: false,
  isMine: true,
  reviewRequested: false,
  ...over,
});

const repo = (over: Partial<Extract<BranchSectionState, { kind: 'repo' }>> = {}): BranchSectionState => ({
  kind: 'repo',
  worktree: 'C:\\src\\app',
  branch: 'feat',
  detail: detail(),
  size: size(),
  threshold: 400,
  ci: null,
  pull: null,
  ...over,
});

const view = (s: BranchSectionState) => {
  const v = branchSectionView(s);
  if (v === null) throw new Error('expected a view');
  return v;
};

describe('branchSectionView', () => {
  it('hides for a non-repo', () => {
    expect(branchSectionView({ kind: 'none' })).toBeNull();
  });

  it('builds a header and the meter and ahead/behind rows', () => {
    const v = view(repo());
    expect(v.name).toBe('feat');
    expect(v.folder).toBe('app');
    expect(v.title).toBe('C:\\src\\app');
    expect(v.rows).toEqual([
      {
        kind: 'meter',
        text: '120 lines changed (+100 -20) in 4 files against origin/main',
        title: '+100 -20 in 4 files against origin/main',
        fraction: 0.3,
        over: false,
      },
      { kind: 'text', id: 'ahead', text: 'ahead 3, behind 1 against origin/main', tone: 'normal' },
      { kind: 'text', id: 'upstream', text: 'origin/feat: up to date', tone: 'muted' },
    ]);
  });

  it('marks the meter over the threshold and clamps the fill', () => {
    const v = view(repo({ size: size({ lines: 900 }) }));
    expect(v.rows[0]).toMatchObject({ kind: 'meter', fraction: 1, over: true });
  });

  it('shows the number without a bar or color when the threshold is 0', () => {
    const v = view(repo({ threshold: 0, size: size({ lines: 5000 }) }));
    expect(v.rows[0]).toMatchObject({ kind: 'meter', fraction: null, over: false });
    expect((v.rows[0] as { text: string }).text).toContain('5000 lines');
  });

  it('omits the tree row for a clean tree and shows it otherwise', () => {
    expect(view(repo()).rows.some((r) => r.kind === 'text' && r.id === 'tree')).toBe(false);
    const dirty = view(repo({ detail: detail({ staged: 2, changed: 1, untracked: 7 }) }));
    expect(dirty.rows).toContainEqual({ kind: 'text', id: 'tree', text: '2 staged, 1 changed, 7 untracked', tone: 'normal' });
  });

  it('names a detached HEAD', () => {
    const v = view(repo({ branch: null }));
    expect(v.name).toBe('detached HEAD');
  });

  it('collapses to one muted line with no comparison ref, keeping the tree row', () => {
    const v = view(
      repo({
        detail: detail({ comparison: null, staged: 1 }),
        size: size({ comparison: null, lines: 0 }),
      }),
    );
    expect(v.rows).toEqual([
      { kind: 'text', id: 'no-comparison', text: 'no comparison ref', tone: 'muted' },
      { kind: 'text', id: 'upstream', text: 'origin/feat: up to date', tone: 'muted' },
      { kind: 'text', id: 'tree', text: '1 staged, 0 changed, 0 untracked', tone: 'normal' },
    ]);
  });

  it('takes the comparison label from detail, not a hardcoded ref', () => {
    const v = view(repo({ detail: detail({ comparison: 'origin/develop' }) }));
    expect(v.rows[1]).toMatchObject({ text: 'ahead 3, behind 1 against origin/develop' });
  });

  it('adds a CI row only when there is CI', () => {
    expect(view(repo()).rows.some((r) => r.kind === 'ci')).toBe(false);
    const v = view(repo({ ci: { label: 'Build #42 passed', status: 'success', url: 'https://x/42' } }));
    expect(v.rows[v.rows.length - 1]).toEqual({
      kind: 'ci',
      label: 'Build #42 passed',
      status: 'success',
      title: 'https://x/42\nOpen the Ship tab',
    });
    const noUrl = view(repo({ ci: { label: 'Build', status: 'running', url: null } }));
    expect(noUrl.rows[noUrl.rows.length - 1]).toMatchObject({ title: 'Open the Ship tab' });
  });

  it('uses singular forms for a single line and file', () => {
    const v = view(repo({ size: size({ lines: 1, added: 1, removed: 0, files: 1 }) }));
    expect((v.rows[0] as { text: string }).text).toBe('1 line changed (+1 -0) in 1 file against origin/main');
  });

  it('shows only the header while detail and size are still loading', () => {
    expect(view(repo({ detail: null, size: null })).rows).toEqual([]);
  });

  it('falls back to the size comparison while detail loads', () => {
    const v = view(repo({ detail: null }));
    expect(v.rows.map((r) => r.kind)).toEqual(['meter']);
  });
});

describe('upstream row', () => {
  const upstreamRow = (d: Partial<WorktreeDetail>) =>
    view(repo({ detail: detail(d) })).rows.find((r) => r.kind === 'text' && r.id === 'upstream');

  it('counts commits to push and to pull, leaving out a zero', () => {
    expect(upstreamRow({ upstreamAhead: 2, upstreamBehind: 1 })).toMatchObject({
      text: 'origin/feat: 2 to push, 1 to pull',
      tone: 'normal',
    });
    expect(upstreamRow({ upstreamAhead: 2 })).toMatchObject({ text: 'origin/feat: 2 to push' });
    expect(upstreamRow({ upstreamBehind: 4 })).toMatchObject({ text: 'origin/feat: 4 to pull' });
  });

  it('flags a branch never pushed and an upstream deleted on the remote', () => {
    expect(upstreamRow({ upstream: null })).toMatchObject({ text: 'no upstream: not pushed', tone: 'muted' });
    expect(upstreamRow({ upstreamGone: true, upstreamAhead: 3 })).toMatchObject({
      text: 'origin/feat: deleted on the remote',
      tone: 'warn',
    });
  });

  it('is left out on a detached HEAD and when the upstream is the comparison ref', () => {
    expect(upstreamRow({ branch: null })).toBeUndefined();
    expect(upstreamRow({ upstream: 'origin/main', upstreamAhead: 1 })).toBeUndefined();
  });

  it('sits after the ahead row and before the tree row', () => {
    const v = view(repo({ detail: detail({ staged: 1 }) }));
    expect(v.rows.map((r) => (r.kind === 'text' ? r.id : r.kind))).toEqual(['meter', 'ahead', 'upstream', 'tree']);
  });
});

describe('pull request row', () => {
  const pullRow = (p: PullRequest) => {
    const rows = view(repo({ pull: p })).rows;
    return rows[rows.length - 1];
  };

  it('is left out when the branch has none', () => {
    expect(view(repo()).rows.some((r) => r.kind === 'pull')).toBe(false);
  });

  it('comes last, after CI', () => {
    const v = view(repo({ pull: pr(), ci: { label: 'Build', status: 'success', url: null } }));
    expect(v.rows.slice(-2).map((r) => r.kind)).toEqual(['ci', 'pull']);
  });

  it('labels by number and title with the URL in the tooltip', () => {
    expect(pullRow(pr())).toEqual({
      kind: 'pull',
      label: '#95 Fix the parser',
      badge: null,
      tone: null,
      done: false,
      title: 'Fix the parser\nfeat → main\nhttps://x/pull/95\nOpen the Ship tab',
    });
  });

  it('badges merged and closed over draft and review', () => {
    expect(pullRow(pr({ state: 'merged', draft: true, reviewDecision: 'approved' }))).toMatchObject({
      badge: 'merged',
      tone: 'merged',
      done: true,
    });
    expect(pullRow(pr({ state: 'closed' }))).toMatchObject({ badge: 'closed', done: true });
  });

  it('badges a draft over its review', () => {
    expect(pullRow(pr({ draft: true, reviewDecision: 'approved' }))).toMatchObject({ badge: 'draft', tone: 'draft' });
  });

  it('shows the review decision and names approvers', () => {
    const row = pullRow(
      pr({ reviewDecision: 'approved', reviewers: [{ login: 'ana', state: 'approved' }] }),
    );
    expect(row).toMatchObject({ badge: 'approved', tone: 'approved' });
    expect((row as { title: string }).title).toContain('approved by ana');
    expect(pullRow(pr({ reviewDecision: 'changesRequested' }))).toMatchObject({ badge: 'changes requested' });
  });
});

describe('pickPull', () => {
  it('keeps only the branch, preferring open, then the newest', () => {
    const oldOpen = pr({ id: 'a', updatedAt: '2026-01-01' });
    const newMerged = pr({ id: 'b', state: 'merged', updatedAt: '2026-06-01' });
    const newOpen = pr({ id: 'c', updatedAt: '2026-03-01' });
    const other = pr({ id: 'd', sourceBranch: 'other', updatedAt: '2026-12-01' });
    expect(pickPull([oldOpen, newMerged, newOpen, other], 'feat')?.id).toBe('c');
    expect(pickPull([newMerged, pr({ id: 'e', state: 'closed', updatedAt: '2026-02-01' })], 'feat')?.id).toBe('b');
    expect(pickPull([other], 'feat')).toBeNull();
  });
});

describe('folderName', () => {
  it('takes the last segment for either separator', () => {
    expect(folderName('C:\\src\\app')).toBe('app');
    expect(folderName('/home/me/app/')).toBe('app');
    expect(folderName('C:\\')).toBe('C:');
    expect(folderName('/')).toBe('/');
  });
});

describe('sameView', () => {
  it('compares by content', () => {
    expect(sameView(branchSectionView(repo()), branchSectionView(repo()))).toBe(true);
    expect(sameView(branchSectionView(repo()), branchSectionView(repo({ branch: 'x' })))).toBe(false);
    expect(sameView(null, null)).toBe(true);
  });
});
