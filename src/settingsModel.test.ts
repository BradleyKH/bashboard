import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { appliesNote, installedChoices, isShown, parseInput, readField, SETTINGS_SECTIONS, type SettingsField } from './settingsModel';

const fields = SETTINGS_SECTIONS.flatMap((s) => s.fields);
const byPath = (p: string) => fields.find((f) => f.path.join('.') === p) as SettingsField;

function leaves(value: unknown, prefix: string[] = []): string[] {
  if (Array.isArray(value) || typeof value !== 'object' || value === null) return [prefix.join('.')];
  return Object.entries(value).flatMap(([k, v]) => leaves(v, [...prefix, k]));
}

describe('SETTINGS_SECTIONS', () => {
  it('resolves every field to a defined default', () => {
    for (const f of fields) expect(readField(DEFAULT_SETTINGS, f.path), f.path.join('.')).toBeDefined();
  });

  it('covers every non-keybinding leaf exactly once', () => {
    const { keybindings: _keybindings, ...rest } = DEFAULT_SETTINGS;
    expect(fields.map((f) => f.path.join('.')).sort()).toEqual(leaves(rest).sort());
  });

  it('accepts every default value', () => {
    for (const f of fields) {
      const d = readField(DEFAULT_SETTINGS, f.path);
      const raw = f.kind === 'toggle' ? (d as boolean) : f.kind === 'list' ? (d as string[]).join('\n') : String(d);
      expect(parseInput(f, raw), f.path.join('.')).toEqual({ ok: true, value: d });
    }
  });
});

describe('isShown', () => {
  const withAnimate = (animate: boolean) => (path: string[]) =>
    readField({ ...DEFAULT_SETTINGS, backdrop: { ...DEFAULT_SETTINGS.backdrop, animate } }, path);

  it('hides the loop-only backdrop fields while the backdrop is frozen', () => {
    const hidden = fields.filter((f) => !isShown(f, withAnimate(false))).map((f) => f.path.join('.'));
    expect(hidden.sort()).toEqual(
      ['maxFps', 'speed', 'capacity', 'mutationRate', 'lineageThreads', 'orbit', 'waitingPulse'].map((k) => `backdrop.${k}`).sort(),
    );
  });

  it('shows every field while the backdrop animates', () => {
    for (const f of fields) expect(isShown(f, withAnimate(true)), f.path.join('.')).toBe(true);
  });

  it('points every condition at a field the dialog has', () => {
    for (const f of fields) if (f.shownWhen) expect(byPath(f.shownWhen.path.join('.')), f.path.join('.')).toBeDefined();
  });
});

describe('parseInput', () => {
  it('checks number ranges and rejects NaN', () => {
    const size = byPath('font.size');
    expect(parseInput(size, '14')).toEqual({ ok: true, value: 14 });
    expect(parseInput(size, '5').ok).toBe(false);
    expect(parseInput(size, '49').ok).toBe(false);
    expect(parseInput(size, 'abc').ok).toBe(false);
    expect(parseInput(size, '').ok).toBe(false);
  });

  it('rejects fractions for integer fields only', () => {
    expect(parseInput(byPath('scrollback'), '10.5').ok).toBe(false);
    expect(parseInput(byPath('scrollback'), '-1').ok).toBe(false);
    expect(parseInput(byPath('scrollback'), '1000001').ok).toBe(false);
    expect(parseInput(byPath('font.size'), '12.5')).toEqual({ ok: true, value: 12.5 });
  });

  it('accepts maxFps 0 or 20 to 240 only', () => {
    const fps = byPath('backdrop.maxFps');
    expect(parseInput(fps, '0')).toEqual({ ok: true, value: 0 });
    expect(parseInput(fps, '19').ok).toBe(false);
    expect(parseInput(fps, '20').ok).toBe(true);
    expect(parseInput(fps, '240').ok).toBe(true);
    expect(parseInput(fps, '241').ok).toBe(false);
  });

  it('bounds sliders', () => {
    expect(parseInput(byPath('scrim.opacity'), '1.5').ok).toBe(false);
    expect(parseInput(byPath('scrim.opacity'), '0.45')).toEqual({ ok: true, value: 0.45 });
    expect(parseInput(byPath('scrim.blurPx'), '21').ok).toBe(false);
  });

  it('parses lists one argument per line, dropping blanks', () => {
    expect(parseInput(byPath('shell.args'), '--login\r\n\n -i \n')).toEqual({ ok: true, value: ['--login', '-i'] });
    expect(parseInput(byPath('shell.args'), '')).toEqual({ ok: true, value: [] });
  });

  it('rejects empty text where the loader needs a value', () => {
    expect(parseInput(byPath('shell.path'), '  ').ok).toBe(false);
    expect(parseInput(byPath('shell.defaultProfile'), 'cmd')).toEqual({ ok: true, value: 'cmd' });
    expect(parseInput(byPath('shell.defaultProfile'), 'powershell')).toEqual({ ok: true, value: 'powershell' });
    expect(parseInput(byPath('shell.defaultProfile'), 'zsh').ok).toBe(false);
    expect(parseInput(byPath('shell.defaultProfile'), '').ok).toBe(false);
    expect(parseInput(byPath('font.family'), '').ok).toBe(false);
    expect(parseInput(byPath('shell.startingDirectory'), '')).toEqual({ ok: true, value: '' });
  });

  it('passes toggles through', () => {
    expect(parseInput(byPath('backdrop.animate'), false)).toEqual({ ok: true, value: false });
  });
});

describe('appliesNote', () => {
  it('describes when a change takes effect', () => {
    expect(appliesNote(byPath('font.size'))).toBe('');
    expect(appliesNote(byPath('restore.enabled'))).toBe('Applies at next launch');
    expect(appliesNote(byPath('shell.args'))).toBe('Applies to new panes');
  });
});

describe('installedChoices', () => {
  const options = byPath('shell.defaultProfile').options!;
  const installed = [
    { id: 'pwsh', name: 'PowerShell 7' },
    { id: 'cmd', name: 'Command Prompt' },
  ];

  it('lists only installed shells', () => {
    expect(installedChoices(options, installed, 'cmd')).toEqual({
      options: [
        { value: 'pwsh', label: 'PowerShell 7' },
        { value: 'cmd', label: 'Command Prompt' },
      ],
    });
  });

  it('keeps an uninstalled saved value selectable and names the shell new panes use', () => {
    const r = installedChoices(options, installed, 'gitBash');
    expect(r.options[0]).toEqual({ value: 'gitBash', label: 'Git Bash (not installed)' });
    expect(r.options).toHaveLength(3);
    expect(r.note).toBe('Git Bash is not installed; new panes use PowerShell 7');
  });
});

describe('installedChoices for editors', () => {
  const field = byPath('editor.preferred');
  const found = [{ id: 'default', name: "The file's default app" }, { id: 'vscode', name: 'VS Code' }];

  it('lists only detected editors', () => {
    expect(installedChoices(field.options!, found, 'vscode', 'editors').options.map((o) => o.value)).toEqual(['vscode', 'default']);
  });

  it('keeps a missing saved editor selectable and says files open in the default app', () => {
    const r = installedChoices(field.options!, found, 'zed', 'editors');
    expect(r.options[0]).toEqual({ value: 'zed', label: 'Zed (not found)' });
    expect(r.note).toBe('Zed was not found; files open in the default app');
  });

  it('validates the editor fields', () => {
    expect(parseInput(field, 'notepadpp')).toEqual({ ok: true, value: 'notepadpp' });
    expect(parseInput(field, 'emacs').ok).toBe(false);
    expect(parseInput(byPath('editor.command'), '')).toEqual({ ok: true, value: '' });
    expect(parseInput(byPath('editor.command'), ' code -g {path}:{line} ')).toEqual({ ok: true, value: 'code -g {path}:{line}' });
  });
});
