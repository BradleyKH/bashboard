import { ACCENT_PRESETS } from './accent';
import { IMAGE_FITS } from './backdrop/image/imageFit';
import { WAVE_COLOR_MODES, waveSwatch } from './backdrop/wave/waveColor';
import { MATRIX_COLOR_MODES, matrixRainColor } from './backdrop/matrix/rainColor';
import { UI_SCALE_MAX, UI_SCALE_MIN } from './uiScale';
import { CLOCK_STYLE_OPTIONS } from './clockModel';
import { resolveScheme, SCHEMES } from './code/schemes';
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
  /** Number and slider fields: the loader rejects fractions (unsigned integers in the settings structs). */
  integer?: boolean;
  /** Slider fields only: the slider runs max to min, showing min + max - value. */
  inverted?: boolean;
  /** Slider fields only: a mouse drag saves on release instead of while it moves; keys still save as they step. */
  commitOnRelease?: boolean;
  /** Number fields only: nonzero values below this are rejected (0 stays valid). */
  minNonZero?: number;
  /** Text fields only: the loader accepts an empty string and the core treats it as unset. */
  allowEmpty?: boolean;
  /** Select fields only: the accepted values. */
  options?: { value: string; label: string }[];
  /** Select fields only: the setting is a number, so the chosen value is saved as one. */
  numeric?: boolean;
  /** Text fields only: a Browse button beside the field opens the native picker for this. */
  browse?: 'imageFile' | 'folder';
  /** Select fields only: each option's value is a #rrggbb color, drawn as a square beside its label. */
  swatches?: boolean;
  /** Swatch fields only: the color for an option whose value is not itself a color. */
  swatchColor?: (value: string, settings: Settings) => string;
  /** Select fields only: an option's label when it depends on other settings, in swatchColor's shape. */
  optionLabel?: (value: string, settings: Settings) => string;
  /** Draws a live sample below the field; `codeColors` is the Code colors snippet. */
  preview?: 'codeColors';
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

// A frozen backdrop redraws only for zoom (every drawn style), the Matrix color and density, and the Wave
// look, so the rest would do nothing while it is still.
const WHILE_ANIMATED: ShownWhen = { path: ['backdrop', 'animate'], value: true };
// Galaxy shares Swirling Lights' settings, read as stars rather than organisms.
const IS_LIGHTS_OR_GALAXY: ShownWhen = { path: ['backdrop', 'style'], oneOf: ['lights', 'galaxy'] };
const IS_MATRIX: ShownWhen = { path: ['backdrop', 'style'], value: 'matrix' };
const IS_WAVE: ShownWhen = { path: ['backdrop', 'style'], value: 'wave' };
// The styles that run on the shared frame rate cap; Matrix steps on its own clock.
const IS_FRAME_CAPPED: ShownWhen = { path: ['backdrop', 'style'], oneOf: ['lights', 'galaxy', 'wave'] };
const IS_DRAWN: ShownWhen = { path: ['backdrop', 'style'], oneOf: ['lights', 'galaxy', 'matrix', 'wave'] };
const IS_IMAGE: ShownWhen = { path: ['backdrop', 'style'], value: 'image' };
const IS_SLIDESHOW: ShownWhen = { path: ['backdrop', 'style'], value: 'slideshow' };
const IS_PICTURE: ShownWhen = { path: ['backdrop', 'style'], oneOf: ['image', 'slideshow'] };
const BORDER_LIGHTS_ON: ShownWhen = { path: ['borderLights'], value: true };
const IS_SHOWN: ShownWhen = { path: ['backdrop', 'style'], oneOf: ['lights', 'galaxy', 'matrix', 'wave', 'image', 'slideshow'] };

const SLIDESHOW_INTERVALS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
  { value: '1800', label: '30 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '21600', label: '6 hours' },
  { value: '86400', label: '1 day' },
];

/** Match accent names the scheme the current accent resolves to; the other options keep their labels. */
export function codeColorsLabel(value: string, settings: Settings): string {
  if (value !== 'matchAccent') return SCHEMES.find((s) => s.id === value)?.label ?? value;
  return `Match accent (${resolveScheme('matchAccent', settings.accentColor).label})`;
}

/** Ranges mirror try_parse_settings in src-tauri/src/settings/parse.rs so a saved value always loads. */
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
          { value: 'loginShell', label: 'Login shell' },
          { value: 'zsh', label: 'zsh' },
          { value: 'bash', label: 'bash' },
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
      { path: ['font', 'size'], label: 'Text size', kind: 'number', min: 6, max: 48, step: 1, unit: 'px', hint: 'Terminals and pane text', applies: 'live', inline: true },
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
      {
        path: ['codeColors', 'scheme'],
        label: 'Code colors',
        kind: 'select',
        options: [{ value: 'matchAccent', label: 'Match accent' }, ...SCHEMES.map((s) => ({ value: s.id, label: s.label }))],
        optionLabel: codeColorsLabel,
        preview: 'codeColors',
        applies: 'live',
      },
      {
        path: ['uiScale'],
        label: 'Interface size',
        kind: 'slider',
        min: UI_SCALE_MIN,
        max: UI_SCALE_MAX,
        step: 0.05,
        unit: 'x',
        // Rescaling mid-drag moves the slider out from under the pointer.
        commitOnRelease: true,
        hint: 'Buttons, bars, titles, and labels; not pane content',
        applies: 'live',
      },
      { path: ['borderLights'], label: 'Border lights', kind: 'toggle', hint: 'Lights circle the panes', applies: 'live', half: true },
      { path: ['agentGlow'], label: 'Agent glow', kind: 'toggle', hint: 'Panes glow softly while an AI agent works in them', applies: 'live', half: true },
      {
        path: ['borderLightsSpeed'],
        label: 'Border light speed',
        kind: 'slider',
        min: 10,
        max: 300,
        step: 10,
        unit: 'px/s',
        integer: true,
        applies: 'live',
        shownWhen: BORDER_LIGHTS_ON,
      },
      {
        path: ['borderLightsDensity'],
        label: 'Border light density',
        kind: 'slider',
        min: 0.25,
        max: 4,
        step: 0.25,
        hint: 'Lights per 1000 px of pane border; every pane has at least one',
        applies: 'live',
        shownWhen: BORDER_LIGHTS_ON,
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
          { value: 'galaxy', label: 'Galaxy' },
          { value: 'matrix', label: 'Matrix' },
          { value: 'wave', label: 'Wave' },
          { value: 'image', label: 'Image' },
          { value: 'slideshow', label: 'Slideshow' },
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
        shownWhen: [IS_FRAME_CAPPED, WHILE_ANIMATED],
      },
      { path: ['backdrop', 'image', 'file'], label: 'Image', kind: 'text', allowEmpty: true, browse: 'imageFile', hint: 'May contain %VARS%', applies: 'live', shownWhen: IS_IMAGE },
      { path: ['backdrop', 'image', 'folder'], label: 'Folder', kind: 'text', allowEmpty: true, browse: 'folder', hint: 'May contain %VARS%', applies: 'live', shownWhen: IS_SLIDESHOW },
      { path: ['backdrop', 'image', 'fit'], label: 'Fit', kind: 'select', options: IMAGE_FITS, applies: 'live', shownWhen: IS_PICTURE, half: true },
      {
        path: ['backdrop', 'image', 'intervalSeconds'],
        label: 'Change every',
        kind: 'select',
        options: SLIDESHOW_INTERVALS,
        numeric: true,
        unit: 's',
        applies: 'live',
        shownWhen: IS_SLIDESHOW,
        half: true,
      },
      {
        path: ['backdrop', 'image', 'crossfadeSeconds'],
        label: 'Crossfade',
        kind: 'slider',
        min: 0,
        max: 10,
        step: 0.5,
        unit: 's',
        hint: '0 switches with no fade',
        applies: 'live',
        shownWhen: IS_SLIDESHOW,
      },
      { path: ['backdrop', 'image', 'shuffle'], label: 'Shuffle', kind: 'toggle', applies: 'live', shownWhen: IS_SLIDESHOW, half: true },
      { path: ['backdrop', 'image', 'includeSubfolders'], label: 'Include subfolders', kind: 'toggle', applies: 'live', shownWhen: IS_SLIDESHOW, half: true },
      // Stored as the scrim's opacity, so 1 here is fully dimmed and the slider reads as brightness.
      { path: ['scrim', 'opacity'], label: 'Brightness', kind: 'slider', min: 0, max: 1, step: 0.05, inverted: true, applies: 'live', shownWhen: IS_SHOWN },
      { path: ['scrim', 'blurPx'], label: 'Blur', kind: 'slider', min: 0, max: 20, step: 1, unit: 'px', applies: 'live', shownWhen: IS_SHOWN },
      { path: ['backdrop', 'capacity'], label: 'Density', kind: 'slider', min: 300, max: 5000, step: 100, integer: true, applies: 'live', shownWhen: [IS_LIGHTS_OR_GALAXY, WHILE_ANIMATED] },
      { path: ['backdrop', 'zoom'], label: 'Zoom', kind: 'slider', min: 0.5, max: 3, step: 0.1, unit: 'x', applies: 'live', shownWhen: IS_LIGHTS_OR_GALAXY },
      {
        path: ['backdrop', 'mutationRate'],
        label: 'Color drift',
        kind: 'slider',
        min: 0,
        max: 4,
        step: 0.1,
        applies: 'live',
        shownWhen: [IS_LIGHTS_OR_GALAXY, WHILE_ANIMATED],
      },
      {
        path: ['backdrop', 'matrix', 'color'],
        label: 'Color',
        kind: 'select',
        options: MATRIX_COLOR_MODES,
        swatches: true,
        swatchColor: (mode, s) => matrixRainColor(mode, s.accentColor),
        applies: 'live',
        shownWhen: IS_MATRIX,
      },
      { path: ['backdrop', 'matrix', 'zoom'], label: 'Zoom', kind: 'slider', min: 0.5, max: 3, step: 0.1, unit: 'x', applies: 'live', shownWhen: IS_MATRIX },
      {
        path: ['backdrop', 'matrix', 'speed'],
        label: 'Speed',
        kind: 'slider',
        min: 5,
        max: 30,
        step: 1,
        integer: true,
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
        applies: 'live',
        shownWhen: IS_MATRIX,
      },
      {
        path: ['backdrop', 'wave', 'color'],
        label: 'Color',
        kind: 'select',
        options: WAVE_COLOR_MODES,
        swatches: true,
        swatchColor: (mode, s) => waveSwatch(mode, s.accentColor),
        applies: 'live',
        shownWhen: IS_WAVE,
      },
      {
        path: ['backdrop', 'wave', 'size'],
        label: 'Size',
        kind: 'slider',
        min: 0.3,
        max: 2,
        step: 0.05,
        applies: 'live',
        shownWhen: IS_WAVE,
      },
      {
        path: ['backdrop', 'wave', 'speed'],
        label: 'Speed',
        kind: 'slider',
        min: 0.1,
        max: 3,
        step: 0.1,
        unit: 'x',
        applies: 'live',
        shownWhen: [IS_WAVE, WHILE_ANIMATED],
      },
      {
        path: ['backdrop', 'wave', 'lineWidth'],
        label: 'Line width',
        kind: 'slider',
        min: 1,
        max: 8,
        step: 0.5,
        unit: 'px',
        applies: 'live',
        shownWhen: IS_WAVE,
      },
      {
        path: ['backdrop', 'wave', 'echoes'],
        label: 'Echoes',
        kind: 'slider',
        min: 0,
        max: 15,
        step: 1,
        integer: true,
        applies: 'live',
        shownWhen: IS_WAVE,
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
    title: 'Ship',
    fields: [
      {
        path: ['ship', 'overviewRefreshMinutes'],
        label: 'Overview refresh interval',
        kind: 'number',
        min: 0,
        max: 1440,
        step: 1,
        unit: 'min',
        integer: true,
        hint: '0 refreshes only when you click Refresh',
        applies: 'live',
        inline: true,
      },
    ],
  },
  {
    title: 'Local Browser',
    fields: [
      { path: ['localBrowser', 'homeUrl'], label: 'Home page', kind: 'text', allowEmpty: true, hint: 'An http or https URL on localhost or 127.0.0.1, or a file:/// URL to an .html file; empty opens the start page', applies: 'live' },
      { path: ['localBrowser', 'trustedFolders'], label: 'Trusted folders', kind: 'list', hint: 'One absolute folder per line; HTML files in them may reach any host', applies: 'live' },
      { path: ['localBrowser', 'reloadOnChange'], label: 'Reload on file change', kind: 'toggle', hint: 'Reload an HTML page when its file changes on disk', applies: 'live' },
    ],
  },
  {
    title: 'Local AI models',
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
    if (!field.options?.some((o) => o.value === raw)) return { ok: false, error: 'Choose one of the listed options' };
    return { ok: true, value: field.numeric ? Number(raw) : raw };
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
export function selectChoices(options: { value: string; label: string }[], saved: unknown, unit?: string): { value: string; label: string }[] {
  const value = typeof saved === 'number' ? String(saved) : saved;
  if (typeof value !== 'string' || options.some((o) => o.value === value)) return options;
  return [...options, { value, label: `Custom (${unit ? `${value} ${unit}` : value})` }];
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
