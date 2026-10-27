import { describe, expect, it } from 'vitest';
import {
  addPin,
  movePin,
  parseRepos,
  pinsFor,
  removePin,
  renamePin,
  resolvePin,
  toPinPath,
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
