import { describe, expect, it } from 'vitest';
import {
  buildKeymap,
  chordFromEvent,
  DEFAULT_KEYBINDINGS,
  lookup,
  parseChord,
  type KeybindingEntry,
} from './keymap';

function ev(init: Partial<Record<'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', string | boolean>>) {
  return { key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init } as unknown as KeyboardEvent;
}

describe('parseChord', () => {
  it('parses modifiers case-insensitively in any order', () => {
    expect(parseChord('Shift+Ctrl+V')).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 'v' });
    expect(parseChord('ALT+Left')).toEqual({ ctrl: false, alt: true, shift: false, meta: false, key: 'left' });
  });
  it('accepts win and meta', () => {
    expect(parseChord('win+e')?.meta).toBe(true);
    expect(parseChord('meta+e')?.meta).toBe(true);
  });
  it('parses named keys, function keys, digits, and punctuation', () => {
    expect(parseChord('ctrl+f24')?.key).toBe('f24');
    expect(parseChord('pagedown')?.key).toBe('pagedown');
    expect(parseChord('ctrl+1')?.key).toBe('1');
    expect(parseChord('ctrl+,')?.key).toBe(',');
    expect(parseChord('ctrl++')?.key).toBe('+');
  });
  it('returns null for bad input', () => {
    for (const s of ['', 'ctrl+', 'ctrl+bogus', 'ctrl+ctrl+a', 'foo+a', 'a+b', 'ctrl+f25']) {
      expect(parseChord(s), s).toBeNull();
    }
  });
});

describe('chordFromEvent', () => {
  it('takes letters from key, ignoring shift', () => {
    const c = chordFromEvent(ev({ key: 'D', code: 'KeyD', altKey: true, shiftKey: true }));
    expect(c).toEqual({ ctrl: false, alt: true, shift: true, meta: false, key: 'd' });
  });
  it('follows the active layout on Dvorak', () => {
    // Dvorak types "," on the physical W key and "t" on the physical K key.
    expect(chordFromEvent(ev({ key: ',', code: 'KeyW', ctrlKey: true })).key).toBe(',');
    expect(chordFromEvent(ev({ key: 'T', code: 'KeyK', ctrlKey: true, shiftKey: true })).key).toBe('t');
  });
  it('falls back to code for letters on non-Latin layouts', () => {
    expect(chordFromEvent(ev({ key: 'ц', code: 'KeyW', ctrlKey: true })).key).toBe('w');
  });
  it('takes digits from code', () => {
    expect(chordFromEvent(ev({ key: '!', code: 'Digit1', shiftKey: true })).key).toBe('1');
  });
  it('maps named keys from key', () => {
    expect(chordFromEvent(ev({ key: 'ArrowLeft', code: 'ArrowLeft' })).key).toBe('left');
    expect(chordFromEvent(ev({ key: 'Enter', code: 'Enter' })).key).toBe('enter');
    expect(chordFromEvent(ev({ key: ' ', code: 'Space' })).key).toBe('space');
    expect(chordFromEvent(ev({ key: 'F5', code: 'F5' })).key).toBe('f5');
  });
  it('yields an empty key for bare modifiers', () => {
    expect(chordFromEvent(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true })).key).toBe('');
  });
});

describe('default keybindings', () => {
  const { keymap, warnings } = buildKeymap(DEFAULT_KEYBINDINGS);

  it('build without warnings', () => {
    expect(warnings).toEqual([]);
  });

  it('every default resolves to its action', () => {
    const codes: Record<string, [string, string]> = {
      right: ['ArrowRight', 'ArrowRight'],
      left: ['ArrowLeft', 'ArrowLeft'],
      up: ['ArrowUp', 'ArrowUp'],
      down: ['ArrowDown', 'ArrowDown'],
      enter: ['Enter', 'Enter'],
      f1: ['F1', 'F1'],
      f11: ['F11', 'F11'],
      ',': [',', 'Comma'],
      '=': ['=', 'Equal'],
      '+': ['+', 'NumpadAdd'],
      '-': ['-', 'Minus'],
      tab: ['Tab', 'Tab'],
    };
    for (const entry of DEFAULT_KEYBINDINGS) {
      const chord = parseChord(entry.keys)!;
      const fallback = /^[0-9]$/.test(chord.key) ? `Digit${chord.key}` : `Key${chord.key.toUpperCase()}`;
      const [key, code] = codes[chord.key] ?? [chord.key, fallback];
      const e = ev({ key, code, ctrlKey: chord.ctrl, altKey: chord.alt, shiftKey: chord.shift, metaKey: chord.meta });
      const action = lookup(keymap, e);
      expect(action, entry.keys).not.toBeNull();
      expect(action!.type).toBe(entry.action);
      if (entry.direction) expect(action).toMatchObject({ direction: entry.direction });
      if (entry.input) expect(action).toMatchObject({ input: entry.input });
      if (entry.index) expect(action).toMatchObject({ index: entry.index });
    }
  });

  it('maps collapsePane and openFavorite to their chords', () => {
    expect(lookup(keymap, ev({ key: 'M', code: 'KeyM', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'collapsePane',
    });
    expect(lookup(keymap, ev({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'openFavorite',
    });
  });

  it('maps openLayout and splitWithProfile to their chords', () => {
    expect(lookup(keymap, ev({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'openLayout',
    });
    expect(lookup(keymap, ev({ key: 'T', code: 'KeyT', altKey: true, shiftKey: true }))).toEqual({
      type: 'splitWithProfile',
    });
  });

  it('maps newScratch to its chord', () => {
    expect(lookup(keymap, ev({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'newScratch',
    });
  });

  it('maps openFiles to its chord', () => {
    expect(lookup(keymap, ev({ key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'openFiles',
    });
  });

  it('maps togglePaneZoom to its chord', () => {
    expect(lookup(keymap, ev({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'togglePaneZoom',
    });
  });

  it('maps openGit to its chord', () => {
    expect(lookup(keymap, ev({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'openGit',
    });
  });

  it('maps openSearch to its chord', () => {
    expect(lookup(keymap, ev({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }))).toEqual({
      type: 'openSearch',
    });
  });

  it('maps the tab chords', () => {
    expect(lookup(keymap, ev({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }))).toEqual({ type: 'newTab' });
    expect(lookup(keymap, ev({ key: 'W', code: 'KeyW', ctrlKey: true, shiftKey: true }))).toEqual({ type: 'closeTab' });
    expect(lookup(keymap, ev({ key: 'Tab', code: 'Tab', ctrlKey: true }))).toEqual({ type: 'nextTab' });
    expect(lookup(keymap, ev({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }))).toEqual({ type: 'prevTab' });
    expect(lookup(keymap, ev({ key: '5', code: 'Digit5', ctrlKey: true, altKey: true }))).toEqual({
      type: 'switchToTab',
      index: 5,
    });
    expect(lookup(keymap, ev({ key: '9', code: 'Digit9', ctrlKey: true, altKey: true }))).toEqual({
      type: 'switchToLastTab',
    });
  });

  it('maps the font size keys from the real key events', () => {
    const chord = (init: Partial<KeyboardEvent>) => chordFromEvent(ev(init));
    expect(chord({ key: '=', code: 'Equal', ctrlKey: true })).toMatchObject({ ctrl: true, shift: false, key: '=' });
    expect(chord({ key: '+', code: 'NumpadAdd', ctrlKey: true })).toMatchObject({ ctrl: true, shift: false, key: '+' });
    expect(chord({ key: '-', code: 'Minus', ctrlKey: true })).toMatchObject({ ctrl: true, key: '-' });
    expect(chord({ key: '-', code: 'NumpadSubtract', ctrlKey: true })).toMatchObject({ ctrl: true, key: '-' });
    expect(chord({ key: '0', code: 'Digit0', ctrlKey: true })).toMatchObject({ ctrl: true, key: '0' });
    const increase = { type: 'increaseFontSize' };
    expect(lookup(keymap, ev({ key: '=', code: 'Equal', ctrlKey: true }))).toEqual(increase);
    expect(lookup(keymap, ev({ key: '+', code: 'NumpadAdd', ctrlKey: true }))).toEqual(increase);
    expect(lookup(keymap, ev({ key: '-', code: 'Minus', ctrlKey: true }))).toEqual({ type: 'decreaseFontSize' });
    expect(lookup(keymap, ev({ key: '-', code: 'NumpadSubtract', ctrlKey: true }))).toEqual({
      type: 'decreaseFontSize',
    });
    expect(lookup(keymap, ev({ key: '0', code: 'Digit0', ctrlKey: true }))).toEqual({ type: 'resetFontSize' });
  });

  it('maps Ctrl+Comma to openSettings', () => {
    expect(lookup(keymap, ev({ key: ',', code: 'Comma', ctrlKey: true }))).toEqual({
      type: 'openSettings',
    });
  });

  it('shift+enter sends ESC CR', () => {
    expect(lookup(keymap, ev({ key: 'Enter', code: 'Enter', shiftKey: true }))).toEqual({
      type: 'sendInput',
      input: '\u001b\r',
    });
  });
});

describe('lookup', () => {
  const { keymap } = buildKeymap(DEFAULT_KEYBINDINGS);

  it('matches modifiers exactly', () => {
    expect(lookup(keymap, ev({ key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(lookup(keymap, ev({ key: 'Enter', code: 'Enter' }))).toBeNull();
    expect(lookup(keymap, ev({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }))).toBeNull();
  });
  it('returns null for unbound keys and bare modifiers', () => {
    expect(lookup(keymap, ev({ key: 'x', code: 'KeyX' }))).toBeNull();
    expect(lookup(keymap, ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeNull();
  });
});

describe('switchToTab entries', () => {
  const press = ev({ key: '1', code: 'Digit1', altKey: true });

  it('accepts a whole index from 1 to 8', () => {
    const { keymap, warnings } = buildKeymap([{ keys: 'alt+1', action: 'switchToTab', index: 8 }]);
    expect(warnings).toEqual([]);
    expect(lookup(keymap, press)).toEqual({ type: 'switchToTab', index: 8 });
  });

  it.each([undefined, 0, 9, 1.5, '2'])('rejects index %s', (index) => {
    const { keymap, warnings } = buildKeymap([
      { keys: 'alt+1', action: 'switchToTab', index } as unknown as KeybindingEntry,
    ]);
    expect(keymap.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('index');
  });
});

describe('buildKeymap', () => {
  it('skips invalid entries with indexed warnings', () => {
    const entries = [
      { keys: 'ctrl+bogus', action: 'find' },
      { keys: 'ctrl+j', action: 'nope' },
      { keys: 'ctrl+k', action: 'moveFocus' },
      { keys: 'ctrl+l', action: 'resizePane', direction: 'sideways' },
      { keys: 'ctrl+m', action: 'sendInput' },
      { keys: 'ctrl+n', action: 'unbound' },
      { keys: 'ctrl+o', action: 'find' },
    ] as unknown as KeybindingEntry[];
    const { keymap, warnings } = buildKeymap(entries);
    expect(keymap.size).toBe(1);
    expect(warnings).toHaveLength(6);
    expect(warnings[0]).toContain('keybindings[0]');
    expect(warnings[1]).toContain('keybindings[1]');
    expect(warnings[2]).toContain('direction');
    expect(warnings[3]).toContain('direction');
    expect(warnings[4]).toContain('input');
    // "unbound" is Rust-only; if it leaks through it is skipped as an unknown action.
    expect(warnings[5]).toContain('unknown action "unbound"');
    expect(lookup(keymap, ev({ key: 'o', code: 'KeyO', ctrlKey: true }))).toEqual({ type: 'find' });
  });

  it('lets later entries win on duplicate chords, ignoring spelling', () => {
    const { keymap } = buildKeymap([
      { keys: 'ctrl+right', action: 'splitRight' },
      { keys: 'Ctrl+Right', action: 'splitAuto' },
    ]);
    expect(keymap.size).toBe(1);
    expect(lookup(keymap, ev({ key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true }))).toEqual({
      type: 'splitAuto',
    });
  });
});
