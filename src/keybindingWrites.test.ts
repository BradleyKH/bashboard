import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOps, ownerOf } from './keybindingEdit';
import type { NoticeActions } from './keybindingNotice';
import { KeybindingWrites, type KeybindingWritesHost } from './keybindingWrites';
import { DEFAULT_KEYBINDINGS, parseChord, type KeybindingEntry } from './keymap';
import type { KeybindingOp } from './settings';

interface Harness {
  writes: KeybindingWrites;
  host: KeybindingWritesHost;
  live: { entries: KeybindingEntry[] };
  sent: KeybindingOp[][];
  /** The settings file's raw keybindings array, modeling settings_keybindings_edit. */
  raw: { entries: unknown[] };
  shown: { text: string; actions: NoticeActions }[];
  errors: string[];
  renders: { count: number };
}

function harness(onEdit?: (ops: KeybindingOp[]) => Promise<unknown[]>): Harness {
  const live = { entries: [...DEFAULT_KEYBINDINGS] };
  const raw = { entries: [] as unknown[] };
  const sent: KeybindingOp[][] = [];
  const shown: { text: string; actions: NoticeActions }[] = [];
  const errors: string[] = [];
  const renders = { count: 0 };
  const host: KeybindingWritesHost = {
    onEdit:
      onEdit ??
      (async (ops) => {
        sent.push(ops);
        const previous = raw.entries;
        for (const op of ops) {
          if (op.op === 'resetAll') raw.entries = [];
          else if (op.op === 'replaceAll') raw.entries = op.entries;
        }
        live.entries = applyOps(live.entries, ops);
        return previous;
      }),
    entries: () => live.entries,
    notice: () => ({
      show: (text, actions) => shown.push({ text, actions }),
      showError: (text) => errors.push(text),
      clear: () => {},
    }),
    isOpen: () => true,
    assign: () => {},
    render: () => renders.count++,
  };
  return { writes: new KeybindingWrites(host), host, live, sent, raw, shown, errors, renders };
}

describe('KeybindingWrites', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the notice with an Undo that restores the prior keymap', async () => {
    const h = harness();
    const before = h.live.entries;
    await h.writes.send([{ op: 'unbind', keys: 'alt+left' }], { notice: 'Removed' });
    expect(ownerOf(parseChord('alt+left')!, h.live.entries)).toBeNull();
    expect(h.shown).toHaveLength(1);
    h.shown[0].actions.onUndo!();
    await vi.runAllTimersAsync();
    expect(ownerOf(parseChord('alt+left')!, h.live.entries)?.id).toBe(ownerOf(parseChord('alt+left')!, before)?.id);
  });

  it('undoes Reset all by writing back the raw array, rejected entries included', async () => {
    const h = harness();
    const rejected = { keys: 5 };
    const custom = { keys: 'ctrl+alt+k', action: 'openPalette' };
    h.raw.entries = [rejected, custom, { keys: 'ctrl+c', action: 'unbound' }];
    h.live.entries = applyOps(DEFAULT_KEYBINDINGS, [{ op: 'replaceAll', entries: h.raw.entries }]);
    const before = h.live.entries;
    const original = h.raw.entries;
    await h.writes.send([{ op: 'resetAll' }], { notice: 'Every key uses its default' });
    expect(h.raw.entries).toEqual([]);
    h.shown[0].actions.onUndo!();
    await vi.runAllTimersAsync();
    expect(h.sent[1]).toEqual([{ op: 'replaceAll', entries: original }]);
    expect(h.raw.entries).toEqual([rejected, custom, { keys: 'ctrl+c', action: 'unbound' }]);
    expect(ownerOf(parseChord('ctrl+alt+k')!, h.live.entries)?.id).toBe(ownerOf(parseChord('ctrl+alt+k')!, before)?.id);
    expect(ownerOf(parseChord('ctrl+c')!, h.live.entries)).toBeNull();
  });

  it('ignores a send while another is in flight', async () => {
    let release!: () => void;
    const h = harness(() => new Promise<unknown[]>((r) => (release = () => r([]))));
    const first = h.writes.send([{ op: 'unbind', keys: 'alt+left' }]);
    expect(h.writes.busy).toBe(true);
    await h.writes.send([{ op: 'unbind', keys: 'alt+right' }]);
    release();
    await first;
    expect(h.writes.busy).toBe(false);
  });

  it('reports a failed write and drops the pending flash', async () => {
    const h = harness(() => Promise.reject(new Error('disk full')));
    const taken = [{ ownerId: 'moveFocus:left', chord: parseChord('alt+left')!, keys: 'alt+left' }];
    await h.writes.send([{ op: 'unbind', keys: 'alt+left' }], { taken, notice: 'x' });
    expect(h.errors).toEqual(['Could not save: disk full']);
    expect(h.shown).toHaveLength(0);
    h.live.entries = h.live.entries.filter((e) => e.keys !== 'alt+left');
    h.writes.consumePending();
    expect(h.writes.flashOf('moveFocus:left')).toBeUndefined();
  });

  it('flashes a taken chord once the live entries show it gone, then clears', async () => {
    const h = harness();
    const taken = [{ ownerId: 'moveFocus:left', chord: parseChord('alt+left')!, keys: 'alt+left' }];
    h.writes.consumePending();
    expect(h.writes.flashOf('moveFocus:left')).toBeUndefined();
    await h.writes.send([{ op: 'bind', keys: 'alt+left', action: 'splitAuto' }], { taken, notice: 'Moved' });
    h.writes.consumePending();
    expect(h.writes.flashOf('moveFocus:left')).toEqual(['alt+left']);
    vi.advanceTimersByTime(1000);
    expect(h.writes.flashOf('moveFocus:left')).toBeUndefined();
    expect(h.renders.count).toBe(1);
  });

  it('dispose cancels flashes and scheduled work', () => {
    const h = harness();
    const ran = vi.fn();
    h.writes.flash('splitAuto', []);
    h.writes.later(ran, 0);
    h.writes.dispose();
    vi.runAllTimers();
    expect(ran).not.toHaveBeenCalled();
    expect(h.writes.flashOf('splitAuto')).toBeUndefined();
    expect(h.renders.count).toBe(0);
  });
});
