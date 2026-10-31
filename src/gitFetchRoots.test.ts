import { describe, expect, it } from 'vitest';
import type { PaneCardInput } from './dashboardModel';
import { gitRootsOf } from './gitFetchRoots';

function pane(kind: 'git' | 'files' | 'terminal', folder: string | null): PaneCardInput {
  return { kind, paneId: 'p', tabId: 't', title: '', folder } as unknown as PaneCardInput;
}

describe('gitRootsOf', () => {
  it('ignores other pane kinds and terminals', () => {
    expect(gitRootsOf([pane('files', 'C:\\a'), pane('terminal', 'C:\\b'), pane('git', 'C:\\c')])).toEqual(['C:\\c']);
  });
  it('skips a null folder', () => {
    expect(gitRootsOf([pane('git', null)])).toEqual([]);
  });
  it('dedupes roots that differ only in case or slash style, keeping the first spelling', () => {
    expect(gitRootsOf([pane('git', 'C:\\Repos\\App'), pane('git', 'c:/repos/app/')])).toEqual(['C:\\Repos\\App']);
  });
  it('sorts case-insensitively', () => {
    expect(gitRootsOf([pane('git', 'C:\\b'), pane('git', 'C:\\A')])).toEqual(['C:\\A', 'C:\\b']);
  });
  it('gives an empty list for no panes', () => {
    expect(gitRootsOf([])).toEqual([]);
  });
});
