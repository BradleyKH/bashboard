import { invoke } from '@tauri-apps/api/core';

/** `std::env::consts::OS` as the core reports it: "windows", "macos", "linux". */
export type Os = string;

/**
 * Features with no implementation yet on some OS. The UI hides what is listed for the running
 * OS, so a tester sees a smaller app rather than controls that fail.
 * - localBrowser: drives its frames through the WebView2 DevTools Protocol.
 * - media: the dashboard's Media section reads system media sessions (Windows) or MPRIS players
 *   (Linux); macOS has no backend.
 */
export type Feature = 'localBrowser' | 'media';

const UNSUPPORTED: Readonly<Record<Os, readonly Feature[]>> = {
  macos: ['localBrowser', 'media'],
  linux: ['localBrowser'],
};

// Browser-only runs have no core to ask; they keep the Windows feature set.
let current: Os = 'windows';

/** Reads the OS once at startup, before anything asks `supports`. */
export async function loadPlatform(): Promise<void> {
  current = await invoke<{ os: Os }>('platform_info')
    .then((info) => info.os)
    .catch(() => current);
}

export function platformOs(): Os {
  return current;
}

export function supports(feature: Feature, os: Os = current): boolean {
  return !(UNSUPPORTED[os] ?? []).includes(feature);
}

type Mods = Pick<KeyboardEvent, 'ctrlKey' | 'metaKey'>;

/**
 * Whether the OS's command modifier is held: Cmd on macOS, Ctrl elsewhere. On macOS Ctrl
 * belongs to the shell, and Ctrl+click is a right click.
 */
export function primaryHeld(e: Mods, os: Os = current): boolean {
  return os === 'macos' ? e.metaKey : e.ctrlKey;
}

/** The command modifier held without the other one (Cmd without Ctrl, or Ctrl without Win). */
export function primaryOnly(e: Mods, os: Os = current): boolean {
  return os === 'macos' ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** The command modifier's name for labels: "Cmd" on macOS, "Ctrl" elsewhere. */
export function primaryName(os: Os = current): string {
  return os === 'macos' ? 'Cmd' : 'Ctrl';
}

/** The OS's name for labels: "Windows", "macOS", or "Linux". */
export function osName(os: Os = current): string {
  if (os === 'macos') return 'macOS';
  if (os === 'windows') return 'Windows';
  return 'Linux';
}

/** The OS's file manager, for menu labels: "File Explorer", "Finder", or "File Manager". */
export function fileManagerName(os: Os = current): string {
  if (os === 'macos') return 'Finder';
  if (os === 'windows') return 'File Explorer';
  return 'File Manager';
}

/** The label of the item that opens a folder in the OS's file manager. */
export function openInFileManagerLabel(os: Os = current): string {
  return `Open in ${fileManagerName(os)}`;
}
