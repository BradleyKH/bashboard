import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  back,
  breadcrumb,
  canBack,
  canForward,
  currentFolder,
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
