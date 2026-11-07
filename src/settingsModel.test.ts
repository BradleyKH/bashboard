import { describe, expect, it } from 'vitest';
import { DEFAULT_ELEMENT_ORDER } from './dashboardSections';
import { DEFAULT_SETTINGS, type BackdropStyle, type Settings } from './settings';
import { appliesNote, installedChoices, isShown, matchesFilter, parseInput, readField, selectChoices, SETTINGS_SECTIONS, sliderPosition, type SettingsField } from './settingsModel';

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
    // Pins are edited from the Ship pane and bookmarks from the Local Browser pane, so neither
    // list has a Settings tab field.
    const listsWithoutFields = ['ship.pinnedRepos', 'localBrowser.bookmarks'];
    const expected = leaves(rest).filter((p) => !listsWithoutFields.includes(p));
    expect(fields.map((f) => f.path.join('.')).sort()).toEqual(expected.sort());
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
  const settingsWith = (animate: boolean, clock = false, style: BackdropStyle = 'lights') =>
    ({
      ...DEFAULT_SETTINGS,
      backdrop: { ...DEFAULT_SETTINGS.backdrop, animate, style },
      dashboard: { ...DEFAULT_SETTINGS.dashboard, sections: { ...DEFAULT_SETTINGS.dashboard.sections, clock } },
    }) as Settings;
  const reader = (s: Settings) => (path: string[]) => readField(s, path);
  const withAnimate = (animate: boolean, clock = false) => reader(settingsWith(animate, clock));
  const shownBackdrop = (style: BackdropStyle, animate: boolean) =>
    SETTINGS_SECTIONS.find((s) => s.title === 'Background')!
      .fields.filter((f) => isShown(f, reader(settingsWith(animate, true, style))))
      .map((f) => f.path.join('.'));

  it('hides the loop-only backdrop fields while the backdrop is frozen, and the clock style while the clock is off', () => {
    const hidden = fields.filter((f) => !isShown(f, withAnimate(false))).map((f) => f.path.join('.'));
    expect(hidden.sort()).toEqual(
      [
        ...['maxFps', 'capacity', 'mutationRate'].map((k) => `backdrop.${k}`),
        'backdrop.matrix.color',
        'backdrop.matrix.zoom',
        'backdrop.matrix.speed',
        'backdrop.matrix.density',
        ...['file', 'folder', 'fit', 'intervalSeconds', 'crossfadeSeconds', 'shuffle', 'includeSubfolders'].map((k) => `backdrop.image.${k}`),
        'dashboard.clockStyle',
      ].sort(),
    );
  });

  it('shows every Swirling Lights field while the backdrop animates and the clock is on, and none of the Matrix fields', () => {
    const hidden = fields.filter((f) => !isShown(f, withAnimate(true, true))).map((f) => f.path.join('.'));
    expect(hidden.sort()).toEqual(
      [
        'backdrop.matrix.color',
        'backdrop.matrix.density',
        'backdrop.matrix.speed',
        'backdrop.matrix.zoom',
        ...['file', 'folder', 'fit', 'intervalSeconds', 'crossfadeSeconds', 'shuffle', 'includeSubfolders'].map((k) => `backdrop.image.${k}`),
      ].sort(),
    );
  });

  it('points every condition at a field the dialog has', () => {
    for (const f of fields) {
      for (const c of f.shownWhen === undefined ? [] : [f.shownWhen].flat()) expect(byPath(c.path.join('.')), f.path.join('.')).toBeDefined();
    }
  });

  it('requires every condition of a list', () => {
    const field = { shownWhen: [{ path: ['a'], value: 1 }, { path: ['b'], value: 2 }] } as SettingsField;
    const read = (a: unknown, b: unknown) => (path: string[]) => ({ a, b })[path[0] as 'a' | 'b'];
    expect(isShown(field, read(1, 2))).toBe(true);
    expect(isShown(field, read(1, 3))).toBe(false);
    expect(isShown(field, read(0, 2))).toBe(false);
  });

  it('matches any of the values in oneOf, and no value in an empty list', () => {
    const field = { shownWhen: { path: ['a'], oneOf: ['x', 'y'] } } as SettingsField;
    expect(isShown(field, () => 'x')).toBe(true);
    expect(isShown(field, () => 'y')).toBe(true);
    expect(isShown(field, () => 'z')).toBe(false);
    expect(isShown({ shownWhen: { path: ['a'], oneOf: [] } } as unknown as SettingsField, () => 'x')).toBe(false);
  });

  it('shows no backdrop controls but the style choice for None', () => {
    expect(shownBackdrop('none', true)).toEqual(['backdrop.style']);
    expect(shownBackdrop('none', false)).toEqual(['backdrop.style']);
  });

  it('shows the Swirling Lights controls for lights, and trims the loop-only ones when frozen', () => {
    expect(shownBackdrop('lights', true)).toEqual([
      'backdrop.style', 'backdrop.animate', 'backdrop.maxFps', 'scrim.opacity', 'scrim.blurPx', 'backdrop.capacity',
      'backdrop.zoom', 'backdrop.mutationRate',
    ]);
    expect(shownBackdrop('lights', false)).toEqual(['backdrop.style', 'backdrop.animate', 'scrim.opacity', 'scrim.blurPx', 'backdrop.zoom']);
  });

  it('shows Galaxy the same controls as Swirling Lights, since it reads the same settings', () => {
    expect(shownBackdrop('galaxy', true)).toEqual(shownBackdrop('lights', true));
    expect(shownBackdrop('galaxy', false)).toEqual(shownBackdrop('lights', false));
  });

  it('shows the Matrix controls for matrix, hiding speed when frozen and never the lights density, drift, or pulse', () => {
    expect(shownBackdrop('matrix', true)).toEqual([
      'backdrop.style', 'backdrop.animate', 'scrim.opacity', 'scrim.blurPx', 'backdrop.matrix.color', 'backdrop.matrix.zoom', 'backdrop.matrix.speed',
      'backdrop.matrix.density',
    ]);
    expect(shownBackdrop('matrix', false)).toEqual([
      'backdrop.style', 'backdrop.animate', 'scrim.opacity', 'scrim.blurPx', 'backdrop.matrix.color', 'backdrop.matrix.zoom', 'backdrop.matrix.density',
    ]);
  });

  it('shows the picture controls for Image and Slideshow, never Animate, whatever backdrop.animate says', () => {
    for (const animate of [true, false]) {
      expect(shownBackdrop('image', animate)).toEqual(['backdrop.style', 'backdrop.image.file', 'backdrop.image.fit', 'scrim.opacity', 'scrim.blurPx']);
      expect(shownBackdrop('slideshow', animate)).toEqual([
        'backdrop.style', 'backdrop.image.folder', 'backdrop.image.fit', 'backdrop.image.intervalSeconds', 'backdrop.image.crossfadeSeconds',
        'backdrop.image.shuffle',
        'backdrop.image.includeSubfolders', 'scrim.opacity', 'scrim.blurPx',
      ]);
    }
  });
});

describe('Image and Slideshow settings', () => {
  it('saves the slideshow interval as a number and labels a hand-edited one as custom seconds', () => {
    const interval = byPath('backdrop.image.intervalSeconds');
    expect(parseInput(interval, '600')).toEqual({ ok: true, value: 600 });
    expect(parseInput(interval, '45').ok).toBe(false);
    expect(selectChoices(interval.options ?? [], 600, interval.unit)).toBe(interval.options);
    expect(selectChoices(interval.options ?? [], 45, interval.unit).slice(-1)[0]).toEqual({ value: '45', label: 'Custom (45 s)' });
  });

  it('offers the five fits, led by the default', () => {
    expect(byPath('backdrop.image.fit').options?.map((o) => o.value)).toEqual([DEFAULT_SETTINGS.backdrop.image.fit, 'fit', 'stretch', 'center', 'tile']);
  });

  it('lets the file and folder be empty, the unset state, and offers a Browse button for each', () => {
    expect(parseInput(byPath('backdrop.image.file'), '')).toEqual({ ok: true, value: '' });
    expect(byPath('backdrop.image.file').browse).toBe('imageFile');
    expect(byPath('backdrop.image.folder').browse).toBe('folder');
  });
});

describe('Matrix settings', () => {
  it('offers Green and Accent as swatches drawn in the rain each gives, led by the default', () => {
    const color = byPath('backdrop.matrix.color');
    expect(color.options?.map((o) => o.value)).toEqual([DEFAULT_SETTINGS.backdrop.matrix.color, 'accent']);
    const violet = { ...DEFAULT_SETTINGS, accentColor: '#a68bff' };
    expect(color.options?.map((o) => color.swatchColor?.(o.value, violet))).toEqual(['#00ff41', '#7a51ff']);
  });

  it('bounds zoom to 0.5 to 3 and speed to whole numbers from 5 to 30', () => {
    const zoom = byPath('backdrop.matrix.zoom');
    expect(parseInput(zoom, '0.4').ok).toBe(false);
    expect(parseInput(zoom, '0.5').ok).toBe(true);
    expect(parseInput(zoom, '3').ok).toBe(true);
    expect(parseInput(zoom, '3.1').ok).toBe(false);
    const speed = byPath('backdrop.matrix.speed');
    expect(parseInput(speed, '4').ok).toBe(false);
    expect(parseInput(speed, '5').ok).toBe(true);
    expect(parseInput(speed, '30').ok).toBe(true);
    expect(parseInput(speed, '31').ok).toBe(false);
    expect(parseInput(speed, '20.5').ok).toBe(false);
  });

  it('bounds matrix density to 0.25 to 4', () => {
    const density = byPath('backdrop.matrix.density');
    expect(parseInput(density, '0.2').ok).toBe(false);
    expect(parseInput(density, '0.25').ok).toBe(true);
    expect(parseInput(density, '1.5').ok).toBe(true);
    expect(parseInput(density, '4').ok).toBe(true);
    expect(parseInput(density, '4.5').ok).toBe(false);
  });

  it('accepts the five background styles and rejects anything else', () => {
    const style = byPath('backdrop.style');
    for (const v of ['none', 'lights', 'galaxy', 'matrix', 'image', 'slideshow']) expect(parseInput(style, v)).toEqual({ ok: true, value: v });
    expect(parseInput(style, 'rain').ok).toBe(false);
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

describe('matchesFilter', () => {
  const field: SettingsField = { path: ['scrollback'], label: 'Scrollback', kind: 'number', hint: 'Lines kept per terminal', applies: 'live' };

  it('matches every word against the label, hint, and section, ignoring case', () => {
    expect(matchesFilter(field, 'Terminal', '')).toBe(true);
    expect(matchesFilter(field, 'Terminal', 'scroll')).toBe(true);
    expect(matchesFilter(field, 'Terminal', 'terminal LINES')).toBe(true);
    expect(matchesFilter(field, 'Terminal', 'scroll color')).toBe(false);
  });
});
