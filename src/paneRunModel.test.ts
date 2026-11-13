import { describe, expect, it } from 'vitest';
import type { Run, RunStatus } from './forgeApi';
import { isRunActive, newRuns, paneRunOf, runChip, runFinish } from './paneRunModel';

function run(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    number: 42,
    name: 'build',
    title: 'Fix the thing',
    branch: 'main',
    sha: null,
    event: null,
    status: 'running',
    rawStatus: 'in_progress',
    actor: null,
    createdAt: '2026-11-13T12:00:00Z',
    startedAt: null,
    finishedAt: null,
    webUrl: 'https://example.com/runs/42',
    ...over,
  };
}

const T = Date.parse('2026-11-13T12:00:00Z');

describe('newRuns', () => {
  it('on a first read keeps only runs created at or after the trigger minus two minutes', () => {
    const fresh = run('fresh', { createdAt: '2026-11-13T12:00:30Z' });
    const slack = run('slack', { createdAt: '2026-11-13T11:58:00Z' });
    const old = run('old', { createdAt: '2026-11-13T11:57:59Z' });
    expect(newRuns(null, [fresh, slack, old], T).map((r) => r.id)).toEqual(['fresh', 'slack']);
  });

  it('treats an unparseable createdAt as not new on a first read', () => {
    expect(newRuns(null, [run('a', { createdAt: 'garbage' }), run('b', { createdAt: '' })], T)).toEqual([]);
  });

  it('returns nothing on a first read of an empty list', () => {
    expect(newRuns(null, [], T)).toEqual([]);
  });

  it('on later reads returns runs whose id was not in the previous list, whatever their age', () => {
    const a = run('a', { createdAt: '2020-01-01T00:00:00Z' });
    const b = run('b');
    expect(newRuns([a], [b, a], T).map((r) => r.id)).toEqual(['b']);
  });

  it('on later reads ignores createdAt entirely, even unparseable', () => {
    expect(newRuns([], [run('a', { createdAt: 'garbage' })], T).map((r) => r.id)).toEqual(['a']);
  });

  it('returns nothing when the list is unchanged, or when a run only fell off it', () => {
    const a = run('a');
    const b = run('b');
    expect(newRuns([a, b], [a, b], T)).toEqual([]);
    expect(newRuns([a, b], [a], T)).toEqual([]);
  });
});

describe('isRunActive', () => {
  it.each<[RunStatus, boolean]>([
    ['queued', true],
    ['running', true],
    ['waiting', true],
    ['success', false],
    ['failure', false],
    ['cancelled', false],
    ['skipped', false],
    ['other', false],
  ])('%s is %s', (status, expected) => {
    expect(isRunActive(run('a', { status }))).toBe(expected);
  });
});

describe('runFinish', () => {
  const active: RunStatus[] = ['queued', 'running', 'waiting'];

  it.each(active)('%s to success is done', (from) => {
    expect(runFinish(run('a', { status: from }), run('a', { status: 'success' }))).toBe('done');
  });

  it.each(active)('%s to failure is failed', (from) => {
    expect(runFinish(run('a', { status: from }), run('a', { status: 'failure' }))).toBe('failed');
  });

  it.each<RunStatus>(['cancelled', 'skipped', 'other'])('active to %s gives nothing', (to) => {
    expect(runFinish(run('a', { status: 'running' }), run('a', { status: to }))).toBeNull();
  });

  it('gives nothing while still active, including moving between active states', () => {
    expect(runFinish(run('a', { status: 'queued' }), run('a', { status: 'running' }))).toBeNull();
    expect(runFinish(run('a', { status: 'running' }), run('a', { status: 'waiting' }))).toBeNull();
    expect(runFinish(run('a', { status: 'running' }), run('a', { status: 'running' }))).toBeNull();
  });

  it('gives nothing when the previous status was already final', () => {
    expect(runFinish(run('a', { status: 'success' }), run('a', { status: 'success' }))).toBeNull();
    expect(runFinish(run('a', { status: 'failure' }), run('a', { status: 'success' }))).toBeNull();
  });
});

describe('paneRunOf', () => {
  it('copies the fields the card needs', () => {
    expect(paneRunOf(run('a'))).toEqual({
      name: 'build',
      number: 42,
      status: 'running',
      url: 'https://example.com/runs/42',
    });
  });

  it('falls back from name to title to CI', () => {
    expect(paneRunOf(run('a', { name: '' })).name).toBe('Fix the thing');
    expect(paneRunOf(run('a', { name: '', title: '' })).name).toBe('CI');
  });

  it('keeps a null number', () => {
    expect(paneRunOf(run('a', { number: null })).number).toBeNull();
  });
});

describe('runChip', () => {
  const pr = (over: Partial<ReturnType<typeof paneRunOf>> = {}) => ({ ...paneRunOf(run('a')), ...over });

  it.each<[RunStatus, string]>([
    ['queued', 'build #42 queued'],
    ['running', 'build #42 running'],
    ['success', 'build #42 passed'],
    ['failure', 'build #42 failed'],
    ['cancelled', 'build #42 cancelled'],
  ])('%s reads %s', (status, text) => {
    const chip = runChip(pr({ status }));
    expect(chip.text).toBe(text);
    expect(chip.modifier).toBe(status);
  });

  it('drops the number when there is none', () => {
    expect(runChip(pr({ number: null, status: 'success' })).text).toBe('build passed');
  });

  it('puts the full name and URL in the title', () => {
    expect(runChip(pr()).title).toBe('build\nhttps://example.com/runs/42');
  });

  it('omits the URL line when there is no URL', () => {
    expect(runChip(pr({ url: '' })).title).toBe('build');
  });
});
