import { describe, expect, it, vi } from 'vitest';
import { restoredSpec, specForKind } from './paneSpecModel';

function loaders() {
  return {
    scratch: vi.fn((id: string) => Promise.resolve(`pad ${id}`)),
    scrollback: vi.fn((id: string) => Promise.resolve(`log ${id}`)),
  };
}

describe('restoredSpec', () => {
  it('turns an empty terminal cwd into undefined so the core uses startingDirectory', () => {
    const load = loaders();
    const spec = restoredSpec(
      { key: 'p1', collapsed: false, kind: 'terminal', cwd: '', sessionId: null, scrollbackId: 's1' },
      { loadScratch: false, loadScrollback: false },
      load,
    );
    expect(spec).toEqual({ kind: 'terminal', cwd: undefined, profile: undefined, scrollbackId: 's1' });
    expect(load.scrollback).not.toHaveBeenCalled();
  });

  it('replays saved scrollback only when asked and the terminal has an id', async () => {
    const load = loaders();
    const spec = restoredSpec(
      { key: 'p1', collapsed: false, kind: 'terminal', cwd: 'C:\\r', sessionId: null, profile: 'pwsh', scrollbackId: 's1' },
      { loadScratch: false, loadScrollback: true },
      load,
    );
    expect(spec.kind === 'terminal' && (await spec.replay)).toBe('log s1');
    const none = restoredSpec(
      { key: 'p2', collapsed: false, kind: 'terminal', cwd: 'C:\\r', sessionId: null },
      { loadScratch: false, loadScrollback: true },
      load,
    );
    expect(none).not.toHaveProperty('replay');
  });

  it('loads a pad only when restoring the workspace and the pad has a file', async () => {
    const load = loaders();
    const pad = { key: 'v1', collapsed: false, kind: 'scratch' as const, scratchId: 'x' };
    expect(restoredSpec(pad, { loadScratch: false, loadScrollback: false }, load)).toEqual({ kind: 'scratch' });
    const spec = restoredSpec(pad, { loadScratch: true, loadScrollback: false }, load);
    expect(spec.kind === 'scratch' && spec.scratchId).toBe('x');
    expect(spec.kind === 'scratch' && (await spec.text)).toBe('pad x');
    expect(
      restoredSpec({ ...pad, scratchId: null }, { loadScratch: true, loadScrollback: false }, load),
    ).toEqual({ kind: 'scratch' });
  });

  it('defaults a Files pane to not expanded', () => {
    const spec = restoredSpec(
      { key: 'v1', collapsed: false, kind: 'files', folder: 'C:\\r\\src', selected: null, root: 'C:\\r' },
      { loadScratch: true, loadScrollback: true },
      loaders(),
    );
    expect(spec).toEqual({ kind: 'files', folder: 'C:\\r\\src', selected: null, root: 'C:\\r', expanded: false, sort: undefined });
  });

  it('carries the other kinds through', () => {
    const opts = { loadScratch: true, loadScrollback: true };
    expect(restoredSpec({ key: 'v', collapsed: false, kind: 'git', root: 'C:\\r', tab: 'branches' }, opts, loaders())).toEqual({
      kind: 'git',
      root: 'C:\\r',
      tab: 'branches',
    });
    expect(restoredSpec({ key: 'v', collapsed: false, kind: 'containers' }, opts, loaders())).toEqual({ kind: 'containers' });
    expect(restoredSpec({ key: 'v', collapsed: false, kind: 'ports' }, opts, loaders())).toEqual({ kind: 'ports' });
  });
});

describe('specForKind', () => {
  const repo = () => 'C:\\repo';

  it('prefers the pane folder, then the recent terminal, then the Repo section', () => {
    expect(specForKind('files', 'C:\\a', 'C:\\b', repo)).toEqual({ kind: 'files', folder: 'C:\\a' });
    expect(specForKind('git', null, 'C:\\b', repo)).toEqual({ kind: 'git', root: 'C:\\b' });
    expect(specForKind('search', null, undefined, repo)).toEqual({ kind: 'search', root: 'C:\\repo' });
    expect(specForKind('files', null, undefined, () => null)).toEqual({ kind: 'files', folder: '' });
  });

  it('never falls back to the Repo section for a terminal', () => {
    expect(specForKind('terminal', null, undefined, repo)).toEqual({ kind: 'terminal', cwd: undefined });
    expect(specForKind('terminal', null, 'C:\\b', repo)).toEqual({ kind: 'terminal', cwd: 'C:\\b' });
  });

  it('opens a Ship pane drilled into the folder, else on the Overview', () => {
    expect(specForKind('ship', 'C:\\a', 'C:\\b', repo)).toEqual({ kind: 'ship', root: 'C:\\a' });
    expect(specForKind('ship', null, 'C:\\b', repo)).toEqual({ kind: 'ship' });
  });

  it('gives the folderless kinds a bare spec', () => {
    for (const kind of ['scratch', 'containers', 'ports', 'browser'] as const) {
      expect(specForKind(kind, 'C:\\a', 'C:\\b', repo)).toEqual({ kind });
    }
  });
});
