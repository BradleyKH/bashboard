import { describe, expect, it } from 'vitest';
import { DEFAULT_ELEMENT_ORDER } from './dashboardSections';
import { DEFAULT_SETTINGS } from './settings';
import { appliesNote, installedChoices, isShown, parseInput, readField, selectChoices, SETTINGS_SECTIONS, sliderPosition, type SettingsField } from './settingsModel';

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

describe('Dashboard section', () => {
  it('accepts left and right for the side and rejects anything else', () => {
    const side = byPath('dashboard.side');
    expect(parseInput(side, 'left')).toEqual({ ok: true, value: 'left' });
    expect(parseInput(side, 'right')).toEqual({ ok: true, value: 'right' });
    expect(parseInput(side, 'top').ok).toBe(false);
  });

  it('has one grouped toggle per element, in element order, then the clock style', () => {
    const grouped = fields.filter((f) => f.group === 'Show on the dashboard');
    expect(grouped.map((f) => f.path.join('.'))).toEqual([
      ...DEFAULT_ELEMENT_ORDER.map((id) => `dashboard.sections.${id}`),
      'dashboard.clockStyle',
    ]);
    for (const f of grouped.slice(0, -1)) expect(f.kind).toBe('toggle');
  });

  it('accepts the three clock styles and rejects anything else', () => {
    const style = byPath('dashboard.clockStyle');
    for (const v of ['both', 'time', 'binary']) expect(parseInput(style, v)).toEqual({ ok: true, value: v });
    expect(parseInput(style, 'analog').ok).toBe(false);
  });
});

describe('isShown', () => {
  const withAnimate = (animate: boolean, clock = false) => (path: string[]) =>
    readField(
      {
        ...DEFAULT_SETTINGS,
        backdrop: { ...DEFAULT_SETTINGS.backdrop, animate },
        dashboard: { ...DEFAULT_SETTINGS.dashboard, sections: { ...DEFAULT_SETTINGS.dashboard.sections, clock } },
      },
      path,
    );

  it('hides the loop-only backdrop fields while the backdrop is frozen, and the clock style while the clock is off', () => {
    const hidden = fields.filter((f) => !isShown(f, withAnimate(false))).map((f) => f.path.join('.'));
    expect(hidden.sort()).toEqual(
      [...['maxFps', 'capacity', 'mutationRate', 'waitingPulse'].map((k) => `backdrop.${k}`), 'dashboard.clockStyle'].sort(),
    );
  });

  it('shows every field while the backdrop animates and the clock is on', () => {
    for (const f of fields) expect(isShown(f, withAnimate(true, true)), f.path.join('.')).toBe(true);
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

describe('sliderPosition', () => {
  it('runs the brightness slider opposite to the stored scrim opacity', () => {
    const brightness = byPath('scrim.opacity');
    expect(sliderPosition(brightness, 1)).toBe(0);
    expect(sliderPosition(brightness, 0)).toBe(1);
    expect(sliderPosition(brightness, 0.45)).toBe(0.55);
    expect(sliderPosition(brightness, sliderPosition(brightness, 0.35))).toBe(0.35);
  });

  it('leaves other sliders as stored', () => {
    expect(sliderPosition(byPath('scrim.blurPx'), 6)).toBe(6);
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

  it('offers the 18 editor ids in the documented order', () => {
    expect(field.options!.map((o) => o.value)).toEqual(['zed', 'vscode', 'cursor', 'visualStudio', 'notepadpp', 'sublime', 'rider', 'intellij', 'webstorm', 'pycharm', 'rustrover', 'goland', 'clion', 'phpstorm', 'windsurf', 'vscodeInsiders', 'vscodium', 'default']);
  });

  it('offers a detected JetBrains IDE and marks an undetected saved VSCodium as not found', () => {
    const detected = [{ id: 'rider', name: 'Rider' }, { id: 'default', name: "The file's default app" }];
    const r = installedChoices(field.options!, detected, 'vscodium', 'editors');
    expect(r.options.map((o) => o.value)).toEqual(['vscodium', 'rider', 'default']);
    expect(r.options[0]).toEqual({ value: 'vscodium', label: 'VSCodium (not found)' });
    expect(r.options[1]).toEqual({ value: 'rider', label: 'Rider' });
  });

  it('validates the editor fields', () => {
    expect(parseInput(field, 'notepadpp')).toEqual({ ok: true, value: 'notepadpp' });
    expect(parseInput(field, 'emacs').ok).toBe(false);
    expect(parseInput(byPath('editor.command'), '')).toEqual({ ok: true, value: '' });
    expect(parseInput(byPath('editor.command'), ' code -g {path}:{line} ')).toEqual({ ok: true, value: 'code -g {path}:{line}' });
  });
});

describe('font suggestions', () => {
  it('marks only the font family field as suggesting from the core', () => {
    const suggesting = SETTINGS_SECTIONS.flatMap((s) => s.fields).filter((f) => f.suggestFrom);
    expect(suggesting.map((f) => f.path.join('.'))).toEqual(['font.family']);
    expect(suggesting[0].suggestFrom).toBe('fonts');
  });
});

describe('selectChoices', () => {
  const options = [{ value: '#4fb3c8', label: 'Teal' }];

  it('returns the options when the saved value is one of them', () => {
    expect(selectChoices(options, '#4fb3c8')).toBe(options);
  });

  it('appends a hand-edited value as Custom', () => {
    expect(selectChoices(options, '#123456')).toEqual([...options, { value: '#123456', label: 'Custom (#123456)' }]);
  });
});
