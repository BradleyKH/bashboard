import { invoke } from '@tauri-apps/api/core';

export interface HookInstallPreview {
  settingsPath: string;
  scriptPath: string;
  additions: Record<string, unknown[]>;
  alreadyInstalled: boolean;
  /** Whether `~/.claude` exists, i.e. Claude Code has run on this machine. */
  claudeDetected: boolean;
  /** Whether bash is reachable; the hook command runs through it. */
  bashFound: boolean;
}

export function hookInstallPreview(): Promise<HookInstallPreview> {
  return invoke<HookInstallPreview>('hooks_install_preview');
}

export function hookInstall(): Promise<void> {
  return invoke<void>('hooks_install');
}
