import { describe, expect, it } from 'vitest';
import type { PullRequest } from './forgeApi';
import { bitbucketSlowedText, normalizeRepoInput, providerBadge, pullSummary, repoLabel, updatedText } from './forgeOverviewText';

const pull = (over: Partial<PullRequest>): PullRequest => ({ state: 'open', reviewRequested: false, ...over }) as PullRequest;

describe('pullSummary', () => {
  it('counts open pull requests and those awaiting the viewer', () => {
    const pulls = [pull({}), pull({ reviewRequested: true }), pull({ state: 'merged', reviewRequested: true })];
    expect(pullSummary(pulls, 'pull request')).toBe('2 open, 1 needs you');
  });
  it('omits the needs-you part when none', () => {
    expect(pullSummary([pull({}), pull({})], 'pull request')).toBe('2 open');
  });
  it('says none are open, in the host noun', () => {
    expect(pullSummary([pull({ state: 'closed' })], 'merge request')).toBe('No open merge requests');
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
