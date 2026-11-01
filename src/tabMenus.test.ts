import { describe, expect, it, vi } from 'vitest';
import { tabMenuItems, tabStripMenuItems } from './tabMenus';

describe('tabMenuItems', () => {
  it('lists Rename, New tab, and Close tab in order', () => {
    const items = tabMenuItems({ onRename: vi.fn(), onNewTab: vi.fn(), onClose: vi.fn() });
    expect(items.map((i) => i.kind === 'item' && i.label)).toEqual(['Rename', 'New tab', 'Close tab']);
  });

  it('calls each handler when its item runs', () => {
    const handlers = { onRename: vi.fn(), onNewTab: vi.fn(), onClose: vi.fn() };
    const items = tabMenuItems(handlers);
    for (const entry of items) if (entry.kind === 'item') entry.run();
    expect(handlers.onRename).toHaveBeenCalledOnce();
    expect(handlers.onNewTab).toHaveBeenCalledOnce();
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });
});

describe('tabStripMenuItems', () => {
  it('offers only New tab, which calls its handler', () => {
    const onNewTab = vi.fn();
    const items = tabStripMenuItems({ onNewTab });
    expect(items.map((i) => i.kind === 'item' && i.label)).toEqual(['New tab']);
    if (items[0].kind === 'item') items[0].run();
    expect(onNewTab).toHaveBeenCalledOnce();
  });
});
