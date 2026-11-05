import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_ACCENT } from './accent';
import { DEFAULT_MATRIX_COLOR_MODE, type MatrixColorMode } from './backdrop/matrix/rainColor';
import { DEFAULT_CONTENT_TEXT_MODE, type ContentTextMode } from './contentText';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ClockStyle } from './clockModel';
import type { DashboardSide } from './dashboardResize';
import { ELEMENT_SHOWN_BY_DEFAULT, type DashboardElement } from './dashboardSections';
import { DEFAULT_KEYBINDINGS, type Direction, type KeybindingEntry } from './keymap';

export type BackdropStyle = 'none' | 'lights' | 'matrix';

export type ForgeKind = 'github' | 'gitlab' | 'bitbucket' | 'azureDevOps';

export interface Settings {
  shell: { path: string; args: string[]; startingDirectory: string; defaultProfile: string };
  font: { family: string; size: number };
  /** #rrggbb, bright enough to read on the dark panes (docs/design.md section 8). */
  accentColor: string;
  /** Non-terminal pane content and dashboard text, derived from the accent (docs/design.md section 8). */
  contentTextColor: ContentTextMode;
  scrim: { opacity: number; blurPx: number };
  /** maxFps 0 is uncapped (docs/design.md section 6.4). */
  backdrop: {
    style: BackdropStyle;
    animate: boolean;
    maxFps: number;
    capacity: number;
    mutationRate: number;
    zoom: number;
    waitingPulse: boolean;
    /** color is a mode; the rain's #rrggbb is derived from it and the accent. */
    matrix: { color: MatrixColorMode; zoom: number; speed: number; density: number };
  };
  scrollback: number;
  /** Seconds a command runs before its finish is marked done; 0 turns command marks off. */
  terminal: { doneAfterSeconds: number; notifyWhenWaiting: boolean };
  dashboard: {
    visibleOnStart: boolean;
    peekOnWaiting: boolean;
    side: DashboardSide;
    sections: Record<DashboardElement, boolean>;
    clockStyle: ClockStyle;
  };
  restore: { enabled: boolean; resumeSessions: boolean; scrollback: boolean };
  editor: { preferred: string; command: string };
  /** Minutes between background fetches of repos with an open Git pane; 0 turns it off (docs/design.md section 3.9). */
  git: { autoFetchMinutes: number };
  localModels: { ollamaUrl: string; lmStudioUrl: string; minContext: number };
  /**
   * `hosts` maps a lowercased host name to its forge kind, for self-hosted hosts. The Overview tab
   * reads `pinnedRepos` (identity is `repo`, `<host>/<path>`) and refreshes every
   * `overviewRefreshMinutes`, 0 meaning manual only (docs/settings.md).
   */
  forge: {
    hosts: Record<string, ForgeKind>;
    overviewRefreshMinutes: number;
    pinnedRepos: { repo: string; root?: string; branches?: string[] }[];
  };
  keybindings: KeybindingEntry[];
}

export interface SettingsPayload {
  settings: Settings;
  warnings: string[];
  /** True when this launch created settings.json (docs/design.md section 4.17). */
  firstRun: boolean;
}

/** Mirrors Settings::default() in src-tauri/src/settings.rs; used when settings_get fails. */
export const DEFAULT_SETTINGS: Settings = {
  shell: {
    path: 'C:\\Program Files\\Git\\bin\\bash.exe',
    args: ['--login', '-i'],
    startingDirectory: '%USERPROFILE%',
    defaultProfile: 'gitBash',
  },
  font: { family: 'JetBrainsMono Nerd Font Mono, Cascadia Mono', size: 14 },
  accentColor: DEFAULT_ACCENT,
  contentTextColor: DEFAULT_CONTENT_TEXT_MODE,
  scrim: { opacity: 0.5, blurPx: 1 },
  backdrop: {
    style: 'lights',
    animate: false,
    maxFps: 20,
    capacity: 1000,
    mutationRate: 0.2,
    zoom: 2,
    waitingPulse: false,
    matrix: { color: DEFAULT_MATRIX_COLOR_MODE, zoom: 1, speed: 10, density: 3 },
  },
  scrollback: 10000,
  terminal: { doneAfterSeconds: 30, notifyWhenWaiting: true },
  dashboard: { visibleOnStart: true, peekOnWaiting: true, side: 'right', sections: { ...ELEMENT_SHOWN_BY_DEFAULT }, clockStyle: 'both' },
  restore: { enabled: true, resumeSessions: true, scrollback: true },
  editor: { preferred: 'default', command: '' },
  git: { autoFetchMinutes: 5 },
  localModels: { ollamaUrl: '', lmStudioUrl: '', minContext: 64000 },
  forge: { hosts: {}, overviewRefreshMinutes: 5, pinnedRepos: [] },
  keybindings: DEFAULT_KEYBINDINGS,
};

export function loadSettings(): Promise<SettingsPayload> {
  return invoke<SettingsPayload>('settings_get');
}

/** Changes one value in the settings file, keeping its comments; hot reload follows. */
export function saveSetting(path: string[], value: unknown): Promise<void> {
  return invoke('settings_set', { path, value });
}

export type KeybindingOp =
  | { op: 'bind'; keys: string; action: string; direction?: Direction; index?: number; input?: string }
  | { op: 'unbind'; keys: string }
  | { op: 'reset'; keys: string }
  | { op: 'resetAll' }
  /** Writes the raw array back as given, including entries the loader rejects. */
  | { op: 'replaceAll'; entries: unknown[] };

/**
 * Applies keybinding edits to the raw keybindings array in the settings file and resolves to that
 * array as it was, for Undo; hot reload, not the return, delivers the new keymap.
 */
export function editKeybindings(ops: KeybindingOp[]): Promise<unknown[]> {
  return invoke<unknown[]>('settings_keybindings_edit', { ops });
}

/** Opens the settings file in the default editor, creating it first if missing. */
export function openSettingsFile(): Promise<void> {
  return invoke('settings_open_file');
}

export function onSettingsChanged(cb: (p: SettingsPayload) => void): Promise<UnlistenFn> {
  return listen<SettingsPayload>('settings://changed', (e) => cb(e.payload));
}
