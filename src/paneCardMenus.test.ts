import { describe, expect, it, vi } from 'vitest';
import { item, type MenuEntry } from './contextMenuModel';
import { claudeRowMenuItems, paneCardMenuItems, sessionRowMenuItems } from './paneCardMenus';

function labels(entries: MenuEntry[]): (string | null)[] {
  return entries.map((e) => (e.kind === 'separator' ? null : e.label));
}

function run(entries: MenuEntry[], label: string): void {
  const e = entries.find((x) => x.kind === 'item' && x.label === label);
  if (e?.kind === 'item') e.run();
  else throw new Error(`no item ${label}`);
}

const open = [item('Terminal', vi.fn()), item('Files', vi.fn())];

function cardHandlers() {
  return {
    onFocus: vi.fn(),
    onToggleCollapse: vi.fn(),
    onOpenInExplorer: vi.fn(),
    onCopyPath: vi.fn(),
    onClose: vi.fn(),
  };
}

describe('paneCardMenuItems', () => {
  it('lists Focus, Collapse, the path entries, then Close for a card with a path', () => {
    const items = paneCardMenuItems({ path: 'C:\\repo', collapsed: false }, open, cardHandlers());
    expect(labels(items)).toEqual([
      'Focus',
      'Collapse',
      null,
      'Terminal',
      'Files',
      null,
      'Open in File Explorer',
      'Copy path',
      null,
      'Close',
    ]);
  });

  it('offers Expand for a collapsed card', () => {
    const items = paneCardMenuItems({ path: '', collapsed: true }, open, cardHandlers());
    expect(labels(items)).toContain('Expand');
    expect(labels(items)).not.toContain('Collapse');
  });

  it('leaves out Collapse when the card cannot collapse', () => {
    const { onToggleCollapse: _drop, ...h } = cardHandlers();
    const items = paneCardMenuItems({ path: '', collapsed: false }, open, h);
    expect(labels(items)).toEqual(['Focus', null, 'Close']);
  });

  it('drops the Open, Explorer, and Copy path entries without a path', () => {
    const items = paneCardMenuItems({ path: '', collapsed: false }, open, cardHandlers());
    expect(labels(items)).toEqual(['Focus', 'Collapse', null, 'Close']);
  });

  it('keeps the rest when there are no open items', () => {
    const items = paneCardMenuItems({ path: 'C:\\repo', collapsed: false }, [], cardHandlers());
    expect(labels(items)).toEqual(['Focus', 'Collapse', null, 'Open in File Explorer', 'Copy path', null, 'Close']);
  });

  it('passes the path to the path handlers', () => {
    const h = cardHandlers();
    const items = paneCardMenuItems({ path: 'C:\\repo', collapsed: false }, open, h);
    for (const l of ['Focus', 'Collapse', 'Open in File Explorer', 'Copy path', 'Close']) run(items, l);
    expect(h.onFocus).toHaveBeenCalledOnce();
    expect(h.onToggleCollapse).toHaveBeenCalledOnce();
    expect(h.onOpenInExplorer).toHaveBeenCalledWith('C:\\repo');
    expect(h.onCopyPath).toHaveBeenCalledWith('C:\\repo');
    expect(h.onClose).toHaveBeenCalledOnce();
  });
});

describe('sessionRowMenuItems', () => {
  const handlers = () => ({
    onOpenInExplorer: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyCwd: vi.fn(),
    onCopySessionId: vi.fn(),
  });

  it('lists the path entries then the Copy entries', () => {
    const items = sessionRowMenuItems({ cwd: 'C:\\repo', sessionId: 's1' }, open, handlers());
    expect(labels(items)).toEqual([
      'Terminal',
      'Files',
      null,
      'Open in File Explorer',
      'Copy path',
      null,
      'Copy cwd',
      'Copy session id',
    ]);
  });

  it('offers only the Copy entries without a cwd', () => {
    const items = sessionRowMenuItems({ cwd: '', sessionId: 's1' }, open, handlers());
    expect(labels(items)).toEqual(['Copy cwd', 'Copy session id']);
  });

  it('passes each handler its argument', () => {
    const h = handlers();
    const items = sessionRowMenuItems({ cwd: 'C:\\repo', sessionId: 's1' }, open, h);
    for (const l of ['Open in File Explorer', 'Copy path', 'Copy cwd', 'Copy session id']) run(items, l);
    expect(h.onOpenInExplorer).toHaveBeenCalledWith('C:\\repo');
    expect(h.onCopyPath).toHaveBeenCalledWith('C:\\repo');
    expect(h.onCopyCwd).toHaveBeenCalledWith('C:\\repo');
    expect(h.onCopySessionId).toHaveBeenCalledWith('s1');
  });
});

describe('claudeRowMenuItems', () => {
  it('lists Focus and Copy path, each calling its handler', () => {
    const h = { onFocus: vi.fn(), onCopyPath: vi.fn() };
    const items = claudeRowMenuItems({ path: 'C:\\repo' }, h);
    expect(labels(items)).toEqual(['Focus', 'Copy path']);
    run(items, 'Focus');
    run(items, 'Copy path');
    expect(h.onFocus).toHaveBeenCalledOnce();
    expect(h.onCopyPath).toHaveBeenCalledWith('C:\\repo');
  });

  it('omits Copy path without a path', () => {
    const items = claudeRowMenuItems({ path: '' }, { onFocus: vi.fn(), onCopyPath: vi.fn() });
    expect(labels(items)).toEqual(['Focus']);
  });
});
