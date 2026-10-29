import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { DEFAULT_KEYBINDINGS, type KeybindingEntry } from './keymap';

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
  dashboard: { visibleOnStart: boolean; peekOnWaiting: boolean };
  restore: { enabled: boolean; resumeClaude: boolean };
  editor: { preferred: string; command: string };
  containers: { enabled: boolean };
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
  dashboard: { visibleOnStart: true, peekOnWaiting: true },
  restore: { enabled: true, resumeClaude: true },
  editor: { preferred: 'default', command: '' },
  containers: { enabled: true },
  keybindings: DEFAULT_KEYBINDINGS,
};

export function loadSettings(): Promise<SettingsPayload> {
  return invoke<SettingsPayload>('settings_get');
}

/** Changes one value in the settings file, keeping its comments; hot reload follows. */
export function saveSetting(path: string[], value: unknown): Promise<void> {
  return invoke('settings_set', { path, value });
}

/** Opens the settings file in the default editor, creating it first if missing. */
export function openSettingsFile(): Promise<void> {
  return invoke('settings_open_file');
}

export function onSettingsChanged(cb: (p: SettingsPayload) => void): Promise<UnlistenFn> {
  return listen<SettingsPayload>('settings://changed', (e) => cb(e.payload));
}
