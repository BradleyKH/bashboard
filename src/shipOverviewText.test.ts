import { describe, expect, it } from 'vitest';
import type { PullRequest } from './forgeApi';
import { bitbucketSlowedText, normalizeRepoInput, providerBadge, pullSummary, repoLabel, runningSummary, updatedText } from './shipOverviewText';

const pull = (over: Partial<PullRequest>): PullRequest => ({ state: 'open', reviewRequested: false, ...over }) as PullRequest;

describe('pullSummary', () => {
  it('counts open pull requests and those awaiting the viewer', () => {
    const pulls = [pull({}), pull({ reviewRequested: true }), pull({ state: 'merged', reviewRequested: true })];
    expect(pullSummary(pulls, 'pull request')).toBe('2 PRs open, 1 needs you');
  });
  it('omits the needs-you part when none', () => {
    expect(pullSummary([pull({}), pull({})], 'pull request')).toBe('2 PRs open');
  });
  it('says none are open, in the host noun', () => {
    expect(pullSummary([pull({ state: 'closed' })], 'merge request')).toBe('No open merge requests');
  });
  it('counts open drafts between the total and the needs-you part', () => {
    const pulls = [pull({ draft: true }), pull({ draft: true }), pull({ reviewRequested: true }), pull({ state: 'closed', draft: true })];
    expect(pullSummary(pulls, 'pull request')).toBe('3 PRs open, 2 drafts, 1 needs you');
    expect(pullSummary([pull({ draft: true }), pull({})], 'pull request')).toBe('2 PRs open, 1 draft');
  });
  it('abbreviates the host noun, singular for one', () => {
    expect(pullSummary([pull({})], 'pull request')).toBe('1 PR open');
    expect(pullSummary([pull({}), pull({})], 'merge request')).toBe('2 MRs open');
  });
});

describe('runningSummary', () => {
  it('counts pipelines, singular for one, and is empty for none', () => {
    expect(runningSummary(0)).toBe('');
    expect(runningSummary(1)).toBe('1 pipeline running');
    expect(runningSummary(3)).toBe('3 pipelines running');
  });
});

describe('updatedText', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  it('reads the age', () => {
    expect(updatedText(now - 125_000, now)).toBe('Updated 2m ago');
    expect(updatedText(now - 5_000, now)).toBe('Updated just now');
  });
  it('handles no poll yet', () => {
    expect(updatedText(null, now)).toBe('Not updated yet');
  });
});

describe('bitbucketSlowedText', () => {
  it('reads seconds under two minutes, else whole minutes rounded up', () => {
    expect(bitbucketSlowedText(72_000)).toBe('Bitbucket every 72 s');
    expect(bitbucketSlowedText(180_000)).toBe('Bitbucket every 3 min');
    expect(bitbucketSlowedText(190_000)).toBe('Bitbucket every 4 min');
  });
});

describe('providerBadge and repoLabel', () => {
  it('reads the host', () => {
    expect(providerBadge('github.com/a/b')?.name).toBe('GitHub');
    expect(providerBadge('bitbucket.org/a/b')?.name).toBe('Bitbucket');
    expect(providerBadge('gitlab.com/a/b')).toBeNull();
  });
  it('drops the host', () => {
    expect(repoLabel('github.com/a/b')).toBe('a/b');
  });
});

describe('normalizeRepoInput', () => {
  it('prefixes github.com to a bare owner/name', () => {
    expect(normalizeRepoInput(' acme/app ', [])).toBe('github.com/acme/app');
    expect(normalizeRepoInput('acme/app', ['github.com/x/y', 'bitbucket.org/x/z'])).toBe('github.com/acme/app');
  });
  it('prefixes bitbucket.org when every pin is on it', () => {
    expect(normalizeRepoInput('acme/app', ['bitbucket.org/x/y'])).toBe('bitbucket.org/acme/app');
  });
  it('passes hosts and URLs through', () => {
    expect(normalizeRepoInput('github.com/acme/app', [])).toBe('github.com/acme/app');
    expect(normalizeRepoInput('https://bitbucket.org/acme/app/pull-requests/3', [])).toBe(
      'https://bitbucket.org/acme/app/pull-requests/3',
    );
    expect(normalizeRepoInput('git@github.com:acme/app.git', [])).toBe('git@github.com:acme/app.git');
  });
  it('returns null for blank input', () => {
    expect(normalizeRepoInput('  ', [])).toBeNull();
  });
});
