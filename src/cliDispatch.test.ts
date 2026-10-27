import { describe, expect, it, vi } from 'vitest';
import type { CliAction, CliCommand } from './cli';
import { runCliCommand, type CliTarget } from './cliDispatch';

function fake(paneId: string | null = 'p3') {
  const calls: unknown[][] = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const target: CliTarget = {
    terminalForPty: (id) => {
      calls.push(['terminalForPty', id]);
      return paneId;
    },
    anchorOn: rec('anchorOn'),
    showFiles: rec('showFiles'),
    showGit: rec('showGit'),
    showSearch: rec('showSearch'),
    openScratch: rec('openScratch'),
    openInEditor: rec('openInEditor'),
  };
  return { target, calls };
}

const cmd = (action: CliAction, collapsed = false): CliCommand => ({ ptyId: 7, collapsed, action });

describe('runCliCommand', () => {
  it('opens a folder in Files without a selection', () => {
    const { target, calls } = fake();
    runCliCommand(cmd({ kind: 'open', path: 'C:/r/docs', isDir: true, root: 'C:/r' }), target);
    expect(calls).toEqual([
      ['terminalForPty', 7],
      ['anchorOn', 'p3'],
      ['showFiles', { root: 'C:/r', folder: 'C:/r/docs', select: undefined }, { collapsed: false }],
    ]);
  });

  it('opens a file by showing its folder and selecting it', () => {
    const { target, calls } = fake();
    runCliCommand(cmd({ kind: 'open', path: 'C:/r/docs/a.md', isDir: false, root: 'C:/r' }, true), target);
    expect(calls[calls.length - 1]).toEqual([
      'showFiles',
      { root: 'C:/r', folder: 'C:/r/docs', select: 'C:/r/docs/a.md' },
      { collapsed: true },
    ]);
  });

  it('edits with a line and without, never touching a pane', () => {
    const a = fake();
    runCliCommand(cmd({ kind: 'edit', path: 'C:/r/a.rs', line: 12 }), a.target);
    expect(a.calls).toEqual([['openInEditor', 'C:/r/a.rs', 12]]);
    const b = fake();
    runCliCommand(cmd({ kind: 'edit', path: 'C:/r/a.rs', line: null }), b.target);
    expect(b.calls).toEqual([['openInEditor', 'C:/r/a.rs', undefined]]);
  });

  it('shows git for the root', () => {
    const { target, calls } = fake();
    runCliCommand(cmd({ kind: 'git', root: 'C:/r' }, true), target);
    expect(calls).toEqual([
      ['terminalForPty', 7],
      ['anchorOn', 'p3'],
      ['showGit', 'C:/r', { collapsed: true }],
    ]);
  });

  it('searches with and without a query', () => {
    const a = fake();
    runCliCommand(cmd({ kind: 'search', root: 'C:/r', query: 'TODO' }), a.target);
    expect(a.calls[a.calls.length - 1]).toEqual(['showSearch', 'C:/r', 'TODO', { collapsed: false }]);
    const b = fake();
    runCliCommand(cmd({ kind: 'search', root: 'C:/r', query: null }), b.target);
    expect(b.calls[b.calls.length - 1]).toEqual(['showSearch', 'C:/r', '', { collapsed: false }]);
    const c = fake();
    runCliCommand(cmd({ kind: 'search', root: 'C:/r' }), c.target);
    expect(c.calls[c.calls.length - 1]).toEqual(['showSearch', 'C:/r', '', { collapsed: false }]);
  });

  it('opens a scratch pad with the text', () => {
    const { target, calls } = fake();
    runCliCommand(cmd({ kind: 'scratch', text: 'hi\nthere' }), target);
    expect(calls).toEqual([
      ['terminalForPty', 7],
      ['anchorOn', 'p3'],
      ['openScratch', 'hi\nthere', { collapsed: false }],
    ]);
  });

  it('drops pane-opening commands for an unknown pty', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const action of [
      { kind: 'open', path: 'C:/r', isDir: true, root: 'C:/r' },
      { kind: 'git', root: 'C:/r' },
      { kind: 'search', root: 'C:/r' },
      { kind: 'scratch', text: 'x' },
    ] as CliAction[]) {
      const { target, calls } = fake(null);
      runCliCommand(cmd(action), target);
      expect(calls).toEqual([['terminalForPty', 7]]);
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('still runs edit when the pty is unknown', () => {
    const { target, calls } = fake(null);
    runCliCommand(cmd({ kind: 'edit', path: 'C:/r/a.rs' }), target);
    expect(calls).toEqual([['openInEditor', 'C:/r/a.rs', undefined]]);
  });
});
