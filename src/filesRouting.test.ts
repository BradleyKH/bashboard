import { describe, expect, it } from 'vitest';
import { insertPathText, pinTarget, routeFilesRequest } from './filesRouting';

describe('routeFilesRequest', () => {
  const panes = [
    { paneId: 'p1', root: 'C:\\r\\app', folder: 'C:\\r\\app\\src' },
    { paneId: 'p2', root: 'C:\\r\\other', folder: 'C:\\r\\other' },
    { paneId: 'p3', root: 'c:/r/app', folder: 'C:\\r\\app\\docs' },
  ];

  it('reuses a pane for the same repo, ignoring case and separators', () => {
    expect(routeFilesRequest(panes, { root: 'C:/R/APP', folder: 'C:\\r\\app\\x' })).toEqual({ reuse: 'p1' });
  });

  it('prefers the pane already in the requested folder', () => {
    expect(routeFilesRequest(panes, { root: 'C:\\r\\app', folder: 'C:\\r\\app\\docs' })).toEqual({ reuse: 'p3' });
  });

  it('opens a new pane when none shows the repo', () => {
    expect(routeFilesRequest(panes, { root: 'C:\\r\\third', folder: 'C:\\r\\third' })).toEqual({ open: true });
    expect(routeFilesRequest([], { root: 'C:\\r', folder: 'C:\\r' })).toEqual({ open: true });
  });
});

describe('pinTarget', () => {
  it('shows a folder pin as itself', () => {
    expect(pinTarget('C:\\r', 'C:\\r\\docs', true)).toEqual({ folder: 'C:\\r\\docs' });
  });

  it('shows a file pin in its folder and selects it', () => {
    expect(pinTarget('C:\\r', 'C:\\r\\docs\\todo.md', false)).toEqual({
      folder: 'C:\\r\\docs',
      select: 'C:\\r\\docs\\todo.md',
    });
    expect(pinTarget('/r', '/r/todo.md', false)).toEqual({ folder: '/r', select: '/r/todo.md' });
  });

  it('handles a file at a drive root and outside the repo', () => {
    expect(pinTarget('C:\\r', 'D:\\todo.md', false).folder).toBe('D:\\');
    expect(pinTarget('C:\\r', 'D:\\notes\\a.md', false).folder).toBe('D:\\notes');
  });
});

describe('insertPathText', () => {
  it('gives a forward-slash relative path inside the repo', () => {
    expect(insertPathText('C:\\r\\app', 'C:\\r\\app\\src\\a.ts')).toBe('src/a.ts');
    expect(insertPathText('c:/R/app', 'C:\\r\\APP\\README.md')).toBe('README.md');
  });

  it('gives the absolute path outside the repo', () => {
    expect(insertPathText('C:\\r\\app', 'D:\\notes\\a.md')).toBe('D:\\notes\\a.md');
    expect(insertPathText('C:\\r\\app', 'C:\\r\\application\\a.md')).toBe('C:\\r\\application\\a.md');
  });

  it('gives a dot for the root itself', () => {
    expect(insertPathText('C:\\r\\app', 'C:\\r\\app\\')).toBe('.');
  });
});
