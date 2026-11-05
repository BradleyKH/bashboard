import { describe, expect, it } from 'vitest';
import { actionLabel, actionOrder } from './helpModel';
import { ARG_ACTIONS, DEFAULT_KEYBINDINGS, SIMPLE_ACTIONS, type KeybindingEntry } from './keymap';
import {
  CATEGORY_ORDER,
  DIRECTIONAL_ACTIONS,
  EXCLUDED_ACTIONS,
  buildPaletteItems,
  fuzzyScore,
  pushRecent,
  rankPalette,
  type PaletteInput,
  type PaletteItem,
} from './paletteModel';

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  return {
    panes: [
      { paneId: 'p1', tabId: 't1', title: 'claude' },
      { paneId: 'p2', tabId: 't2', title: 'server logs' },
    ],
    tabs: [
      { id: 't1', title: 'Main' },
      { id: 't2', title: 'Backend' },
    ],
    favorites: [{ label: 'bashboard', path: 'C:/repos/bashboard' }],
    layouts: [
      { name: 'Two up', paneCount: 2 },
      { name: 'Solo', paneCount: 1 },
    ],
    pins: [
      { pin: { path: 'docs/design.md' }, absolute: 'C:/repos/bashboard/docs/design.md', exists: true },
      { pin: { path: 'src', label: 'Sources' }, absolute: 'C:/repos/bashboard/src', exists: true },
      { pin: { path: 'gone.txt' }, absolute: 'C:/repos/bashboard/gone.txt', exists: false },
    ],
    worktrees: [{ path: 'C:/repos/bashboard-wt', name: 'bashboard-wt', branch: 'feature/x' }],
    keybindings: DEFAULT_KEYBINDINGS,
    ...overrides,
  };
}

function byLabel(items: PaletteItem[], label: string): PaletteItem | undefined {
  return items.find((i) => i.label === label);
}

describe('buildPaletteItems', () => {
  it('lists Check for updates as an action with no keys and no F1 row', () => {
    const items = buildPaletteItems(input());
    expect(items.find((i) => i.label === 'Check for updates')).toMatchObject({
      category: 'Action',
      choice: { kind: 'command', command: 'checkForUpdates' },
    });
    expect(rankPalette(items, '>updates', []).some((i) => i.label === 'Check for updates')).toBe(true);
    expect(actionOrder()).not.toContain('checkForUpdates');
  });

  it('lists the Containers, Ports, and Ship tabs as commands', () => {
    const items = buildPaletteItems(input());
    for (const [label, command] of [
      ['Open the Containers tab', 'openContainers'],
      ['Open the Ports tab', 'openPorts'],
      ['Open the Ship tab', 'openShip'],
    ]) {
      expect(byLabel(items, label)).toMatchObject({ category: 'Action', choice: { kind: 'command', command } });
    }
  });

  const items = buildPaletteItems(input());

  it('lists one item per pane with its tab title as detail', () => {
    const panes = items.filter((i) => i.category === 'Pane');
    expect(panes.map((p) => [p.id, p.label, p.detail])).toEqual([
      ['pane:p1', 'claude', 'Main'],
      ['pane:p2', 'server logs', 'Backend'],
    ]);
    expect(panes[0].choice).toEqual({ kind: 'pane', paneId: 'p1' });
  });

  it('lists tabs, favorites, layouts, pins, and worktrees with their categories', () => {
    expect(byLabel(items, 'Main')).toMatchObject({ id: 'tab:t1', category: 'Tab', choice: { kind: 'tab', tabId: 't1' } });
    expect(byLabel(items, 'bashboard')).toMatchObject({ category: 'Favorite', detail: 'C:/repos/bashboard', choice: { kind: 'favorite', path: 'C:/repos/bashboard' } });
    expect(byLabel(items, 'Two up')).toMatchObject({ category: 'Layout', detail: '2 panes', choice: { kind: 'layout', name: 'Two up' } });
    expect(byLabel(items, 'Solo')?.detail).toBe('1 pane');
    expect(byLabel(items, 'design.md')).toMatchObject({ id: 'pin:C:/repos/bashboard/docs/design.md', category: 'Pin', detail: 'docs/design.md' });
    expect(byLabel(items, 'Sources')).toMatchObject({ category: 'Pin', choice: { kind: 'pin', pin: { path: 'src', label: 'Sources' } } });
    expect(byLabel(items, 'bashboard-wt')).toMatchObject({ category: 'Worktree', detail: 'feature/x', choice: { kind: 'worktree', path: 'C:/repos/bashboard-wt' } });
  });

  it('labels a pin on the repo root by the root folder name', () => {
    const root = buildPaletteItems(input({ pins: [{ pin: { path: '.' }, absolute: 'C:\\repos\\bashboard', exists: true }] }));
    expect(root.find((i) => i.category === 'Pin')).toMatchObject({ label: 'bashboard', detail: undefined });
  });

  it('shows the root folder name as detail when a root pin has its own label', () => {
    const root = buildPaletteItems(input({ pins: [{ pin: { path: '.', label: 'Home' }, absolute: 'C:\\repos\\bashboard', exists: true }] }));
    expect(root.find((i) => i.category === 'Pin')).toMatchObject({ label: 'Home', detail: 'bashboard' });
  });

  it('leaves out a missing pin', () => {
    expect(items.some((i) => i.id.includes('gone.txt'))).toBe(false);
  });

  it('keeps categories in CATEGORY_ORDER', () => {
    const order = items.map((i) => CATEGORY_ORDER.indexOf(i.category));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(items.map((i) => i.category))).toEqual(new Set(CATEGORY_ORDER));
  });
});

describe('palette actions', () => {
  const actions = buildPaletteItems(input()).filter((i) => i.category === 'Action');
  const types = actions.map((a) => (a.choice.kind === 'action' ? a.choice.action.type : ''));

  it('excludes text, number, and palette actions', () => {
    for (const name of ['copy', 'paste', 'sendInput', 'switchToTab', 'openPalette']) {
      expect(EXCLUDED_ACTIONS).toContain(name);
      expect(types).not.toContain(name);
    }
  });

  it('includes the rest, with one item per direction', () => {
    expect(types).toContain('nextAttention');
    expect(types).toContain('openLayout');
    expect(types).toContain('switchToLastTab');
    const moves = actions.filter((a) => a.choice.kind === 'action' && a.choice.action.type === 'moveFocus');
    expect(moves.map((m) => m.label)).toEqual(['Move focus left', 'Move focus right', 'Move focus up', 'Move focus down']);
    expect(moves[0]).toMatchObject({ id: 'action:moveFocus:left', hint: 'Alt+Left', choice: { action: { type: 'moveFocus', direction: 'left' } } });
  });

  it('shows chords from the live keybindings as hints', () => {
    expect(byLabel(actions, 'Open a saved layout')?.hint).toBe('Ctrl+Shift+R');
    expect(byLabel(actions, 'Increase font size')?.hint).toBe('Ctrl+=, Ctrl++');
  });

  it('follows overrides and leaves unbound actions without a hint', () => {
    const git = actionLabel('openGit') as string;
    const unbound = DEFAULT_KEYBINDINGS.filter((e) => e.action !== 'openGit');
    expect(byLabel(buildPaletteItems(input({ keybindings: unbound })), git)?.hint).toBeUndefined();
    const rebound: KeybindingEntry[] = [...unbound, { keys: 'alt+g', action: 'openGit' }];
    expect(byLabel(buildPaletteItems(input({ keybindings: rebound })), git)?.hint).toBe('Alt+G');
  });

  it('lists only simple, excluded, or directional actions from the F1 order', () => {
    const allowed = new Set<string>([...SIMPLE_ACTIONS, ...EXCLUDED_ACTIONS, ...DIRECTIONAL_ACTIONS]);
    for (const name of actionOrder()) expect(allowed.has(name), name).toBe(true);
  });

  it('covers every keymap action in the F1 order with a label', () => {
    const order = actionOrder();
    for (const name of [...SIMPLE_ACTIONS, ...ARG_ACTIONS]) {
      expect(order).toContain(name);
      // The F1 guide labels each sendInput binding by its input instead.
      if (name !== 'sendInput') expect(actionLabel(name)).toBeTruthy();
    }
  });
});

describe('fuzzyScore', () => {
  it('prefers word starts over scattered letters', () => {
    expect(fuzzyScore('sr', 'Split right')!).toBeGreaterThan(fuzzyScore('sr', 'Close tabs here')!);
  });

  it('prefers consecutive letters over scattered ones', () => {
    expect(fuzzyScore('tab', 'New tab')!).toBeGreaterThan(fuzzyScore('tab', 'Toggle a backdrop')!);
  });

  it('prefers a word-start match over a mid-word one', () => {
    expect(fuzzyScore('g', 'Git pane')!).toBeGreaterThan(fuzzyScore('g', 'Toggle')!);
  });

  it('counts a camelCase step as a word start', () => {
    expect(fuzzyScore('b', 'nextBranch')!).toBeGreaterThan(fuzzyScore('b', 'nextabranch')!);
  });

  it('returns null when a character is missing', () => {
    expect(fuzzyScore('xyz', 'Split right')).toBeNull();
  });

  it('ignores case and query spaces', () => {
    expect(fuzzyScore('S R', 'split right')).toBe(fuzzyScore('sr', 'Split Right'));
  });
});

describe('rankPalette', () => {
  const items = buildPaletteItems(input());

  it('ranks a label match above a detail-only match', () => {
    const panes: PaletteItem[] = [
      { id: 'pane:a', category: 'Pane', label: 'claude', detail: 'logs', choice: { kind: 'pane', paneId: 'a' } },
      { id: 'pane:b', category: 'Pane', label: 'logs', detail: 'Main', choice: { kind: 'pane', paneId: 'b' } },
    ];
    expect(rankPalette(panes, 'logs', []).map((i) => i.id)).toEqual(['pane:b', 'pane:a']);
  });

  it('keeps category order on ties', () => {
    const tied: PaletteItem[] = [
      { id: 'action:x', category: 'Action', label: 'alpha', choice: { kind: 'action', action: { type: 'newTab' } } },
      { id: 'tab:x', category: 'Tab', label: 'alpha', choice: { kind: 'tab', tabId: 'x' } },
      { id: 'pane:x', category: 'Pane', label: 'alpha', choice: { kind: 'pane', paneId: 'x' } },
    ];
    expect(rankPalette(tied, 'alp', []).map((i) => i.id)).toEqual(['pane:x', 'tab:x', 'action:x']);
  });

  it('drops items matching neither label nor detail', () => {
    expect(rankPalette(items, 'qqq', [])).toEqual([]);
  });

  it('limits a leading > to actions, in built order', () => {
    const actions = items.filter((i) => i.category === 'Action');
    expect(rankPalette(items, '>', [])).toEqual(actions);
    expect(rankPalette(items, '  > ', ['pane:p1'])).toEqual(actions);
  });

  it('matches the rest of a > query against actions only', () => {
    const result = rankPalette(items, '>tab', []);
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((i) => i.category === 'Action')).toBe(true);
    expect(result.map((i) => i.label)).toContain('New tab');
    expect(result.some((i) => i.id === 'tab:t1')).toBe(false);
  });

  it('lists recents first on an empty query, then the rest in category order', () => {
    const recents = ['action:newTab', 'layout:Solo', 'pane:gone'];
    const result = rankPalette(items, '', recents);
    expect(result.slice(0, 2).map((i) => i.id)).toEqual(['action:newTab', 'layout:Solo']);
    expect(result.slice(2)).toEqual(items.filter((i) => i.id !== 'action:newTab' && i.id !== 'layout:Solo'));
    expect(result).toHaveLength(items.length);
  });
});

describe('pushRecent', () => {
  it('moves a repeat to the front', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });

  it('caps the length', () => {
    expect(pushRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
    expect(pushRecent(Array.from({ length: 10 }, (_, i) => `x${i}`), 'new')).toHaveLength(10);
  });
});
