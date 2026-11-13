import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_ACCENT } from './accent';
import type { ImageFit } from './backdrop/image/imageFit';
import { DEFAULT_WAVE_COLOR_MODE, type WaveColorMode } from './backdrop/wave/waveColor';
import { DEFAULT_MATRIX_COLOR_MODE, type MatrixColorMode } from './backdrop/matrix/rainColor';
import { DEFAULT_CODE_SCHEME, type CodeScheme } from './code/schemes';
import { DEFAULT_CONTENT_TEXT_MODE, type ContentTextMode } from './contentText';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ClockStyle } from './clockModel';
import type { DashboardSide } from './dashboardResize';
import { ELEMENT_SHOWN_BY_DEFAULT, type DashboardElement } from './dashboardSections';
import { DEFAULT_KEYBINDINGS, type Direction, type KeybindingEntry } from './keymap';

export type BackdropStyle = 'none' | 'lights' | 'galaxy' | 'matrix' | 'wave' | 'image' | 'slideshow';

export type ForgeKind = 'github' | 'gitlab' | 'bitbucket' | 'azureDevOps';

export interface Settings {
  shell: { path: string; args: string[]; startingDirectory: string; defaultProfile: string };
  font: { family: string; size: number };
  /** #rrggbb, bright enough to read on the dark panes (docs/design/data.md section 8). */
  accentColor: string;
  /** Non-terminal pane content and dashboard text, derived from the accent (docs/design/data.md section 8). */
  contentTextColor: ContentTextMode;
  /** Code color scheme for text previews; matchAccent picks the one paired with the accent (docs/design/files.md section 4.22). */
  codeColors: { scheme: CodeScheme };
  /** Multiplier on the app's chrome, 1 to 2; the Interface size slider (docs/design/README.md section 5). */
  uiScale: number;
  /** A breathing glow inside panes where an AI agent is working (docs/design/sessions.md section 4.23). */
  agentGlow: boolean;
  /** A light that circles each pane's border in the gutter (docs/design/sessions.md section 4.23). */
  borderLights: boolean;
  /** Border light speed in px per second, 10 to 300. */
  borderLightsSpeed: number;
  /** Border light comets per 1000 px of a pane's loop, 0.25 to 4; every pane runs at least one. */
  borderLightsDensity: number;
  scrim: { opacity: number; blurPx: number };
  /** maxFps 0 is uncapped (docs/design/backdrop.md section 6.4). */
  backdrop: {
    style: BackdropStyle;
    animate: boolean;
    maxFps: number;
    capacity: number;
    mutationRate: number;
    zoom: number;
    /** color is a mode; the rain's #rrggbb is derived from it and the accent. */
    matrix: { color: MatrixColorMode; zoom: number; speed: number; density: number };
    /** color is a mode, resolved like the Matrix's; lineWidth is CSS pixels on the line's near side. */
    wave: { color: WaveColorMode; size: number; speed: number; lineWidth: number; echoes: number };
    /** `file` is the Image style's, the rest the Slideshow's, and `fit` both. Paths may contain %VARS%. */
    image: { file: string; folder: string; fit: ImageFit; intervalSeconds: number; crossfadeSeconds: number; shuffle: boolean; includeSubfolders: boolean };
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
  /** Minutes between background fetches of repos with an open Git pane; 0 turns it off (docs/design/git.md section 3.9). */
  git: { autoFetchMinutes: number; branchSizeThreshold: number };
  /** Cloud-context chips: `badge` shows or hides all of them; `productionPattern` is a case-insensitive regex (docs/design/terminal.md section 4.25). */
  cloud: { badge: boolean; productionPattern: string };
  localModels: { ollamaUrl: string; lmStudioUrl: string; minContext: number };
  /**
   * `hosts` maps a lowercased host name to its forge kind, for self-hosted hosts. The Overview tab
   * reads `pinnedRepos` (identity is `repo`, `<host>/<path>`) and refreshes every
   * `overviewRefreshMinutes`, 0 meaning manual only (docs/settings.md).
   */
  ship: {
    hosts: Record<string, ForgeKind>;
    overviewRefreshMinutes: number;
    pinnedRepos: { repo: string; root?: string; branches?: string[] }[];
    /** Lets `bb ci rerun` and `bb ci cancel` act on pipelines (docs/settings.md). */
    cliWrites: boolean;
  };
  /**
   * Local Browser pane: `bookmarks` are http pages on localhost or 127.0.0.1, or file:/// URLs to
   * .html files; `homeUrl` is where a new pane opens, empty for its start page. `trustedFolders`,
   * `allowedHosts`, `cdnHosts`, and `reloadOnChange` govern local file pages (docs/settings.md).
   */
  localBrowser: {
    bookmarks: { name: string; url: string }[];
    homeUrl: string;
    trustedFolders: string[];
    allowedHosts: { [folder: string]: string[] };
    cdnHosts: string[];
    reloadOnChange: boolean;
  };
  keybindings: KeybindingEntry[];
}

export interface SettingsPayload {
  settings: Settings;
  warnings: string[];
  /** True when this launch created settings.json (docs/design/app.md section 4.17). */
  firstRun: boolean;
}

/** Mirrors Settings::default() in src-tauri/src/settings/model.rs; used when settings_get fails. */
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
  codeColors: { scheme: DEFAULT_CODE_SCHEME },
  uiScale: 1,
  agentGlow: false,
  borderLights: false,
  borderLightsSpeed: 60,
  borderLightsDensity: 1,
  scrim: { opacity: 0.5, blurPx: 1 },
  backdrop: {
    style: 'lights',
    animate: false,
    maxFps: 20,
    capacity: 1000,
    mutationRate: 0.2,
    zoom: 2,
    matrix: { color: DEFAULT_MATRIX_COLOR_MODE, zoom: 1, speed: 10, density: 3 },
    wave: { color: DEFAULT_WAVE_COLOR_MODE, size: 0.85, speed: 0.5, lineWidth: 3, echoes: 4 },
    image: { file: '', folder: '', fit: 'fill', intervalSeconds: 600, crossfadeSeconds: 5, shuffle: true, includeSubfolders: false },
  },
  scrollback: 10000,
  terminal: { doneAfterSeconds: 30, notifyWhenWaiting: true },
  dashboard: { visibleOnStart: true, peekOnWaiting: true, side: 'right', sections: { ...ELEMENT_SHOWN_BY_DEFAULT }, clockStyle: 'both' },
  restore: { enabled: true, resumeSessions: true, scrollback: true },
  editor: { preferred: 'default', command: '' },
  git: { autoFetchMinutes: 5, branchSizeThreshold: 400 },
  cloud: { badge: true, productionPattern: 'prod|prd|live' },
  localModels: { ollamaUrl: '', lmStudioUrl: '', minContext: 64000 },
  ship: { hosts: {}, overviewRefreshMinutes: 5, pinnedRepos: [], cliWrites: false },
  localBrowser: {
    bookmarks: [],
    homeUrl: '',
    trustedFolders: [],
    allowedHosts: {},
    cdnHosts: ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'],
    reloadOnChange: true,
  },
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
