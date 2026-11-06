import { describe, expect, it } from 'vitest';
import type { OtherCard, TerminalCard } from './dashboardModel';
import { cleanupGoneConfirm, closePadConfirm, closeTabConfirm, deleteUnmergedConfirm, replaceConfirm, undoCommitConfirm } from './paneConfirm';

const terminal: TerminalCard = {
  kind: 'terminal',
  paneId: 'p1',
  tabId: 't1',
  title: 'repo',
  path: 'C:\\src\\repo',
  profile: 'gitBash',
  status: 'working',
  statusChangedAt: 0,
  reason: null,
  focused: false,
  sessionId: null,
  busy: true,
  collapsed: false,
  attention: false,
  containerName: null,
};

const pad: OtherCard = {
  kind: 'scratch',
  paneId: 'v1',
  tabId: 't1',
  title: 'draft prompt',
  path: '',
  focused: true,
  collapsed: false,
  busy: true,
  attention: false,
};

describe('closeTabConfirm', () => {
  it('lists terminals with their folder and pads by title', () => {
    const opts = closeTabConfirm('Work', [terminal, pad]);
    expect(opts.body).toEqual(['Closing Work closes 2 panes still in use:', 'repo (C:\\src\\repo)', 'draft prompt']);
  });

  it('says pane for one', () => {
    expect(closeTabConfirm('Work', [pad]).body[0]).toBe('Closing Work closes 1 pane still in use:');
  });
});

describe('closePadConfirm', () => {
  it('names the pad', () => {
    expect(closePadConfirm(pad).body).toEqual(['Closing draft prompt deletes its text.']);
  });
});

describe('replaceConfirm', () => {
  it('says what replacing loses for each kind', () => {
    expect(replaceConfirm(terminal, 'scratch').body[0]).toBe(
      'Replacing repo (C:\\src\\repo) with a scratch pane ends what is running in it.',
    );
    expect(replaceConfirm(pad, 'terminal').body[0]).toBe('Replacing draft prompt with a terminal pane deletes its text.');
    const files = { ...pad, kind: 'files' as const, title: 'repo', path: 'C:\\src\\repo' };
    expect(replaceConfirm(files, 'scratch').body[0]).toBe('Replacing repo (C:\\src\\repo) with a scratch pane closes it.');
    expect(replaceConfirm(pad, 'files').body[0]).toBe('Replacing draft prompt with a files pane deletes its text.');
  });

  it('says a Git pane is closed by replacing it', () => {
    const git = { ...pad, kind: 'git' as const, title: 'repo', path: 'C:\\src\\repo' };
    expect(replaceConfirm(git, 'scratch').body[0]).toBe('Replacing repo (C:\\src\\repo) with a scratch pane closes it.');
  });

  it('says a Search pane is closed by replacing it', () => {
    const search = { ...pad, kind: 'search' as const, title: 'repo', path: 'C:\\src\\repo' };
    expect(replaceConfirm(search, 'scratch').body[0]).toBe('Replacing repo (C:\\src\\repo) with a scratch pane closes it.');
  });

  it('says a Containers pane is closed by replacing it', () => {
    const containers = { ...pad, kind: 'containers' as const, title: 'Containers' };
    expect(replaceConfirm(containers, 'scratch').body[0]).toBe('Replacing Containers with a scratch pane closes it.');
  });

  it('names the commit and its subject in the undo dialog', () => {
    const o = undoCommitConfirm('1a2b3c4', 'Fix the parser', false);
    expect(o.title).toBe('Undo last commit');
    expect(o.confirmLabel).toBe('Undo');
    expect(o.body.join(' ')).toContain('1a2b3c4 (Fix the parser)');
    expect(o.body.join(' ')).not.toContain('force push');
  });

  it('warns about a force push when the commit is pushed', () => {
    expect(undoCommitConfirm('1a2b3c4', 'Fix the parser', true).body.join(' ')).toContain('force push');
  });
});

describe('deleteUnmergedConfirm', () => {
  it('counts the commits only this branch holds', () => {
    expect(deleteUnmergedConfirm('topic', 1).body[0]).toBe('topic is not merged, and 1 commit on it is on no other branch.');
    expect(deleteUnmergedConfirm('topic', 3).body[0]).toContain('3 commits on it are');
    expect(deleteUnmergedConfirm('topic', 3).confirmLabel).toBe('Delete anyway');
  });

  it('explains a refusal when every commit is on another branch', () => {
    expect(deleteUnmergedConfirm('topic', 0).body[0]).toContain('its commits are on other branches');
  });
});

describe('cleanupGoneConfirm', () => {
  it('lists each branch after the explanation', () => {
    const opts = cleanupGoneConfirm(['a', 'b']);
    expect(opts.body[0]).toMatch(/^Delete 2 branches/);
    expect(opts.body.slice(1)).toEqual(['a', 'b']);
  });
});
