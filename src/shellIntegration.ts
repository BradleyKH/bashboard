import { invoke } from '@tauri-apps/api/core';

/** The profiles that take shell integration lines; cmd reports its folder without any. */
export type IntegrationShell = 'gitBash' | 'pwsh' | 'powershell';

export const INTEGRATION_SHELLS: readonly IntegrationShell[] = ['gitBash', 'pwsh', 'powershell'];

export function isIntegrationShell(id: string): id is IntegrationShell {
  return (INTEGRATION_SHELLS as readonly string[]).includes(id);
}

/** How the shell's startup file relates to the shell-integration block (docs/design/app.md section 3.14). */
export type ShellIntegrationStatus = 'missing' | 'installed' | 'outdated' | 'handAdded' | 'custom';

export interface ShellIntegrationPreview {
  shell: IntegrationShell;
  /** `~/.bashrc`, or the PowerShell profile. */
  path: string;
  status: ShellIntegrationStatus;
  /** The marked block the install writes, LF line endings. */
  block: string;
  createsFile: boolean;
  /** Git Bash only. */
  createsBashProfile: boolean;
  /** Something outside the file that keeps the lines from running, with how to fix it. */
  warning: string | null;
}

/** Rejects with a message when the file cannot be read, or the shell cannot report its profile. */
export function shellIntegrationPreview(shell: IntegrationShell): Promise<ShellIntegrationPreview> {
  return invoke<ShellIntegrationPreview>('shell_integration_preview', { shell });
}

/** Rejects with a message for a customized block, which must be updated by hand. */
export function shellIntegrationInstall(shell: IntegrationShell): Promise<void> {
  return invoke<void>('shell_integration_install', { shell });
}
