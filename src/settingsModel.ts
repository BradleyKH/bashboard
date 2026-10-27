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
  /** Number fields only: nonzero values below this are rejected (0 stays valid). */
  minNonZero?: number;
  /** Text fields only: the loader accepts an empty string and the core treats it as unset. */
  allowEmpty?: boolean;
  /** Select fields only: the accepted values. */
  options?: { value: string; label: string }[];
  /** Select fields only: offer just the options the core detected, as shell profiles or editors. */
  installedFrom?: 'profiles' | 'editors';
  hint?: string;
  applies: AppliesWhen;
}

export interface SettingsSection {
  title: string;
  fields: SettingsField[];
}

/** Ranges mirror try_parse_settings in src-tauri/src/settings.rs so a saved value always loads. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    title: 'Appearance',
    fields: [
      { path: ['font', 'family'], label: 'Font family', kind: 'text', applies: 'live' },
      { path: ['font', 'size'], label: 'Font size', kind: 'number', min: 6, max: 48, step: 1, unit: 'px', applies: 'live' },
    ],
  },
  {
    title: 'Terminal',
    fields: [
      { path: ['scrollback'], label: 'Scrollback', kind: 'number', min: 0, max: 1000000, step: 1000, unit: 'lines', integer: true, applies: 'live' },
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
    title: 'Dashboard',
    fields: [
      { path: ['dashboard', 'visibleOnStart'], label: 'Show the dashboard at launch', kind: 'toggle', applies: 'nextLaunch' },
      { path: ['dashboard', 'peekOnWaiting'], label: 'Peek when a terminal is waiting', kind: 'toggle', applies: 'live' },
      { path: ['containers', 'enabled'], label: 'Show the Containers section', kind: 'toggle', applies: 'live' },
    ],
  },
  {
    title: 'Restore',
    fields: [
      { path: ['restore', 'enabled'], label: 'Restore panes at launch', kind: 'toggle', applies: 'nextLaunch' },
      { path: ['restore', 'resumeClaude'], label: 'Resume Claude Code sessions', kind: 'toggle', applies: 'nextLaunch' },
    ],
  },
  {
    title: 'Background Animation',
    fields: [
      { path: ['backdrop', 'animate'], label: 'Animate', kind: 'toggle', hint: 'Off freezes it on a still frame', applies: 'live' },
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
      },
      { path: ['backdrop', 'speed'], label: 'Speed', kind: 'slider', min: 0.25, max: 12, step: 0.25, unit: 'gen/s', applies: 'live' },
      {
        path: ['backdrop', 'capacity'],
        label: 'Population capacity',
        kind: 'slider',
        min: 300,
        max: 5000,
        step: 100,
        integer: true,
        hint: 'How many organisms the colony can sustain',
        applies: 'live',
      },
      {
        path: ['backdrop', 'mutationRate'],
        label: 'Mutation rate',
        kind: 'slider',
        min: 0,
        max: 4,
        step: 0.1,
        hint: 'How far offspring drift from their parents in color and strategy',
        applies: 'live',
      },
      { path: ['backdrop', 'lineageThreads'], label: 'Lineage threads', kind: 'toggle', hint: 'Faint lines from parents to offspring', applies: 'live' },
      {
        path: ['backdrop', 'orbit'],
        label: 'Orbit the camera',
        kind: 'toggle',
        hint: 'Stays still while Windows animation effects are off',
        applies: 'live',
      },
      { path: ['backdrop', 'zoom'], label: 'Zoom', kind: 'slider', min: 0.5, max: 3, step: 0.1, unit: 'x', hint: 'Above 1 brings the colony closer', applies: 'live' },
      {
        path: ['backdrop', 'waitingPulse'],
        label: 'Pulse waiting sessions',
        kind: 'toggle',
        hint: "Brightens a waiting Claude session's organisms in a steady pulse",
        applies: 'live',
      },
      { path: ['scrim', 'opacity'], label: 'Dimming behind terminals', kind: 'slider', min: 0, max: 1, step: 0.05, applies: 'live' },
      { path: ['scrim', 'blurPx'], label: 'Blur behind terminals', kind: 'slider', min: 0, max: 20, step: 1, unit: 'px', applies: 'live' },
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

export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

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

export function appliesNote(field: SettingsField): string {
  if (field.applies === 'nextLaunch') return 'Applies at next launch';
  if (field.applies === 'newPanes') return 'Applies to new panes';
  return '';
}
