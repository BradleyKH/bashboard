import { describe, expect, it, vi } from 'vitest';
import { item, type MenuEntry, type MenuSubmenu } from './contextMenuModel';
import { titleStripMenuItems } from './titleStrip';

function hooks() {
  return { onCollapse: vi.fn(), onClose: vi.fn(), onZoom: vi.fn() };
}
const zoom = (available: boolean, zoomed = false) => ({ available, zoomed, attention: false });
const labels = (entries: MenuEntry[]) => entries.filter((e) => e.kind !== 'separator').map((e) => (e as { label: string }).label);
const find = (entries: MenuEntry[], label: string) => entries.find((e) => e.kind !== 'separator' && e.label === label)!;

describe('titleStripMenuItems', () => {
  it('omits Zoom when unavailable', () => {
    const entries = titleStripMenuItems({ kindItems: [], zoom: zoom(false) }, hooks());
    expect(labels(entries)).toEqual(['Change kind', 'Collapse', 'Close pane']);
  });

  it('offers Zoom, or Restore while zoomed', () => {
    expect(labels(titleStripMenuItems({ kindItems: [], zoom: zoom(true) }, hooks()))).toEqual([
      'Change kind', 'Collapse', 'Zoom', 'Close pane',
    ]);
    expect(labels(titleStripMenuItems({ kindItems: [], zoom: zoom(true, true) }, hooks()))).toContain('Restore');
  });

  it('holds the kind items in the Change kind submenu', () => {
    const kindItems = [item('Terminal', () => {}), item('Files', () => {})];
    const entries = titleStripMenuItems({ kindItems, zoom: zoom(false) }, hooks());
    expect((find(entries, 'Change kind') as MenuSubmenu).items).toBe(kindItems);
  });

  it('offers New pin only with its hook, before Close pane', () => {
    const onNewPin = vi.fn();
    const entries = titleStripMenuItems({ kindItems: [], zoom: zoom(false) }, { ...hooks(), onNewPin });
    expect(labels(entries)).toEqual(['Change kind', 'Collapse', 'New pin', 'Close pane']);
    (find(entries, 'New pin') as { run(): void }).run();
    expect(onNewPin).toHaveBeenCalledOnce();
  });

  it('offers Move to new tab only with its hook and while the tab has another pane', () => {
    const onMoveToNewTab = vi.fn();
    const h = { ...hooks(), onMoveToNewTab };
    expect(labels(titleStripMenuItems({ kindItems: [], zoom: zoom(false) }, h))).not.toContain('Move to new tab');
    expect(labels(titleStripMenuItems({ kindItems: [], zoom: zoom(false), canMoveToNewTab: true }, hooks()))).not.toContain(
      'Move to new tab',
    );
    const entries = titleStripMenuItems({ kindItems: [], zoom: zoom(true), canMoveToNewTab: true }, h);
    expect(labels(entries)).toEqual(['Change kind', 'Collapse', 'Zoom', 'Move to new tab', 'Close pane']);
    (find(entries, 'Move to new tab') as { run(): void }).run();
    expect(onMoveToNewTab).toHaveBeenCalledOnce();
  });

  it('calls each hook', () => {
    const h = hooks();
    const entries = titleStripMenuItems({ kindItems: [], zoom: zoom(true) }, h);
    for (const label of ['Collapse', 'Zoom', 'Close pane']) (find(entries, label) as { run(): void }).run();
    expect(h.onCollapse).toHaveBeenCalledOnce();
    expect(h.onZoom).toHaveBeenCalledOnce();
    expect(h.onClose).toHaveBeenCalledOnce();
  });
});
