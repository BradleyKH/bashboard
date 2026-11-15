import { describe, expect, it } from 'vitest';
import type { FileEntry } from './filesModel';
import {
  ancestorsOf,
  collapse,
  joinKey,
  parentKey,
  parseFilesView,
  pruneOpen,
  selectionKey,
  treeArrow,
  visibleItems,
  type TreeState,
} from './filesTreeModel';

const dir = (name: string): FileEntry => ({ name, isDir: true, size: 0, modified: 0 });
const file = (name: string, modified = 0): FileEntry => ({ name, isDir: false, size: 1, modified });
const BY_NAME = { key: 'name', desc: false } as const;

function state(children: Record<string, FileEntry[]>, open: string[]): TreeState {
  return { children: new Map(Object.entries(children)), open: new Set(open) };
}

const tree = state(
  {
    '': [file('README.md'), dir('src'), dir('docs')],
    src: [file('main.ts'), dir('ui')],
    'src/ui': [file('button.ts')],
    docs: [file('guide.md')],
  },
  ['src', 'src/ui'],
);

describe('visibleItems', () => {
  it('lists only the top in the Folder view', () => {
    expect(visibleItems(tree, 'folder', BY_NAME, '').map((i) => i.key)).toEqual(['docs', 'src', 'README.md']);
  });

  it('nests open folders under their rows, each sorted on its own', () => {
    const items = visibleItems(tree, 'tree', BY_NAME, '');
    expect(items.map((i) => [i.key, i.depth, i.open])).toEqual([
      ['docs', 0, false],
      ['src', 0, true],
      ['src/ui', 1, true],
      ['src/ui/button.ts', 2, false],
      ['src/main.ts', 1, false],
      ['README.md', 0, false],
    ]);
  });

  it('treats an open folder that has not listed yet as closed', () => {
    const s = state({ '': [dir('a')] }, ['a']);
    expect(visibleItems(s, 'tree', BY_NAME, '')[0].open).toBe(false);
  });

  it('keeps the parent folders of a filtered match', () => {
    expect(visibleItems(tree, 'tree', BY_NAME, 'BUTTON').map((i) => i.key)).toEqual(['src', 'src/ui', 'src/ui/button.ts']);
  });
});

describe('pruneOpen and collapse', () => {
  it('drops open folders that vanished or sit under a closed one', () => {
    const s = state({ '': [dir('src')], src: [dir('ui')], 'src/ui': [] }, ['src', 'src/ui', 'gone', 'x/y']);
    expect([...pruneOpen(s)].sort()).toEqual(['src', 'src/ui']);
    const closed = state({ '': [dir('src')], src: [dir('ui')] }, ['src/ui']);
    expect([...pruneOpen(closed)]).toEqual([]);
  });

  it('collapses a folder with the folders inside it, leaving siblings with a shared prefix', () => {
    expect([...collapse(new Set(['src', 'src/ui', 'srcx']), 'src')]).toEqual(['srcx']);
  });
});

describe('treeArrow', () => {
  const items = visibleItems(tree, 'tree', BY_NAME, '');

  it('expands, steps in, collapses, and steps out', () => {
    expect(treeArrow(items, 'docs', 'ArrowRight')).toEqual({ kind: 'expand', key: 'docs' });
    expect(treeArrow(items, 'src', 'ArrowRight')).toEqual({ kind: 'cursor', key: 'src/ui' });
    expect(treeArrow(items, 'src', 'ArrowLeft')).toEqual({ kind: 'collapse', key: 'src' });
    expect(treeArrow(items, 'src/main.ts', 'ArrowLeft')).toEqual({ kind: 'cursor', key: 'src' });
  });

  it('does nothing on a file going right, or a top-level row going left', () => {
    expect(treeArrow(items, 'README.md', 'ArrowRight')).toBeNull();
    expect(treeArrow(items, 'docs', 'ArrowLeft')).toBeNull();
    expect(treeArrow(items, null, 'ArrowLeft')).toBeNull();
  });
});

describe('keys and paths', () => {
  it('splits and joins keys', () => {
    expect(parentKey('a')).toBe('');
    expect(parentKey('a/b/c')).toBe('a/b');
    expect(ancestorsOf('a/b/c')).toEqual(['a', 'a/b']);
    expect(joinKey('C:\\repo', 'src/ui')).toBe('C:\\repo\\src\\ui');
    expect(joinKey('C:\\', 'src')).toBe('C:\\src');
    expect(joinKey('/home/me', 'a/b')).toBe('/home/me/a/b');
  });

  it('reads a requested selection as a key', () => {
    expect(selectionKey('C:\\repo', 'main.ts')).toBe('main.ts');
    expect(selectionKey('C:\\repo', 'src/ui/b.ts')).toBe('src/ui/b.ts');
    expect(selectionKey('C:\\repo', 'C:\\Repo\\src\\b.ts')).toBe('src/b.ts');
    expect(selectionKey('C:\\repo', 'D:\\other\\b.ts')).toBeNull();
    expect(selectionKey('C:\\repo', 'C:\\repo')).toBeNull();
    expect(selectionKey('C:\\repo', null)).toBeNull();
  });

  it('parses a saved view', () => {
    expect(parseFilesView('tree')).toBe('tree');
    expect(parseFilesView('folder')).toBe('folder');
    expect(parseFilesView('list')).toBeUndefined();
  });
});
