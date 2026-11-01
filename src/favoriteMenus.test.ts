import { describe, expect, it, vi } from 'vitest';
import { item, type MenuEntry, type MenuItem } from './contextMenuModel';
import { favoriteRowMenuItems, layoutRowMenuItems, recentRowMenuItems } from './favoriteMenus';

function labels(entries: MenuEntry[]): string[] {
  return entries.map((e) => (e.kind === 'separator' ? '-' : e.label));
}

function choose(entries: MenuEntry[], label: string): void {
  (entries.find((e) => e.kind === 'item' && e.label === label) as MenuItem).run();
}

const openItems = [item('Terminal', () => {}), item('Files', () => {})];

describe('favoriteRowMenuItems', () => {
  const h = () => ({ openInExplorer: vi.fn(), copyPath: vi.fn(), remove: vi.fn() });

  it('lists the Open entries, Explorer, Copy path, then Remove favorite', () => {
    expect(labels(favoriteRowMenuItems('C:/a', openItems, h()))).toEqual([
      'Terminal',
      'Files',
      '-',
      'Open in File Explorer',
      'Copy path',
      '-',
      'Remove favorite',
    ]);
  });

  it('keeps the rest when there are no Open entries', () => {
    expect(labels(favoriteRowMenuItems('C:/a', [], h()))).toEqual([
      'Open in File Explorer',
      'Copy path',
      '-',
      'Remove favorite',
    ]);
  });

  it('passes the path to Explorer and Copy path and runs remove', () => {
    const handlers = h();
    const entries = favoriteRowMenuItems('C:/a', [], handlers);
    choose(entries, 'Open in File Explorer');
    choose(entries, 'Copy path');
    choose(entries, 'Remove favorite');
    expect(handlers.openInExplorer).toHaveBeenCalledWith('C:/a');
    expect(handlers.copyPath).toHaveBeenCalledWith('C:/a');
    expect(handlers.remove).toHaveBeenCalledTimes(1);
  });
});

describe('recentRowMenuItems', () => {
  const h = () => ({ openInExplorer: vi.fn(), copyPath: vi.fn(), promote: vi.fn() });

  it('ends with Add to favorites', () => {
    expect(labels(recentRowMenuItems('C:/a', openItems, h()))).toEqual([
      'Terminal',
      'Files',
      '-',
      'Open in File Explorer',
      'Copy path',
      '-',
      'Add to favorites',
    ]);
  });

  it('keeps the rest when there are no Open entries', () => {
    expect(labels(recentRowMenuItems('C:/a', [], h()))).toEqual([
      'Open in File Explorer',
      'Copy path',
      '-',
      'Add to favorites',
    ]);
  });

  it('promotes the row path', () => {
    const handlers = h();
    choose(recentRowMenuItems('C:/a', [], handlers), 'Add to favorites');
    expect(handlers.promote).toHaveBeenCalledWith('C:/a');
  });
});

describe('layoutRowMenuItems', () => {
  it('lists Open, Rename, Remove and runs each handler', () => {
    const h = { open: vi.fn(), rename: vi.fn(), remove: vi.fn() };
    const entries = layoutRowMenuItems(h);
    expect(labels(entries)).toEqual(['Open', 'Rename', '-', 'Remove']);
    choose(entries, 'Open');
    choose(entries, 'Rename');
    choose(entries, 'Remove');
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.rename).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledTimes(1);
  });
});
