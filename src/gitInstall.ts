import { invoke } from '@tauri-apps/api/core';
import { platformOs } from './platform';

/** What can install Git here: winget, or macOS's Command Line Tools installer. */
export type GitInstaller = 'winget' | 'xcodeSelect';

/** Whether Git is present, and what could install it (docs/design/app.md section 4.17). */
export interface GitInstallStatus {
  /** Git Bash on Windows, a working `git` elsewhere. */
  gitFound: boolean;
  /** Null when nothing here can install it, so the download page is offered instead. */
  installer: GitInstaller | null;
}

export function gitInstallStatus(): Promise<GitInstallStatus> {
  return invoke<GitInstallStatus>('git_install_status');
}

/**
 * Installs Git: through winget on Windows, which takes minutes and rejects with winget's output
 * tail; on macOS it only opens the Command Line Tools installer, which runs on its own.
 */
export function gitInstall(): Promise<void> {
  return invoke<void>('git_install');
}

/** Opens Git's download page for this OS in the default browser. */
export function openGitDownload(): Promise<void> {
  const url = platformOs() === 'windows' ? 'https://git-scm.com/download/win' : 'https://git-scm.com/downloads';
  return invoke<void>('open_url', { url });
}
