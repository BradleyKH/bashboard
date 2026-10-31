import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { DashboardSide } from './dashboardResize';
import { ELEMENT_SHOWN_BY_DEFAULT, type DashboardElement } from './dashboardSections';
import { DEFAULT_KEYBINDINGS, type Direction, type KeybindingEntry } from './keymap';

export interface Settings {
  shell: { path: string; args: string[]; startingDirectory: string; defaultProfile: string };
  font: { family: string; size: number };
  scrim: { opacity: number; blurPx: number };
  /** maxFps 0 is uncapped (docs/design.md section 6.4); speed is generations per second. */
  backdrop: {
    animate: boolean;
    maxFps: number;
    speed: number;
    capacity: number;
    mutationRate: number;
    lineageThreads: boolean;
    orbit: boolean;
    zoom: number;
    waitingPulse: boolean;
  };
  scrollback: number;
  /** Seconds a command runs before its finish is marked done; 0 turns command marks off. */
  terminal: { doneAfterSeconds: number };
  dashboard: {
    visibleOnStart: boolean;
    peekOnWaiting: boolean;
    side: DashboardSide;
    sections: Record<DashboardElement, boolean>;
  };
  restore: { enabled: boolean; resumeClaude: boolean };
  editor: { preferred: string; command: string };
  /** Minutes between background fetches of repos with an open Git pane; 0 turns it off (docs/design.md section 3.9). */
  git: { autoFetchMinutes: number };
  /** The zoom a new pane of each kind starts at, from 0.5 to 3; its zoom buttons save it. */
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
  scrim: { opacity: 0.5, blurPx: 0 },
  backdrop: { animate: false, maxFps: 20, speed: 10, capacity: 1000, mutationRate: 0.2, lineageThreads: false, orbit: true, zoom: 2, waitingPulse: false },
  scrollback: 10000,
  terminal: { doneAfterSeconds: 30 },
  dashboard: { visibleOnStart: true, peekOnWaiting: true, side: 'right', sections: { ...ELEMENT_SHOWN_BY_DEFAULT } },
  restore: { enabled: true, resumeClaude: true },
  editor: { preferred: 'default', command: '' },
  git: { autoFetchMinutes: 5 },
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
  | { op: 'resetAll' };

/** Applies keybinding edits to the raw keybindings array in the settings file; hot reload, not the return, delivers the result. */
export function editKeybindings(ops: KeybindingOp[]): Promise<void> {
  return invoke('settings_keybindings_edit', { ops });
}

/** Opens the settings file in the default editor, creating it first if missing. */
export function openSettingsFile(): Promise<void> {
  return invoke('settings_open_file');
}

export function onSettingsChanged(cb: (p: SettingsPayload) => void): Promise<UnlistenFn> {
  return listen<SettingsPayload>('settings://changed', (e) => cb(e.payload));
}
