import { invoke } from '@tauri-apps/api/core';

/** `std::env::consts::OS` as the core reports it: "windows", "macos", "linux". */
export type Os = string;

/**
 * Features with no implementation yet on some OS. The UI hides what is listed for the running
 * OS, so a tester sees a smaller app rather than controls that fail.
 * - localBrowser: drives its frames through the WebView2 DevTools Protocol.
 * - gitInstall: Git for Windows through winget, and the Git Bash setup row.
 */
export type Feature = 'localBrowser' | 'gitInstall';

const UNSUPPORTED: Readonly<Record<Os, readonly Feature[]>> = {
  macos: ['localBrowser', 'gitInstall'],
  linux: ['localBrowser', 'gitInstall'],
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
