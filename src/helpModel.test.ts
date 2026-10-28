import { describe, expect, it } from 'vitest';
import { formatChord, helpSections } from './helpModel';
import { DEFAULT_KEYBINDINGS, parseChord, type KeybindingEntry } from './keymap';

function row(entries: KeybindingEntry[], label: string) {
  return helpSections(entries)
    .flatMap((s) => s.rows)
    .find((r) => r.label === label);
}

describe('formatChord', () => {
  it('orders modifiers and capitalizes keys', () => {
    expect(formatChord(parseChord('shift+ctrl+f')!)).toBe('Ctrl+Shift+F');
    expect(formatChord(parseChord('alt+pagedown')!)).toBe('Alt+PageDown');
    expect(formatChord(parseChord('f1')!)).toBe('F1');
    expect(formatChord(parseChord('win+right')!)).toBe('Win+Right');
  });
});

describe('helpSections', () => {
  it('lists every default action', () => {
    const labels = helpSections(DEFAULT_KEYBINDINGS).flatMap((s) => s.rows.map((r) => r.label));
    for (const label of ['Split right', 'Close pane', 'Paste', 'New line in Claude Code', 'Pause or resume the background animation', 'Keyboard shortcuts', 'Settings', 'Toggle full screen', 'Open a saved layout', 'Split with a chosen shell', 'New tab', 'New scratch pad', 'Close tab', 'Next tab', 'Previous tab', 'Go to tab 1 to 8', 'Go to the last tab', 'Increase font size', 'Decrease font size', 'Reset font size']) {
      expect(labels).toContain(label);
    }
  });

  it('puts tab actions in a Tabs section and font size in Terminal', () => {
    const sections = helpSections(DEFAULT_KEYBINDINGS);
    const labels = (title: string) => sections.find((s) => s.title === title)?.rows.map((r) => r.label);
    expect(labels('Tabs')).toContain('New tab');
    expect(labels('Terminal')).toContain('Increase font size');
  });

  it('lists the open files chord', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Open files for the repo')?.keys).toEqual(['Ctrl+Shift+E']);
  });

  it('lists the git chord', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Git pane for this repo')?.keys).toEqual(['Ctrl+Shift+G']);
  });

  it('lists the search chord', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Search the repo\'s code')?.keys).toEqual(['Ctrl+Shift+H']);
  });

  it('lists the zoom chord', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Zoom or unzoom pane')?.keys).toEqual(['Ctrl+Shift+Z']);
  });

  it('shows the new scratch pad chord', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'New scratch pad')?.keys).toEqual(['Ctrl+Shift+N']);
  });

  it('collapses the tab number keys', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Go to tab 1 to 8')?.keys).toEqual(['Ctrl+Alt+1-8']);
    expect(row(DEFAULT_KEYBINDINGS, 'Increase font size')?.keys).toEqual(['Ctrl+=', 'Ctrl++']);
  });

  it('collapses four arrows with shared modifiers', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Move focus')?.keys).toEqual(['Alt+Arrows']);
    expect(row(DEFAULT_KEYBINDINGS, 'Resize pane')?.keys).toEqual(['Alt+Shift+Arrows']);
  });

  it('lists directions one by one when the arrows differ', () => {
    const entries: KeybindingEntry[] = [
      { keys: 'alt+h', action: 'moveFocus', direction: 'left' },
      { keys: 'alt+right', action: 'moveFocus', direction: 'right' },
    ];
    expect(row(entries, 'Move focus')?.keys).toEqual(['Alt+H (left)', 'Alt+Right (right)']);
  });

  it('keeps extra directional bindings next to the collapsed arrows', () => {
    const entries = [...DEFAULT_KEYBINDINGS, { keys: 'alt+h', action: 'moveFocus', direction: 'left' as const }];
    expect(row(entries, 'Move focus')?.keys).toEqual(['Alt+Arrows', 'Alt+H (left)']);
  });

  it('shows every chord bound to an action', () => {
    expect(row(DEFAULT_KEYBINDINGS, 'Copy selection')?.keys).toEqual(['Ctrl+C', 'Ctrl+Shift+C']);
  });

  it('reflects user overrides and drops unbound actions', () => {
    const entries = DEFAULT_KEYBINDINGS.filter((e) => e.action !== 'closePane');
    entries.push({ keys: 'ctrl+k', action: 'sendInput', input: 'ls\r' });
    expect(row(entries, 'Close pane')).toBeUndefined();
    expect(row(entries, 'Type "ls\\r"')?.keys).toEqual(['Ctrl+K']);
  });

  it('skips entries whose keys do not parse', () => {
    expect(row([{ keys: 'ctrl+', action: 'find' }], 'Find in scrollback or file preview')).toBeUndefined();
  });
});
