// Wording and input rules for the Ship Overview rows and Add repo box (docs/design.md section 4.20).
// Pure, no DOM.
import type { PullRequest } from './forgeApi';
import { relativeTime } from './shipModel';

/** "PR" for "pull request", "MR" for "merge request": the host's noun as initials. */
function pullAbbrev(noun: string): string {
  return noun
    .split(/\s+/)
    .filter((w) => w !== '')
    .map((w) => w[0].toUpperCase())
    .join('');
}

/**
 * "3 PRs open, 1 draft, 1 needs you", leaving out a part whose count is zero; "No open pull requests"
 * when none. Drafts count among the open ones. `noun` is the host's own word for them.
 */
export function pullSummary(pulls: readonly PullRequest[], noun: string): string {
  const open = pulls.filter((p) => p.state === 'open');
  if (open.length === 0) return `No open ${noun}s`;
  const abbrev = pullAbbrev(noun);
  const parts = [`${open.length} ${abbrev}${open.length === 1 ? '' : 's'} open`];
  const drafts = open.filter((p) => p.draft).length;
  if (drafts > 0) parts.push(`${drafts} draft${drafts === 1 ? '' : 's'}`);
  const awaiting = open.filter((p) => p.reviewRequested).length;
  if (awaiting > 0) parts.push(`${awaiting} needs you`);
  return parts.join(', ');
}

/** "2 pipelines running"; empty when none, so the row shows nothing. Queued runs count as running. */
export function runningSummary(count: number): string {
  if (count <= 0) return '';
  return `${count} pipeline${count === 1 ? '' : 's'} running`;
}

/** The Overview's "Updated 2m ago" line; `updatedAt` and `now` are epoch milliseconds. */
export function updatedText(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return 'Not updated yet';
  const age = relativeTime(new Date(updatedAt).toISOString(), now);
  return age === 'just now' ? 'Updated just now' : `Updated ${age}`;
}

/** The Overview bar's note while Bitbucket's request budget holds its pins to `gapMs` apart. */
export function bitbucketSlowedText(gapMs: number): string {
  const secs = Math.ceil(gapMs / 1000);
  const gap = secs < 120 ? `${secs} s` : `${Math.ceil(secs / 60)} min`;
  return `Bitbucket every ${gap}`;
}

export type ProviderBadge = { letters: string; name: string };

/** The provider a pin id (`host/owner/name`) belongs to, read from its host; null for anything else. */
export function providerBadge(repoId: string): ProviderBadge | null {
  const host = repoId.split('/')[0].toLowerCase();
  if (host.includes('github')) return { letters: 'GH', name: 'GitHub' };
  if (host.includes('bitbucket')) return { letters: 'BB', name: 'Bitbucket' };
  return null;
}

/** `owner/name` of a pin id, without its host. */
export function repoLabel(repoId: string): string {
  const at = repoId.indexOf('/');
  return at < 0 ? repoId : repoId.slice(at + 1);
}

/**
 * What the Add repo box resolves: a bare `owner/name` gets a host in front (GitHub, or Bitbucket when
 * every pinned repo is on Bitbucket, since that is the likelier intent); anything else, such as a
 * remote URL or `host/owner/name`, goes through as typed. Returns null for blank input.
 */
export function normalizeRepoInput(input: string, pinnedIds: readonly string[]): string | null {
  const text = input.trim();
  if (text === '') return null;
  const bare = /^[\w.-]+\/[\w.-]+$/.test(text) && !text.split('/')[0].includes('.');
  if (!bare) return text;
  const bitbucketOnly = pinnedIds.length > 0 && pinnedIds.every((id) => providerBadge(id)?.name === 'Bitbucket');
  return `${bitbucketOnly ? 'bitbucket.org' : 'github.com'}/${text}`;
}
