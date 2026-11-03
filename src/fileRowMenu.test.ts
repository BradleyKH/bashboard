import { describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem, MenuSubmenu } from './contextMenuModel';
import {
  filePreviewMenuItems,
  fileRowMenuItems,
  folderMenuItems,
  type FileRowMenuHandlers,
} from './fileRowMenu';
import type { FileEntry } from './filesModel';

const file: FileEntry = { name: 'a.ts', isDir: false, size: 10, modified: 0 };
const dir: FileEntry = { name: 'src', isDir: true, size: 0, modified: 0 };
const targets = [
  { label: 'docs/', path: 'C:/r/docs' },
  { label: 'lib/', path: 'C:/r/lib' },
];

function labels(entries: MenuEntry[]): string[] {
  return entries.map((e) => (e.kind === 'separator' ? '-' : e.label));
}

function find(entries: MenuEntry[], label: string): MenuItem {
  const e = entries.find((x) => x.kind === 'item' && x.label === label);
  if (!e || e.kind !== 'item') throw new Error(`no item ${label}`);
  return e;
}

function rowHandlers(): FileRowMenuHandlers {
  return {
    openTerminalHere: vi.fn(),
    searchHere: vi.fn(),
    openInEditor: vi.fn(),
    copyPath: vi.fn(),
    insertPath: vi.fn(),
    moveTo: vi.fn(),
    rename: vi.fn(),
    pin: vi.fn(),
  };
}

describe('fileRowMenuItems', () => {
  it('offers Open terminal here and Search in this folder for folders, and no Move to', () => {
    expect(labels(fileRowMenuItems(dir, [dir], targets, rowHandlers()))).toEqual([
      'Open terminal here',
      'Search in this folder',
      'Open in editor',
      '-',
      'Copy path',
      'Insert path',
      '-',
      'Rename',
      'Pin',
    ]);
  });

  it('offers Move to for files with targets, and no Open terminal here', () => {
    expect(labels(fileRowMenuItems(file, [file], targets, rowHandlers()))).toEqual([
      'Open in editor',
      '-',
      'Copy path',
      'Insert path',
      '-',
      'Move to',
      'Rename',
      'Pin',
    ]);
  });

  it('leaves Move to out with no targets', () => {
    expect(labels(fileRowMenuItems(file, [file], [], rowHandlers()))).not.toContain('Move to');
  });

  it('moves the entry to the chosen target from the submenu', () => {
    const h = rowHandlers();
    const sub = fileRowMenuItems(file, [file], targets, h).find((e) => e.kind === 'submenu') as MenuSubmenu;
    expect(sub.items.map((i) => (i.kind === 'item' ? i.label : '-'))).toEqual(['docs/', 'lib/']);
    (sub.items[1] as MenuItem).run();
    expect(h.moveTo).toHaveBeenCalledWith([file], 'C:/r/lib');
  });

  it('passes the entry to each handler', () => {
    const h = rowHandlers();
    const items = fileRowMenuItems(dir, [dir], [], h);
    find(items, 'Open terminal here').run();
    find(items, 'Search in this folder').run();
    find(items, 'Open in editor').run();
    find(items, 'Copy path').run();
    find(items, 'Insert path').run();
    find(items, 'Pin').run();
    expect(h.openTerminalHere).toHaveBeenCalledWith(dir);
    expect(h.searchHere).toHaveBeenCalledWith(dir);
    expect(h.openInEditor).toHaveBeenCalledWith(dir);
    expect(h.copyPath).toHaveBeenCalledWith([dir]);
    expect(h.insertPath).toHaveBeenCalledWith([dir]);
    expect(h.pin).toHaveBeenCalledWith(dir);
  });
});

describe('fileRowMenuItems with several selected', () => {
  const other: FileEntry = { name: 'b.md', isDir: false, size: 5, modified: 0 };

  it('keeps only the items that take many paths', () => {
    expect(labels(fileRowMenuItems(file, [dir, file, other], targets, rowHandlers()))).toEqual([
      'Copy paths',
      'Insert paths',
      '-',
      'Move 2 files to',
    ]);
  });

  it('moves only the files and passes every entry to Copy paths', () => {
    const h = rowHandlers();
    const items = fileRowMenuItems(file, [dir, file, other], targets, h);
    find(items, 'Copy paths').run();
    expect(h.copyPath).toHaveBeenCalledWith([dir, file, other]);
    const sub = items.find((e) => e.kind === 'submenu') as MenuSubmenu;
    (sub.items[0] as MenuItem).run();
    expect(h.moveTo).toHaveBeenCalledWith([file, other], 'C:/r/docs');
  });

  it('leaves Move to out when only folders are selected', () => {
    const lib: FileEntry = { ...dir, name: 'lib' };
    expect(labels(fileRowMenuItems(dir, [dir, lib], targets, rowHandlers()))).toEqual(['Copy paths', 'Insert paths']);
  });
});

describe('folderMenuItems', () => {
  const handlers = () => ({
    openTerminalHere: vi.fn(),
    openInExplorer: vi.fn(),
    searchHere: vi.fn(),
    copyPath: vi.fn(),
    togglePin: vi.fn(),
  });

  it('labels the pin item Pin or Unpin by state', () => {
    expect(labels(folderMenuItems({ pinned: false }, handlers()))).toEqual([
      'Open terminal here',
      'Open in File Explorer',
      'Search in this folder',
      '-',
      'Copy path',
      '-',
      'Pin',
    ]);
    expect(labels(folderMenuItems({ pinned: true }, handlers()))).toContain('Unpin');
  });

  it('calls each handler', () => {
    const h = handlers();
    const items = folderMenuItems({ pinned: true }, h);
    find(items, 'Open terminal here').run();
    find(items, 'Open in File Explorer').run();
    find(items, 'Search in this folder').run();
    find(items, 'Copy path').run();
    find(items, 'Unpin').run();
    expect(h.openTerminalHere).toHaveBeenCalledOnce();
    expect(h.openInExplorer).toHaveBeenCalledOnce();
    expect(h.searchHere).toHaveBeenCalledOnce();
    expect(h.copyPath).toHaveBeenCalledOnce();
    expect(h.togglePin).toHaveBeenCalledOnce();
  });
});

describe('filePreviewMenuItems', () => {
  const handlers = () => ({ copy: vi.fn(), find: vi.fn(), openInEditor: vi.fn(), copyPath: vi.fn() });

  it('offers Copy only with a selection', () => {
    expect(labels(filePreviewMenuItems({ hasSelection: false, path: 'C:/r/a.ts' }, handlers()))).toEqual([
      'Find',
      'Open in editor',
      '-',
      'Copy path',
    ]);
    expect(labels(filePreviewMenuItems({ hasSelection: true, path: 'C:/r/a.ts' }, handlers()))).toEqual([
      'Copy',
      '-',
      'Find',
      'Open in editor',
      '-',
      'Copy path',
    ]);
  });

  it('gives no items without a path', () => {
    expect(filePreviewMenuItems({ hasSelection: true, path: null }, handlers())).toEqual([]);
  });

  it('disables Find when the preview has no find bar', () => {
    const items = filePreviewMenuItems({ hasSelection: false, path: 'C:/r/a.bin', canFind: false }, handlers());
    expect(find(items, 'Find').enabled).toBe(false);
  });

  it('passes the previewed path to Open in editor and Copy path', () => {
    const h = handlers();
    const items = filePreviewMenuItems({ hasSelection: true, path: 'C:/r/a.ts' }, h);
    find(items, 'Copy').run();
    find(items, 'Find').run();
    find(items, 'Open in editor').run();
    find(items, 'Copy path').run();
    expect(h.copy).toHaveBeenCalledOnce();
    expect(h.find).toHaveBeenCalledOnce();
    expect(h.openInEditor).toHaveBeenCalledWith('C:/r/a.ts');
    expect(h.copyPath).toHaveBeenCalledWith('C:/r/a.ts');
  });
});
