import { describe, expect, it } from 'vitest';
import {
  addPin,
  editCommandPin,
  movePin,
  parseRepos,
  pinsFor,
  primaryBranchFor,
  removePin,
  renamePin,
  resolvePin,
  setPrimaryBranch,
  toPinPath,
  type Pin,
  type ReposFile,
} from './repos';

const ROOT = 'C:\\src\\app';

describe('toPinPath', () => {
  it('gives a forward-slash relative path inside the root', () => {
    expect(toPinPath(ROOT, 'C:\\src\\app\\docs\\a.md')).toBe('docs/a.md');
  });
  it('compares roots without regard to case and mixed separators', () => {
    expect(toPinPath('c:/SRC/app/', 'C:\\src\\APP\\Docs')).toBe('Docs');
  });
  it('gives the root itself as a dot', () => {
    expect(toPinPath(ROOT, 'C:\\src\\app')).toBe('.');
  });
  it('keeps the absolute path outside the root, including a sibling with the same prefix', () => {
    expect(toPinPath(ROOT, 'D:\\x\\y')).toBe('D:\\x\\y');
    expect(toPinPath(ROOT, 'C:\\src\\application\\a')).toBe('C:\\src\\application\\a');
  });
});

describe('resolvePin', () => {
  it('round trips with toPinPath', () => {
    const abs = 'C:\\src\\app\\docs\\a.md';
    expect(resolvePin(ROOT, { path: toPinPath(ROOT, abs) })).toBe(abs);
    expect(resolvePin(ROOT, { path: '.' })).toBe(ROOT);
  });
  it('returns an absolute pin as is', () => {
    expect(resolvePin(ROOT, { path: 'D:\\x' })).toBe('D:\\x');
    expect(resolvePin('/home/me/app', { path: '/etc/hosts' })).toBe('/etc/hosts');
  });
  it('follows a forward-slash root', () => {
    expect(resolvePin('C:/src/app/', { path: 'a/b' })).toBe('C:/src/app/a/b');
  });
});

describe('pin edits', () => {
  it('adds, creating the root entry, and ignores a duplicate', () => {
    const one = addPin([], ROOT, { path: 'docs' });
    expect(one).toEqual([{ root: ROOT, pins: [{ path: 'docs' }] }]);
    expect(addPin(one, 'c:\\SRC\\app', { path: 'DOCS/' })).toBe(one);
  });
  it('finds pins by root without regard to case', () => {
    const f = addPin([], ROOT, { path: 'a' });
    expect(pinsFor(f, 'c:/src/APP')).toEqual([{ path: 'a' }]);
    expect(pinsFor(f, 'C:\\other')).toEqual([]);
  });
  it('renames and clears a label', () => {
    let f = addPin([], ROOT, { path: 'a' });
    f = renamePin(f, ROOT, 0, ' Notes ');
    expect(pinsFor(f, ROOT)[0]).toEqual({ path: 'a', label: 'Notes' });
    f = renamePin(f, ROOT, 0, '');
    expect(pinsFor(f, ROOT)[0]).toEqual({ path: 'a' });
  });
  it('removes, dropping the root entry with its last pin', () => {
    let f = addPin(addPin([], ROOT, { path: 'a' }), ROOT, { path: 'b' });
    f = removePin(f, ROOT, 0);
    expect(pinsFor(f, ROOT)).toEqual([{ path: 'b' }]);
    f = removePin(f, ROOT, 0);
    expect(f).toEqual([]);
  });
  it('reorders', () => {
    let f: ReposFile = [];
    for (const p of ['a', 'b', 'c']) f = addPin(f, ROOT, { path: p });
    f = movePin(f, ROOT, 0, 2);
    expect(pinsFor(f, ROOT).map((p) => p.path)).toEqual(['b', 'c', 'a']);
  });
  it('does not mutate its input', () => {
    const f = addPin([], ROOT, { path: 'a' });
    const snapshot = JSON.stringify(f);
    addPin(f, ROOT, { path: 'b' });
    renamePin(f, ROOT, 0, 'x');
    removePin(f, ROOT, 0);
    expect(JSON.stringify(f)).toBe(snapshot);
  });
});

describe('parseRepos', () => {
  it('returns an empty list for non-arrays', () => {
    expect(parseRepos(null)).toEqual([]);
    expect(parseRepos({})).toEqual([]);
  });
  it('drops malformed entries and pins', () => {
    const raw = [
      { root: ROOT, pins: [{ path: 'a', label: ' L ' }, { path: '' }, { label: 'x' }, 5, null] },
      { root: '', pins: [{ path: 'a' }] },
      { root: 'D:\\x' },
      'nope',
      { root: 'D:\\empty', pins: [] },
    ];
    expect(parseRepos(raw)).toEqual([{ root: ROOT, pins: [{ path: 'a', label: 'L' }] }]);
  });
  it('merges roots that differ only in case', () => {
    const raw = [
      { root: ROOT, pins: [{ path: 'a' }] },
      { root: 'c:/SRC/app', pins: [{ path: 'b' }] },
    ];
    const f = parseRepos(raw);
    expect(f).toHaveLength(1);
    expect(f[0].pins.map((p) => p.path)).toEqual(['a', 'b']);
  });
});

describe('primaryBranch', () => {
  it('is kept by parseRepos, including on a pinless entry, and dropped when blank', () => {
    const raw = [
      { root: ROOT, pins: [{ path: 'a' }], primaryBranch: ' dev ' },
      { root: 'D:\\x', primaryBranch: 'main' },
      { root: 'D:\\y', pins: [], primaryBranch: '  ' },
      { root: 'D:\\z', pins: [{ path: 'a' }], primaryBranch: 5 },
    ];
    expect(parseRepos(raw)).toEqual([
      { root: ROOT, pins: [{ path: 'a' }], primaryBranch: 'dev' },
      { root: 'D:\\x', pins: [], primaryBranch: 'main' },
      { root: 'D:\\z', pins: [{ path: 'a' }] },
    ]);
  });
  it('merges duplicate roots with the first branch winning', () => {
    const f = parseRepos([
      { root: ROOT, pins: [{ path: 'a' }] },
      { root: 'c:/SRC/app', pins: [], primaryBranch: 'a' },
      { root: ROOT, pins: [], primaryBranch: 'b' },
    ]);
    expect(f).toHaveLength(1);
    expect(primaryBranchFor(f, ROOT)).toBe('a');
  });
  it('is set, changed, and cleared; a pinless entry is dropped on clear', () => {
    const set = setPrimaryBranch([], ROOT, 'dev');
    expect(set).toEqual([{ root: ROOT, pins: [], primaryBranch: 'dev' }]);
    const changed = setPrimaryBranch(set, 'c:/src/APP', 'main');
    expect(primaryBranchFor(changed, ROOT)).toBe('main');
    expect(setPrimaryBranch(changed, ROOT, null)).toEqual([]);
  });
  it('keeps pins when cleared', () => {
    const f: ReposFile = [{ root: ROOT, pins: [{ path: 'a' }], primaryBranch: 'dev' }];
    expect(setPrimaryBranch(f, ROOT, null)).toEqual([{ root: ROOT, pins: [{ path: 'a' }] }]);
  });
  it('returns the same object when nothing changes', () => {
    const f: ReposFile = [{ root: ROOT, pins: [{ path: 'a' }], primaryBranch: 'dev' }];
    expect(setPrimaryBranch(f, ROOT, 'dev')).toBe(f);
    expect(setPrimaryBranch(f, 'D:\\other', null)).toBe(f);
  });
  it('survives removing the last pin', () => {
    const f: ReposFile = [{ root: ROOT, pins: [{ path: 'a' }], primaryBranch: 'dev' }];
    expect(removePin(f, ROOT, 0)).toEqual([{ root: ROOT, pins: [], primaryBranch: 'dev' }]);
  });
});

describe('command pins', () => {
  const run: Pin = { path: 'src/Api', command: 'dotnet run' };

  it('parses a command and drops a blank one', () => {
    const f = parseRepos([
      { root: ROOT, pins: [{ path: 'src/Api', command: ' dotnet run ', label: 'API' }, { path: 'b', command: '  ' }] },
    ]);
    expect(pinsFor(f, ROOT)).toEqual([{ path: 'src/Api', label: 'API', command: 'dotnet run' }, { path: 'b' }]);
  });

  it('pins several commands, and a folder pin, at one path', () => {
    let f: ReposFile = [];
    f = addPin(f, ROOT, run);
    f = addPin(f, ROOT, { path: 'src/Api', command: 'dotnet test' });
    f = addPin(f, ROOT, { path: 'src/Api' });
    expect(pinsFor(f, ROOT)).toHaveLength(3);
    expect(addPin(f, ROOT, { path: 'SRC/api', command: 'dotnet run' })).toBe(f);
  });

  it('keeps the command through a rename', () => {
    const f = addPin([], ROOT, run);
    expect(pinsFor(renamePin(f, ROOT, 0, 'API'), ROOT)).toEqual([{ path: 'src/Api', label: 'API', command: 'dotnet run' }]);
  });

  it('edits the label and command but not the folder', () => {
    const f = addPin([], ROOT, { ...run, label: 'API' });
    expect(pinsFor(editCommandPin(f, ROOT, 0, '', 'dotnet watch'), ROOT)).toEqual([
      { path: 'src/Api', command: 'dotnet watch' },
    ]);
    expect(editCommandPin(f, ROOT, 0, 'x', '  ')).toBe(f);
    expect(editCommandPin(addPin([], ROOT, { path: 'a' }), ROOT, 0, 'x', 'y')).toEqual(addPin([], ROOT, { path: 'a' }));
  });
});
