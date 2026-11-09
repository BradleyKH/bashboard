import { describe, expect, it } from 'vitest';
import {
  fileNameError,
  EMPTY_HISTORY,
  back,
  breadcrumb,
  canBack,
  canForward,
  currentFolder,
  DEFAULT_FILES_SORT,
  nextSort,
  parseFilesSort,
  type FilesSort,
  filterEntries,
  forward,
  listKey,
  parentWithin,
  previewKind,
  relativeWithin,
  sortEntries,
  visit,
  type FileEntry,
  type ListState,
} from './filesModel';

const dir = (name: string): FileEntry => ({ name, isDir: true, size: 0, modified: 0 });
const file = (name: string, modified: number, size = 10): FileEntry => ({ name, isDir: false, size, modified });

describe('sortEntries', () => {
  it('puts folders first by name, then files newest first', () => {
    const sorted = sortEntries([file('old.txt', 1), dir('src'), file('new.txt', 9), dir('Docs')]);
    expect(sorted.map((e) => e.name)).toEqual(['Docs', 'src', 'new.txt', 'old.txt']);
  });

  it('breaks modified ties by name and does not mutate the input', () => {
    const input = [file('b', 5), file('a', 5)];
    expect(sortEntries(input).map((e) => e.name)).toEqual(['a', 'b']);
    expect(input[0].name).toBe('b');
  });

  const mixed = [file('b.ts', 1), file('a.md', 3), file('c.md', 2), file('README', 3), dir('zeta'), dir('Alpha')];
  const names = (sort: FilesSort) => sortEntries(mixed, sort).map((e) => e.name);

  it('sorts by name either way, folders following only name descending', () => {
    expect(names({ key: 'name', desc: false })).toEqual(['Alpha', 'zeta', 'a.md', 'b.ts', 'c.md', 'README']);
    expect(names({ key: 'name', desc: true })).toEqual(['zeta', 'Alpha', 'README', 'c.md', 'b.ts', 'a.md']);
  });

  it('sorts by extension with ties by name, folders staying A to Z', () => {
    expect(names({ key: 'type', desc: false })).toEqual(['Alpha', 'zeta', 'README', 'a.md', 'c.md', 'b.ts']);
    expect(names({ key: 'type', desc: true })).toEqual(['Alpha', 'zeta', 'b.ts', 'a.md', 'c.md', 'README']);
  });

  it('sorts by modified either way, ties by name', () => {
    expect(names({ key: 'modified', desc: true })).toEqual(['Alpha', 'zeta', 'a.md', 'README', 'c.md', 'b.ts']);
    expect(names({ key: 'modified', desc: false })).toEqual(['Alpha', 'zeta', 'b.ts', 'c.md', 'a.md', 'README']);
  });

  it('treats a dotfile as having no extension', () => {
    const sorted = sortEntries([file('x.a', 1), file('.gitignore', 1)], { key: 'type', desc: false });
    expect(sorted.map((e) => e.name)).toEqual(['.gitignore', 'x.a']);
  });
});

describe('nextSort', () => {
  it('flips the active key and starts other keys in their own direction', () => {
    expect(nextSort(DEFAULT_FILES_SORT, 'modified')).toEqual({ key: 'modified', desc: false });
    expect(nextSort(DEFAULT_FILES_SORT, 'name')).toEqual({ key: 'name', desc: false });
    expect(nextSort({ key: 'name', desc: false }, 'name')).toEqual({ key: 'name', desc: true });
    expect(nextSort({ key: 'name', desc: true }, 'type')).toEqual({ key: 'type', desc: false });
    expect(nextSort({ key: 'type', desc: false }, 'modified')).toEqual({ key: 'modified', desc: true });
  });
});

describe('parseFilesSort', () => {
  it('keeps a valid sort and falls back otherwise', () => {
    expect(parseFilesSort({ key: 'type', desc: true })).toEqual({ key: 'type', desc: true });
    expect(parseFilesSort({ key: 'size', desc: true })).toEqual(DEFAULT_FILES_SORT);
    expect(parseFilesSort({ key: 'name' })).toEqual(DEFAULT_FILES_SORT);
    expect(parseFilesSort(undefined)).toEqual(DEFAULT_FILES_SORT);
  });
});

describe('filterEntries', () => {
  const all = [dir('Src'), file('readme.md', 1), file('SRC.txt', 2)];
  it('matches contains, ignoring case', () => {
    expect(filterEntries(all, 'src').map((e) => e.name)).toEqual(['Src', 'SRC.txt']);
  });
  it('keeps everything for empty text', () => {
    expect(filterEntries(all, '')).toHaveLength(3);
  });
});

describe('relativeWithin', () => {
  it('handles case, separators, and the root itself', () => {
    expect(relativeWithin('C:\\Repo', 'c:/repo/a\\b')).toBe('a/b');
    expect(relativeWithin('C:\\Repo\\', 'C:\\Repo')).toBe('');
    expect(relativeWithin('C:\\Repo', 'C:\\Repository')).toBeNull();
    expect(relativeWithin('C:\\Repo', 'D:\\Repo\\a')).toBeNull();
  });
});

describe('breadcrumb', () => {
  it('runs from the root down', () => {
    expect(breadcrumb('C:\\r\\app', 'C:\\r\\app\\src\\ui')).toEqual([
      { name: 'app', path: 'C:\\r\\app' },
      { name: 'src', path: 'C:\\r\\app\\src' },
      { name: 'ui', path: 'C:\\r\\app\\src\\ui' },
    ]);
  });

  it('is one segment at the root', () => {
    expect(breadcrumb('/home/a/repo', '/home/a/repo')).toEqual([{ name: 'repo', path: '/home/a/repo' }]);
  });

  it('starts from the drive for a folder outside the root', () => {
    expect(breadcrumb('C:\\r\\app', 'D:\\notes\\meet')).toEqual([
      { name: 'D:', path: 'D:\\' },
      { name: 'notes', path: 'D:\\notes' },
      { name: 'meet', path: 'D:\\notes\\meet' },
    ]);
  });

  it('starts from / for a posix folder outside the root', () => {
    expect(breadcrumb('/home/a/repo', '/srv/x')).toEqual([
      { name: '/', path: '/' },
      { name: 'srv', path: '/srv' },
      { name: 'x', path: '/srv/x' },
    ]);
  });
});

describe('parentWithin', () => {
  it('is null at the root', () => {
    expect(parentWithin('C:\\r\\app', 'c:/r/app/')).toBeNull();
  });
  it('goes up one folder inside the root', () => {
    expect(parentWithin('C:\\r\\app', 'C:\\r\\app\\src\\ui')).toBe('C:\\r\\app\\src');
  });
  it('goes up outside the root and stops at the drive', () => {
    expect(parentWithin('C:\\r\\app', 'D:\\notes')).toBe('D:\\');
    expect(parentWithin('C:\\r\\app', 'D:\\')).toBeNull();
  });
});

describe('history', () => {
  it('starts empty', () => {
    expect(currentFolder(EMPTY_HISTORY)).toBeNull();
    expect(canBack(EMPTY_HISTORY)).toBe(false);
    expect(canForward(EMPTY_HISTORY)).toBe(false);
  });

  it('steps back and forward', () => {
    let h = visit(visit(visit(EMPTY_HISTORY, '/a'), '/b'), '/c');
    expect(currentFolder(h)).toBe('/c');
    h = back(back(h));
    expect(currentFolder(h)).toBe('/a');
    expect(canBack(h)).toBe(false);
    expect(back(h)).toBe(h);
    h = forward(h);
    expect(currentFolder(h)).toBe('/b');
    expect(canForward(h)).toBe(true);
  });

  it('drops the forward stack when visiting after going back', () => {
    let h = visit(visit(visit(EMPTY_HISTORY, '/a'), '/b'), '/c');
    h = visit(back(back(h)), '/d');
    expect(h.entries).toEqual(['/a', '/d']);
    expect(canForward(h)).toBe(false);
  });

  it('treats revisiting the current folder as a no-op', () => {
    const h = visit(EMPTY_HISTORY, 'C:\\a');
    expect(visit(h, 'c:/A/')).toBe(h);
  });
});

describe('previewKind', () => {
  it('classifies by name and size', () => {
    expect(previewKind('README.MD', 10)).toBe('markdown');
    expect(previewKind('todo.txt', 10)).toBe('plain');
    expect(previewKind('Makefile', 10)).toBe('plain');
    expect(previewKind('.gitignore', 10)).toBe('plain');
    expect(previewKind('main.rs', 10)).toBe('code');
    expect(previewKind('big.md', 2 * 1024 * 1024 + 1)).toBe('binary');
    expect(previewKind('exact.txt', 2 * 1024 * 1024)).toBe('plain');
    expect(previewKind('data.CSV', 10)).toBe('csv');
    expect(previewKind('data.tsv', 10)).toBe('csv');
    expect(previewKind('big.csv', 2 * 1024 * 1024 + 1)).toBe('binary');
    expect(previewKind('shot.PNG', 10)).toBe('image');
    expect(previewKind('logo.svg', 10)).toBe('image');
    expect(previewKind('photo.jpg', 20 * 1024 * 1024)).toBe('image');
    expect(previewKind('huge.png', 32 * 1024 * 1024 + 1)).toBe('binary');
    expect(previewKind('.png', 10)).toBe('plain');
    expect(previewKind('.bashrc', 10)).toBe('code');
    expect(previewKind('Dockerfile', 10)).toBe('code');
    expect(previewKind('notes.txt', 10)).toBe('plain');
  });
});

describe('listKey', () => {
  const names = ['a', 'b', 'c'];
  const start: ListState = { selected: 'b', filter: '' };

  it('moves the selection with Up and Down and previews', () => {
    expect(listKey(start, 'ArrowDown', names)).toEqual({ state: { selected: 'c', filter: '' }, effect: 'preview' });
    expect(listKey(start, 'ArrowUp', names)).toEqual({ state: { selected: 'a', filter: '' }, effect: 'preview' });
  });

  it('clamps at the ends without an effect', () => {
    expect(listKey({ selected: 'c', filter: '' }, 'ArrowDown', names).effect).toBe('none');
    expect(listKey({ selected: 'a', filter: '' }, 'ArrowUp', names).effect).toBe('none');
  });

  it('starts at the first or last entry with nothing selected', () => {
    const none: ListState = { selected: null, filter: '' };
    expect(listKey(none, 'ArrowDown', names).state.selected).toBe('a');
    expect(listKey(none, 'ArrowUp', names).state.selected).toBe('c');
    expect(listKey(none, 'ArrowDown', []).effect).toBe('none');
  });

  it('opens on Enter only with a visible selection', () => {
    expect(listKey(start, 'Enter', names).effect).toBe('open');
    expect(listKey({ selected: 'z', filter: '' }, 'Enter', names).effect).toBe('none');
    expect(listKey({ selected: null, filter: '' }, 'Enter', names).effect).toBe('none');
  });

  it('edits the filter with Backspace and goes up when it is empty', () => {
    expect(listKey({ selected: null, filter: 'ab' }, 'Backspace', names)).toEqual({
      state: { selected: null, filter: 'a' },
      effect: 'none',
    });
    expect(listKey(start, 'Backspace', names).effect).toBe('up');
  });

  it('clears the filter with Escape', () => {
    expect(listKey({ selected: 'b', filter: 'xy' }, 'Escape', names).state.filter).toBe('');
  });

  it('appends printable characters and ignores other keys', () => {
    expect(listKey(start, 'q', names).state.filter).toBe('q');
    expect(listKey({ selected: null, filter: 'q' }, ' ', names).state.filter).toBe('q ');
    expect(listKey(start, 'F5', names)).toEqual({ state: start, effect: 'none' });
    expect(listKey(start, 'Shift', names)).toEqual({ state: start, effect: 'none' });
  });
});

describe('fileNameError', () => {
  it('accepts ordinary names, dots inside, and leading dots', () => {
    for (const name of ['a.txt', 'notes', '.gitignore', 'v1.2.3', 'with space.md']) expect(fileNameError(name)).toBeNull();
  });

  it('refuses empty, dot, and dot-dot names', () => {
    for (const name of ['', '.', '..']) expect(fileNameError(name)).not.toBeNull();
  });

  it('refuses the characters Windows forbids and control characters', () => {
    for (const name of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\tb']) {
      expect(fileNameError(name)).not.toBeNull();
    }
  });

  it('refuses a trailing dot or space', () => {
    expect(fileNameError('a.')).not.toBeNull();
    expect(fileNameError('a ')).not.toBeNull();
  });
});
