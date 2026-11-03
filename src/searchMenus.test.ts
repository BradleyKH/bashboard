import { describe, expect, it, vi } from 'vitest';
import type { MenuEntry, MenuItem } from './contextMenuModel';
import { searchGroupMenuItems, searchMatchMenuItems } from './searchMenus';

function handlers() {
  return { open: vi.fn(), showInFiles: vi.fn(), copyPath: vi.fn(), insertPath: vi.fn(), toggle: vi.fn() };
}

function labels(entries: MenuEntry[]): string[] {
  return entries.map((e) => (e.kind === 'separator' ? '-' : e.label));
}

function choose(entries: MenuEntry[], label: string): void {
  (entries.find((e) => e.kind === 'item' && e.label === label) as MenuItem).run();
}

const match = { kind: 'match' as const, path: 'src/a.ts', match: { line: 12, text: 'x', ranges: [] } };

describe('searchMatchMenuItems', () => {
  it('lists Open in editor and Show in Files, then Copy path and Insert path', () => {
    expect(labels(searchMatchMenuItems(match, handlers()))).toEqual([
      'Open in editor',
      'Show in Files',
      '-',
      'Copy path',
      'Insert path',
    ]);
  });

  it('opens the match and passes the bare file path to the others', () => {
    const h = handlers();
    const items = searchMatchMenuItems(match, h);
    choose(items, 'Open in editor');
    choose(items, 'Show in Files');
    choose(items, 'Copy path');
    choose(items, 'Insert path');
    expect(h.open).toHaveBeenCalledWith(match);
    expect(h.showInFiles).toHaveBeenCalledWith('src/a.ts');
    expect(h.copyPath).toHaveBeenCalledWith('src/a.ts');
    expect(h.insertPath).toHaveBeenCalledWith('src/a.ts');
  });
});

describe('searchGroupMenuItems', () => {
  it('offers Collapse for an expanded group and Expand for a collapsed one', () => {
    expect(labels(searchGroupMenuItems('src/a.ts', false, handlers()))).toEqual([
      'Open in editor',
      'Show in Files',
      '-',
      'Copy path',
      'Insert path',
      '-',
      'Collapse',
    ]);
    expect(labels(searchGroupMenuItems('src/a.ts', true, handlers()))[6]).toBe('Expand');
  });

  it('has no collapse item for a file-name row', () => {
    expect(labels(searchGroupMenuItems('src/a.ts', null, handlers()))).toEqual([
      'Open in editor',
      'Show in Files',
      '-',
      'Copy path',
      'Insert path',
    ]);
  });

  it('passes the file path to every handler', () => {
    const h = handlers();
    const items = searchGroupMenuItems('src/a.ts', false, h);
    choose(items, 'Open in editor');
    choose(items, 'Show in Files');
    choose(items, 'Copy path');
    choose(items, 'Insert path');
    choose(items, 'Collapse');
    expect(h.open).toHaveBeenCalledWith({ kind: 'name', path: 'src/a.ts' });
    expect(h.showInFiles).toHaveBeenCalledWith('src/a.ts');
    expect(h.copyPath).toHaveBeenCalledWith('src/a.ts');
    expect(h.insertPath).toHaveBeenCalledWith('src/a.ts');
    expect(h.toggle).toHaveBeenCalledWith('src/a.ts');
  });
});
