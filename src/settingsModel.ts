import { ACCENT_PRESETS } from './accent';
import { MATRIX_COLOR_MODES, matrixRainColor } from './backdrop/matrix/rainColor';
import { CLOCK_STYLE_OPTIONS } from './clockModel';
import { CONTENT_TEXT_MODES, contentTextColor } from './contentText';
import { DEFAULT_ELEMENT_ORDER, ELEMENT_HINTS, ELEMENT_LABELS } from './dashboardSections';
import type { Settings } from './settings';

export type FieldKind = 'toggle' | 'number' | 'slider' | 'text' | 'list' | 'select';
export type AppliesWhen = 'live' | 'nextLaunch' | 'newPanes';

export interface SettingsField {
  path: string[];
  label: string;
  kind: FieldKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Number and slider fields: the loader rejects fractions (unsigned integers in settings.rs). */
  integer?: boolean;
  /** Slider fields only: the slider runs max to min, showing min + max - value. */
  inverted?: boolean;
  /** Number fields only: nonzero values below this are rejected (0 stays valid). */
  minNonZero?: number;
  /** Text fields only: the loader accepts an empty string and the core treats it as unset. */
  allowEmpty?: boolean;
  /** Select fields only: the accepted values. */
  options?: { value: string; label: string }[];
  /** Select fields only: each option's value is a #rrggbb color, drawn as a square beside its label. */
  swatches?: boolean;
  /** Swatch fields only: the color for an option whose value is not itself a color. */
  swatchColor?: (value: string, settings: Settings) => string;
  /** Select fields only: offer just the options the core detected, as shell profiles or editors. */
  installedFrom?: 'profiles' | 'editors';
  /** Text fields only: suggest values while typing, filled from the core after the dialog opens. */
  suggestFrom?: 'fonts';
  hint?: string;
  applies: AppliesWhen;
  /** A subheading shown above the first field of a run of fields sharing it. */
  group?: string;
  /** Takes half the row, beside a neighboring half field when the dialog is wide enough. */
  half?: boolean;
  /** Puts the control right after its label instead of in the tab's right-hand control column. */
  inline?: boolean;
  /** Shown only while every condition holds; for settings that do nothing otherwise. */
  shownWhen?: ShownWhen | ShownWhen[];
}

/** The field at `path` holds `value`, or, when `oneOf` is set, any of those values. */
export interface ShownWhen {
  path: string[];
  value?: unknown;
  oneOf?: unknown[];
}

export interface SettingsSection {
  title: string;
  fields: SettingsField[];
}

// A frozen backdrop redraws only for zoom (both styles) and the Matrix color and density, so the rest would do
// nothing while it is still.
const WHILE_ANIMATED: ShownWhen = { path: ['backdrop', 'animate'], value: true };
const IS_LIGHTS: ShownWhen = { path: ['backdrop', 'style'], value: 'lights' };
const IS_MATRIX: ShownWhen = { path: ['backdrop', 'style'], value: 'matrix' };
const IS_DRAWN: ShownWhen = { path: ['backdrop', 'style'], oneOf: ['lights', 'matrix'] };

/** Ranges mirror try_parse_settings in src-tauri/src/settings.rs so a saved value always loads. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: 'Terminal',
    fields: [
      { path: ['terminal', 'notifyWhenWaiting'], label: 'Notify when a terminal needs you', kind: 'toggle', hint: 'Only while Bashboard is in the background', applies: 'live' },
      {
        path: ['shell', 'defaultProfile'],
        label: 'Default shell',
        kind: 'select',
        options: [
          { value: 'gitBash', label: 'Git Bash' },
          { value: 'pwsh', label: 'PowerShell 7' },
          { value: 'powershell', label: 'Windows PowerShell' },
          { value: 'cmd', label: 'Command Prompt' },
        ],
        installedFrom: 'profiles',
        applies: 'newPanes',
      },
      { path: ['shell', 'path'], label: 'Git Bash path', kind: 'text', applies: 'newPanes' },
      { path: ['shell', 'args'], label: 'Git Bash arguments', kind: 'list', hint: 'One argument per line', applies: 'newPanes' },
      {
        path: ['shell', 'startingDirectory'],
        label: 'Starting directory',
        kind: 'text',
        allowEmpty: true,
        hint: 'Used when no folder is inherited; may contain %VARS%',
        applies: 'newPanes',
      },
      { path: ['scrollback'], label: 'Scrollback', kind: 'number', min: 0, max: 1000000, step: 1000, unit: 'lines', integer: true, applies: 'live' },
      { path: ['terminal', 'doneAfterSeconds'], label: 'Mark long commands done after', kind: 'number', min: 0, max: 86400, step: 1, unit: 's', integer: true, hint: '0 turns it off; Git Bash with the ~/.bashrc lines only', applies: 'live' },
    ],
  },
  {
    title: 'Dashboard',
    fields: [
      { path: ['dashboard', 'visibleOnStart'], label: 'Show the dashboard at launch', kind: 'toggle', applies: 'nextLaunch', half: true },
      { path: ['dashboard', 'peekOnWaiting'], label: 'Peek when a terminal is waiting', kind: 'toggle', applies: 'live', half: true },
      {
        path: ['dashboard', 'side'],
        label: 'Dashboard side',
        kind: 'select',
        options: [
          { value: 'right', label: 'Right' },
          { value: 'left', label: 'Left' },
        ],
        applies: 'live',
        inline: true,
      },
      ...DEFAULT_ELEMENT_ORDER.map((id): SettingsField => ({
        path: ['dashboard', 'sections', id],
        label: ELEMENT_LABELS[id],
        hint: ELEMENT_HINTS[id],
        kind: 'toggle',
        applies: 'live',
        group: 'Show on the dashboard',
        half: true,
      })),
      {
        path: ['dashboard', 'clockStyle'],
        label: 'Clock style',
        kind: 'select',
        options: [...CLOCK_STYLE_OPTIONS],
        applies: 'live',
        group: 'Show on the dashboard',
        inline: true,
        shownWhen: { path: ['dashboard', 'sections', 'clock'], value: true },
      },
    ],
  },
  {
    title: 'Appearance',
    fields: [
      { path: ['font', 'family'], label: 'Font family', kind: 'text', suggestFrom: 'fonts', applies: 'live', inline: true },
      { path: ['font', 'size'], label: 'Font size', kind: 'number', min: 6, max: 48, step: 1, unit: 'px', applies: 'live', inline: true },
      { path: ['accentColor'], label: 'Accent color', kind: 'select', options: ACCENT_PRESETS, swatches: true, applies: 'live', half: true },
      {
        path: ['contentTextColor'],
        label: 'Text color',
        kind: 'select',
        options: CONTENT_TEXT_MODES,
        swatches: true,
        swatchColor: (mode, s) => contentTextColor(mode, s.accentColor),
        applies: 'live',
        half: true,
      },
    ],
  },
  {
    title: 'Background',
    fields: [
      {
        path: ['backdrop', 'style'],
        label: 'Background',
        kind: 'select',
        options: [
          { value: 'none', label: 'None' },
          { value: 'lights', label: 'Swirling Lights' },
          { value: 'matrix', label: 'Matrix' },
        ],
        applies: 'live',
        half: true,
      },
      { path: ['backdrop', 'animate'], label: 'Animate', kind: 'toggle', hint: 'Off freezes it on a still frame', applies: 'live', shownWhen: IS_DRAWN, half: true },
      {
        path: ['backdrop', 'maxFps'],
        label: 'Frame rate cap',
        kind: 'number',
        min: 0,
        max: 240,
        step: 1,
        unit: 'fps',
        integer: true,
        minNonZero: 20,
        hint: '0 uses the display refresh rate; otherwise 20 to 240',
        applies: 'live',
        shownWhen: [IS_LIGHTS, WHILE_ANIMATED],
      },
      // Stored as the scrim's opacity, so 1 here is fully dimmed and the slider reads as brightness.
      { path: ['scrim', 'opacity'], label: 'Brightness', kind: 'slider', min: 0, max: 1, step: 0.05, inverted: true, applies: 'live', shownWhen: IS_DRAWN },
      { path: ['scrim', 'blurPx'], label: 'Blur', kind: 'slider', min: 0, max: 20, step: 1, unit: 'px', applies: 'live', shownWhen: IS_DRAWN },
      { path: ['backdrop', 'capacity'], label: 'Density', kind: 'slider', min: 300, max: 5000, step: 100, integer: true, applies: 'live', shownWhen: [IS_LIGHTS, WHILE_ANIMATED] },
      { path: ['backdrop', 'zoom'], label: 'Zoom', kind: 'slider', min: 0.5, max: 3, step: 0.1, unit: 'x', applies: 'live', shownWhen: IS_LIGHTS },
      {
        path: ['backdrop', 'mutationRate'],
        label: 'Color drift',
        kind: 'slider',
        min: 0,
        max: 4,
        step: 0.1,
        applies: 'live',
        shownWhen: [IS_LIGHTS, WHILE_ANIMATED],
      },
      {
        path: ['backdrop', 'waitingPulse'],
        label: 'Pulse waiting sessions',
        kind: 'toggle',
        applies: 'live',
        shownWhen: [IS_LIGHTS, WHILE_ANIMATED],
      },
      {
        path: ['backdrop', 'matrix', 'color'],
        label: 'Color',
        kind: 'select',
        options: MATRIX_COLOR_MODES,
        swatches: true,
        swatchColor: (mode, s) => matrixRainColor(mode, s.accentColor),
        hint: 'The rain',
        applies: 'live',
        shownWhen: IS_MATRIX,
      },
      { path: ['backdrop', 'matrix', 'zoom'], label: 'Zoom', kind: 'slider', min: 0.5, max: 3, step: 0.1, unit: 'x', hint: 'Glyph size', applies: 'live', shownWhen: IS_MATRIX },
      {
        path: ['backdrop', 'matrix', 'speed'],
        label: 'Speed',
        kind: 'slider',
        min: 5,
        max: 30,
        step: 1,
        integer: true,
        hint: 'How fast the rain falls',
        applies: 'live',
        shownWhen: [IS_MATRIX, WHILE_ANIMATED],
      },
      {
        path: ['backdrop', 'matrix', 'density'],
        label: 'Density',
        kind: 'slider',
        min: 0.25,
        max: 4,
        step: 0.25,
        unit: 'x',
        hint: 'How often new drops start',
        applies: 'live',
        shownWhen: IS_MATRIX,
      },
    ],
  },
  {
    title: 'Editor',
    fields: [
      {
        path: ['editor', 'preferred'],
        label: 'Preferred editor',
        kind: 'select',
        options: [
          { value: 'zed', label: 'Zed' },
          { value: 'vscode', label: 'VS Code' },
          { value: 'cursor', label: 'Cursor' },
          { value: 'visualStudio', label: 'Visual Studio' },
          { value: 'notepadpp', label: 'Notepad++' },
          { value: 'sublime', label: 'Sublime Text' },
          { value: 'rider', label: 'Rider' },
          { value: 'intellij', label: 'IntelliJ IDEA' },
          { value: 'webstorm', label: 'WebStorm' },
          { value: 'pycharm', label: 'PyCharm' },
          { value: 'rustrover', label: 'RustRover' },
          { value: 'goland', label: 'GoLand' },
          { value: 'clion', label: 'CLion' },
          { value: 'phpstorm', label: 'PhpStorm' },
          { value: 'windsurf', label: 'Windsurf' },
          { value: 'vscodeInsiders', label: 'VS Code Insiders' },
          { value: 'vscodium', label: 'VSCodium' },
          { value: 'default', label: "The file's default app" },
        ],
        installedFrom: 'editors',
        applies: 'live',
      },
      {
        path: ['editor', 'command'],
        label: 'Custom command',
        kind: 'text',
        allowEmpty: true,
        hint: 'Replaces the editor; {path} and {line} are filled in',
        applies: 'live',
      },
    ],
  },
  {
    title: 'Git',
    fields: [
      {
        path: ['git', 'autoFetchMinutes'],
        label: 'Background fetch interval',
        kind: 'number',
        min: 0,
        max: 1440,
        step: 1,
        unit: 'min',
        integer: true,
        hint: '0 turns background fetch off',
        applies: 'live',
        inline: true,
      },
    ],
  },
  {
    title: 'Local models',
    fields: [
      { path: ['localModels', 'ollamaUrl'], label: 'Ollama URL', kind: 'text', allowEmpty: true, hint: 'Empty uses http://localhost:11434', applies: 'live' },
      { path: ['localModels', 'lmStudioUrl'], label: 'LM Studio URL', kind: 'text', allowEmpty: true, hint: 'Empty uses http://localhost:1234', applies: 'live' },
      { path: ['localModels', 'minContext'], label: 'Minimum context length', kind: 'number', min: 0, max: 10000000, step: 1000, unit: 'tokens', integer: true, hint: '0 turns the warning off', applies: 'live' },
    ],
  },
  {
    title: 'Restore',
    fields: [
      { path: ['restore', 'enabled'], label: 'Restore panes at launch', kind: 'toggle', applies: 'nextLaunch', half: true },
      { path: ['restore', 'resumeSessions'], label: 'Resume agent sessions', kind: 'toggle', applies: 'nextLaunch', half: true },
      { path: ['restore', 'scrollback'], label: 'Restore terminal scrollback', kind: 'toggle', applies: 'nextLaunch', half: true },
    ],
  },
];

export function readField(settings: Settings, path: string[]): unknown {
  let cur: unknown = settings;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Maps between a slider's stored value and its position; its own inverse. */
export function sliderPosition(field: SettingsField, value: number): number {
  if (!field.inverted) return value;
  const decimals = field.step !== undefined ? (String(field.step).split('.')[1] ?? '').length : 0;
  return Number(((field.min ?? 0) + (field.max ?? 0) - value).toFixed(decimals));
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Whether a field is shown, given a reader for the current value at a path. */
export function isShown(field: SettingsField, read: (path: string[]) => unknown): boolean {
  const conditions = field.shownWhen === undefined ? [] : [field.shownWhen].flat();
  return conditions.every((c) => {
    const current = read(c.path);
    return c.oneOf ? c.oneOf.includes(current) : current === c.value;
  });
}

export function parseInput(field: SettingsField, raw: string | boolean): ParseResult {
  if (field.kind === 'toggle') {
    return typeof raw === 'boolean' ? { ok: true, value: raw } : { ok: false, error: 'Expected on or off' };
  }
  if (typeof raw !== 'string') return { ok: false, error: 'Expected text' };

  if (field.kind === 'list') {
    return { ok: true, value: raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '') };
  }
  if (field.kind === 'select') {
    return field.options?.some((o) => o.value === raw) ? { ok: true, value: raw } : { ok: false, error: 'Choose one of the listed options' };
  }
  if (field.kind === 'text') {
    const value = raw.trim();
    if (value === '' && !field.allowEmpty) return { ok: false, error: `${field.label} cannot be empty` };
    return { ok: true, value };
  }

  const text = raw.trim();
  const n = text === '' ? NaN : Number(text);
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number' };
  if (field.integer && !Number.isInteger(n)) return { ok: false, error: 'Enter a whole number' };
  if (field.min !== undefined && n < field.min) return { ok: false, error: `Must be at least ${field.min}` };
  if (field.max !== undefined && n > field.max) return { ok: false, error: `Must be at most ${field.max}` };
  if (field.minNonZero !== undefined && n !== 0 && n < field.minNonZero) {
    return { ok: false, error: `Must be 0 or at least ${field.minNonZero}` };
  }
  return { ok: true, value: n };
}

export interface InstalledChoices {
  options: { value: string; label: string }[];
  /** Set when the saved value is not installed; names the shell new panes use instead. */
  note?: string;
}

/**
 * Narrows a select's options to the installed profiles or detected editors. A saved value that is
 * not installed stays selectable, labeled as missing, so the dialog shows what the file says.
 */
export function installedChoices(
  options: { value: string; label: string }[],
  installed: { id: string; name: string }[],
  saved: unknown,
  source: 'profiles' | 'editors' = 'profiles',
): InstalledChoices {
  const ids = new Set(installed.map((p) => p.id));
  const shown = options.filter((o) => ids.has(o.value));
  const missing = options.find((o) => o.value === saved && !ids.has(o.value));
  if (!missing) return { options: shown };
  if (source === 'editors') {
    return {
      options: [{ value: missing.value, label: `${missing.label} (not found)` }, ...shown],
      note: `${missing.label} was not found; files open in the default app`,
    };
  }
  const fallback = installed[0];
  return {
    options: [{ value: missing.value, label: `${missing.label} (not installed)` }, ...shown],
    note: fallback ? `${missing.label} is not installed; new panes use ${fallback.name}` : undefined,
  };
}

/**
 * A select's options, plus the saved value when it is none of them (a hand-edited accentColor),
 * so the dialog shows what is in effect instead of a blank select.
 */
export function selectChoices(options: { value: string; label: string }[], saved: unknown): { value: string; label: string }[] {
  if (typeof saved !== 'string' || options.some((o) => o.value === saved)) return options;
  return [...options, { value: saved, label: `Custom (${saved})` }];
}

export function appliesNote(field: SettingsField): string {
  if (field.applies === 'nextLaunch') return 'Applies at next launch';
  if (field.applies === 'newPanes') return 'Applies to new panes';
  return '';
}

/** Whether every word of `query` appears in the field's label, hint, group, or section title. */
export function matchesFilter(field: SettingsField, sectionTitle: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w);
  if (words.length === 0) return true;
  const text = [field.label, field.hint, field.group, sectionTitle].filter((s) => s).join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}
