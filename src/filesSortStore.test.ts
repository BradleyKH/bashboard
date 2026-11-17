import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILES_SORT } from './filesModel';
import {
  filesSortFor,
  filesSortsSnapshot,
  loadFilesSorts,
  onFilesSortChange,
  parseFilesSorts,
  setFilesSort,
} from './filesSortStore';

vi.mock('./platform', () => ({ platformOs: () => 'windows' }));

describe('filesSortStore', () => {
  it('remembers the sort last picked per folder, matching paths as the OS does', () => {
    loadFilesSorts({});
    const changed = vi.fn();
    onFilesSortChange(changed);
    setFilesSort('C:\\repo\\src', { key: 'name', desc: false });
    expect(filesSortFor('c:/Repo/src/')).toEqual({ key: 'name', desc: false });
    expect(filesSortFor('C:\\repo')).toEqual(DEFAULT_FILES_SORT);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('drops a folder set back to the default, and saves nothing when none remain', () => {
    loadFilesSorts({});
    setFilesSort('C:\\repo', { key: 'type', desc: true });
    setFilesSort('C:\\repo', DEFAULT_FILES_SORT);
    expect(filesSortFor('C:\\repo')).toEqual(DEFAULT_FILES_SORT);
    expect(filesSortsSnapshot()).toBeUndefined();
  });

  it('round-trips through workspace.json', () => {
    loadFilesSorts({});
    setFilesSort('C:\\repo', { key: 'name', desc: true });
    const saved = parseFilesSorts(JSON.parse(JSON.stringify(filesSortsSnapshot())));
    loadFilesSorts({});
    loadFilesSorts(saved ?? {});
    expect(filesSortFor('C:\\repo')).toEqual({ key: 'name', desc: true });
  });
});

describe('parseFilesSorts', () => {
  it('keeps valid entries and drops the rest', () => {
    expect(parseFilesSorts({ a: { key: 'name', desc: false }, b: { key: 'size', desc: true }, c: 3 })).toEqual({
      a: { key: 'name', desc: false },
    });
    expect(parseFilesSorts({ b: 'x' })).toBeUndefined();
    expect(parseFilesSorts([])).toBeUndefined();
    expect(parseFilesSorts(undefined)).toBeUndefined();
  });
});
