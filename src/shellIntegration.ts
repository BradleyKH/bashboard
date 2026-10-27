import { invoke } from '@tauri-apps/api/core';

/** How `~/.bashrc` relates to the shell-integration block (docs/design.md section 4.17). */
export type ShellIntegrationStatus = 'missing' | 'installed' | 'outdated' | 'handAdded' | 'custom';

export interface ShellIntegrationPreview {
  bashrcPath: string;
  status: ShellIntegrationStatus;
  /** The marked block the install writes, LF line endings. */
  block: string;
  createsBashrc: boolean;
  createsBashProfile: boolean;
  /** Set when `~/.bash_profile` exists but does not source `~/.bashrc`. */
  bashProfileWarning: string | null;
}

/** Rejects with a message when the home folder or `.bashrc` cannot be read. */
export function shellIntegrationPreview(): Promise<ShellIntegrationPreview> {
  return invoke<ShellIntegrationPreview>('shell_integration_preview');
}

/** Rejects with a message for a customized block, which must be updated by hand. */
export function shellIntegrationInstall(): Promise<void> {
  return invoke<void>('shell_integration_install');
}
