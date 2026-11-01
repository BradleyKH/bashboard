import { describe, expect, it } from 'vitest';
import {
  addOps,
  applyOps,
  checkChord,
  editSections,
  filterSections,
  inverseOps,
  movedNoticeText,
  moveStripText,
  ownerOf,
  removeOps,
  replaceOps,
  resetAllOps,
  resetPlan,
  resetStripText,
  shellNoteFor,
  type EditRow,
} from './keybindingEdit';
import { ACTION_NAMES, DEFAULT_KEYBINDINGS, buildKeymap, parseChord, type Chord, type KeybindingEntry } from './keymap';
import type { KeybindingOp } from './settings';

const DEFAULTS = DEFAULT_KEYBINDINGS;

function chord(keys: string): Chord {
  return parseChord(keys)!;
}

function rows(live: KeybindingEntry[]): EditRow[] {
  return editSections(live).flatMap((s) => s.rows);
}

function row(live: KeybindingEntry[], id: string): EditRow {
  const r = rows(live).find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

/** The effective keymap as a sorted chord-to-action list, for exact comparison. */
function keymapOf(live: KeybindingEntry[]): [string, unknown][] {
  return [...buildKeymap(live).keymap].sort(([a], [b]) => a.localeCompare(b));
}

// A customized live list in the Rust merged shape: defaults minus overridden chords, then user entries.
const CUSTOM: KeybindingEntry[] = applyOps(DEFAULTS, [
  { op: 'bind', keys: 'Shift+Ctrl+D', action: 'splitAuto' },
  { op: 'unbind', keys: 'ctrl+c' },
  { op: 'bind', keys: 'ctrl+alt+k', action: 'openPalette' },
  { op: 'bind', keys: 'ctrl+r', action: 'openGit' },
  { op: 'bind', keys: 'ctrl+alt+right', action: 'moveFocus', direction: 'right' },
]);

describe('editSections', () => {
  it('gives one row per argument', () => {
    const all = rows(DEFAULTS);
    expect(all.filter((r) => r.action === 'moveFocus').map((r) => r.label)).toEqual([
      'Move focus left',
      'Move focus right',
      'Move focus up',
      'Move focus down',
    ]);
    expect(all.filter((r) => r.action === 'resizePane').map((r) => r.id)).toEqual([
      'resizePane:left',
      'resizePane:right',
      'resizePane:up',
      'resizePane:down',
    ]);
    const tabs = all.filter((r) => r.action === 'switchToTab');
    expect(tabs.map((r) => r.label)).toEqual(Array.from({ length: 8 }, (_, i) => `Go to tab ${i + 1}`));
    expect(tabs[2]).toMatchObject({ id: 'switchToTab:3', chords: ['ctrl+alt+3'], args: { index: 3 } });
  });

  it('labels sendInput rows by input', () => {
    const newline = row(DEFAULTS, 'sendInput:' + JSON.stringify('\u001b\r'));
    expect(newline).toMatchObject({ label: 'Claude Code newline', chords: ['shift+enter'], modified: false });
    const extra = [...DEFAULTS, { keys: 'ctrl+alt+h', action: 'sendInput', input: 'hi' }];
    expect(row(extra, 'sendInput:"hi"')).toMatchObject({ label: 'Type "hi"', modified: true, defaults: [] });
  });

  it('keeps a row for an action with no chord', () => {
    const live = applyOps(DEFAULTS, removeOps('ctrl+shift+p'));
    expect(row(live, 'openPalette')).toMatchObject({ chords: [], modified: true });
    expect(row(live, 'openPalette').defaults).toEqual(['ctrl+shift+p']);
  });

  it('has a row for every action name and none for rejected entries', () => {
    const live = [...DEFAULTS, { keys: 'ctrl+alt+q', action: 'nope' }, { keys: 'ctrl+alt+w', action: 'moveFocus' }];
    const all = rows(live);
    for (const name of ACTION_NAMES) expect(all.some((r) => r.action === name)).toBe(true);
    expect(all.some((r) => r.chords.includes('ctrl+alt+q') || r.chords.includes('ctrl+alt+w'))).toBe(false);
  });

  it('keeps the user spelling, marks modified rows, and carries notes', () => {
    const r = row(CUSTOM, 'splitAuto');
    expect(r.chords).toEqual(['alt+shift+d', 'Shift+Ctrl+D']);
    expect(r.modified).toBe(true);
    expect(row(CUSTOM, 'toggleBackdrop')).toMatchObject({ chords: [], modified: true });
    expect(row(DEFAULTS, 'copy').note).toMatch(/nothing selected/);
    expect(rows(DEFAULTS).every((x) => !x.modified)).toBe(true);
  });
});

describe('filterSections', () => {
  it('matches labels ignoring case and drops empty sections', () => {
    const found = filterSections(editSections(DEFAULTS), 'TAB');
    expect(found.map((s) => s.title)).toEqual(['Tabs']);
    expect(found[0].rows.length).toBe(13);
    expect(filterSections(editSections(DEFAULTS), 'zzz')).toEqual([]);
    expect(filterSections(editSections(DEFAULTS), '  ')).toHaveLength(editSections(DEFAULTS).length);
  });
});

describe('checkChord refusals', () => {
  const r = row(DEFAULTS, 'openPalette');
  it.each([
    ['a', 'A would stop typing a'],
    ['shift+a', 'Shift+A would stop typing A'],
    ['space', 'Space would stop typing a space'],
    ['escape', 'Escape would stop reaching the shell'],
    ['enter', 'Enter would stop reaching the shell'],
    ['tab', 'Tab would stop reaching the shell'],
    ['backspace', 'Backspace would stop reaching the shell'],
  ])('refuses %s', (keys, message) => {
    expect(checkChord(chord(keys), r, DEFAULTS)).toEqual({ kind: 'refused', message });
  });

  it('allows modified printable keys', () => {
    expect(checkChord(chord('ctrl+alt+a'), r, DEFAULTS).kind).not.toBe('refused');
    expect(checkChord(chord('alt+shift+a'), r, DEFAULTS)).toEqual({ kind: 'free' });
    expect(checkChord(chord('ctrl+a'), r, DEFAULTS).kind).toBe('free');
  });
});

describe('checkChord', () => {
  it('reports a chord already on the row', () => {
    expect(checkChord(chord('ctrl+shift+p'), row(DEFAULTS, 'openPalette'), DEFAULTS)).toEqual({ kind: 'same' });
    expect(checkChord(chord('ctrl+shift+d'), row(CUSTOM, 'splitAuto'), CUSTOM)).toEqual({ kind: 'same' });
  });

  it('notes a free shell key', () => {
    expect(checkChord(chord('ctrl+k'), row(DEFAULTS, 'openPalette'), DEFAULTS)).toEqual({
      kind: 'free',
      shellNote: "Ctrl+K no longer reaches bash's cut to end of line",
    });
  });

  it('gives no note for the row reclaiming its own default', () => {
    const live = applyOps(DEFAULTS, removeOps('ctrl+right'));
    expect(checkChord(chord('ctrl+right'), row(live, 'splitRight'), live)).toEqual({ kind: 'free' });
  });

  it('detects conflicts with and without leavesEmpty', () => {
    const toggle = checkChord(chord('ctrl+shift+d'), row(DEFAULTS, 'splitAuto'), DEFAULTS);
    expect(toggle).toMatchObject({ kind: 'conflict', leavesEmpty: true, owner: { id: 'toggleBackdrop' } });
    const copy = checkChord(chord('ctrl+c'), row(DEFAULTS, 'find'), DEFAULTS);
    expect(copy).toMatchObject({ kind: 'conflict', leavesEmpty: false, owner: { id: 'copy' } });
  });

  it('finds owners by key', () => {
    expect(ownerOf(chord('alt+left'), DEFAULTS)?.id).toBe('moveFocus:left');
    expect(ownerOf(chord('ctrl+shift+d'), CUSTOM)?.id).toBe('splitAuto');
    expect(ownerOf(chord('ctrl+alt+j'), DEFAULTS)).toBeNull();
  });
});

describe('shell notes', () => {
  it('names the shell use', () => {
    expect(shellNoteFor('ctrl+r')).toBe("Ctrl+R no longer reaches bash's reverse search");
    expect(shellNoteFor('ctrl+alt+r')).toBeUndefined();
    expect(checkChord(chord('ctrl+r'), row(DEFAULTS, 'find'), DEFAULTS)).toEqual({
      kind: 'free',
      shellNote: "Ctrl+R no longer reaches bash's reverse search",
    });
  });

  it('shows a note on a row the user gave a shell key', () => {
    expect(row(CUSTOM, 'openGit').shellNotes).toEqual(["Ctrl+R no longer reaches bash's reverse search"]);
  });

  it('shows no note for a default shell key, but does once it moves', () => {
    expect(row(DEFAULTS, 'splitRight').shellNotes).toEqual([]);
    expect(row(DEFAULTS, 'closePane').shellNotes).toEqual([]);
    const moved = applyOps(DEFAULTS, addOps(row(DEFAULTS, 'splitDown'), chord('ctrl+right')));
    expect(row(moved, 'splitDown').shellNotes).toEqual(["Ctrl+Right no longer reaches bash's word forward"]);
    expect(row(moved, 'splitRight')).toMatchObject({ chords: [], shellNotes: [] });
  });
});

describe('ops', () => {
  it('moves a chord with one bind', () => {
    const ops = addOps(row(DEFAULTS, 'splitAuto'), chord('ctrl+shift+d'));
    expect(ops).toEqual([{ op: 'bind', keys: 'ctrl+shift+d', action: 'splitAuto' }]);
    const after = applyOps(DEFAULTS, ops);
    expect(row(after, 'splitAuto').chords).toEqual(['alt+shift+d', 'ctrl+shift+d']);
    expect(row(after, 'toggleBackdrop').chords).toEqual([]);
  });

  it('carries row arguments', () => {
    expect(addOps(row(DEFAULTS, 'moveFocus:up'), chord('ctrl+alt+up'))).toEqual([
      { op: 'bind', keys: 'ctrl+alt+up', action: 'moveFocus', direction: 'up' },
    ]);
    expect(addOps(row(DEFAULTS, 'switchToTab:2'), chord('alt+2'))[0]).toMatchObject({ index: 2 });
    expect(replaceOps(row(DEFAULTS, 'find'), 'ctrl+shift+f', chord('ctrl+alt+f'))).toEqual([
      { op: 'unbind', keys: 'ctrl+shift+f' },
      { op: 'bind', keys: 'ctrl+alt+f', action: 'find' },
    ]);
  });

  it('plans a reset that takes chords back', () => {
    const live = applyOps(DEFAULTS, [
      ...addOps(row(DEFAULTS, 'toggleBackdrop'), chord('alt+shift+d')),
      { op: 'bind', keys: 'ctrl+alt+s', action: 'splitAuto' },
    ]);
    const r = row(live, 'splitAuto');
    expect(r.modified).toBe(true);
    const plan = resetPlan(r, live);
    expect(plan.ops).toEqual([
      { op: 'reset', keys: 'ctrl+alt+s' },
      { op: 'reset', keys: 'alt+shift+d' },
    ]);
    expect(plan.takes.map((t) => [t.keys, t.owner.id])).toEqual([['alt+shift+d', 'toggleBackdrop']]);
    const after = applyOps(live, plan.ops);
    expect(row(after, 'splitAuto')).toMatchObject({ chords: ['alt+shift+d'], modified: false });
    expect(row(after, 'toggleBackdrop')).toMatchObject({ chords: ['ctrl+shift+d'], modified: false });
  });

  it('plans a reset whose default another row holds, and one with nothing to take', () => {
    const plan = resetPlan(row(CUSTOM, 'toggleBackdrop'), CUSTOM);
    expect(plan.ops).toEqual([{ op: 'reset', keys: 'Shift+Ctrl+D' }]);
    expect(plan.takes.map((t) => t.owner.id)).toEqual(['splitAuto']);
    expect(resetPlan(row(DEFAULTS, 'find'), DEFAULTS)).toEqual({ ops: [], takes: [] });
    const copy = resetPlan(row(CUSTOM, 'copy'), CUSTOM);
    expect(copy).toEqual({ ops: [{ op: 'reset', keys: 'ctrl+c' }], takes: [] });
  });

  it('resets all to the defaults', () => {
    expect(resetAllOps()).toEqual([{ op: 'resetAll' }]);
    expect(keymapOf(applyOps(CUSTOM, resetAllOps()))).toEqual(keymapOf(DEFAULTS));
  });
});

describe('inverseOps', () => {
  const cases: [string, (live: KeybindingEntry[]) => KeybindingOp[]][] = [
    ['add', (live) => addOps(row(live, 'openPalette'), chord('ctrl+alt+p'))],
    ['add a shell key', (live) => addOps(row(live, 'find'), chord('ctrl+r'))],
    ['replace', (live) => replaceOps(row(live, 'find'), 'ctrl+shift+f', chord('ctrl+alt+f'))],
    ['remove', (live) => removeOps(row(live, 'paste').chords[0])],
    ['move', (live) => addOps(row(live, 'nextTab'), chord('ctrl+shift+d'))],
    ['move by replace', (live) => replaceOps(row(live, 'newTab'), 'ctrl+shift+t', chord('ctrl+w'))],
    ['reset', (live) => resetPlan(row(live, 'splitAuto'), live).ops],
    ['reset a moved row', (live) => resetPlan(row(live, 'toggleBackdrop'), live).ops],
    ['reset all', () => resetAllOps()],
  ];
  for (const [name, live] of [['defaults', DEFAULTS], ['custom', CUSTOM]] as const) {
    for (const [op, make] of cases) {
      it(`restores ${op} from ${name}`, () => {
        const ops = make(live);
        const after = applyOps(live, ops);
        expect(keymapOf(applyOps(after, inverseOps(ops, live)))).toEqual(keymapOf(live));
      });
    }
  }

  it('undoes reset all by writing back the previous raw array', () => {
    const previous = [{ keys: 5 }, { keys: 'ctrl+alt+k', action: 'openPalette' }];
    expect(inverseOps(resetAllOps(), CUSTOM, previous)).toEqual([{ op: 'replaceAll', entries: previous }]);
    expect(inverseOps([{ op: 'unbind', keys: 'ctrl+w' }], DEFAULTS, previous)).toEqual([{ op: 'reset', keys: 'ctrl+w' }]);
  });

  it('models replaceAll as the loader merging the raw array over the defaults', () => {
    const live = applyOps(DEFAULTS, [
      {
        op: 'replaceAll',
        entries: [{ keys: 5 }, { action: 'find' }, { keys: 'ctrl+alt+k', action: 'openPalette' }, { keys: 'ctrl+c', action: 'unbound' }],
      },
    ]);
    expect(ownerOf(chord('ctrl+alt+k'), live)?.id).toBe('openPalette');
    expect(ownerOf(chord('ctrl+c'), live)).toBeNull();
    expect(ownerOf(chord('ctrl+w'), live)?.id).toBe('closePane');
  });

  it('writes the restoring op per chord state', () => {
    const ops: KeybindingOp[] = [
      { op: 'reset', keys: 'ctrl+w' },
      { op: 'reset', keys: 'shift+ctrl+d' },
      { op: 'reset', keys: 'ctrl+c' },
      { op: 'reset', keys: 'ctrl+alt+j' },
    ];
    expect(inverseOps(ops, CUSTOM)).toEqual([
      { op: 'reset', keys: 'ctrl+w' },
      { op: 'bind', keys: 'Shift+Ctrl+D', action: 'splitAuto' },
      { op: 'unbind', keys: 'ctrl+c' },
      { op: 'reset', keys: 'ctrl+alt+j' },
    ]);
  });
});

describe('text', () => {
  const owner = row(DEFAULTS, 'toggleBackdrop');
  it('builds the strip and notice text', () => {
    expect(moveStripText('ctrl+shift+d', owner, true)).toBe(
      'Ctrl+Shift+D runs "Pause or resume the background animation". Move it here? It will have no key.',
    );
    expect(moveStripText('ctrl+shift+d', owner, false)).toBe(
      'Ctrl+Shift+D runs "Pause or resume the background animation". Move it here?',
    );
    const split = row(DEFAULTS, 'splitAuto');
    expect(resetStripText([{ keys: 'ctrl+shift+d', owner: split }])).toBe(
      'Ctrl+Shift+D runs Split along the longer side. Move it back?',
    );
    expect(resetStripText([{ keys: 'ctrl+shift+d', owner: split }, { keys: 'ctrl+w', owner }])).toBe(
      'Ctrl+Shift+D runs Split along the longer side. Ctrl+W runs Pause or resume the background animation. Move them back?',
    );
    expect(movedNoticeText('ctrl+shift+d', owner)).toBe('Ctrl+Shift+D moved from Pause or resume the background animation');
  });
});
