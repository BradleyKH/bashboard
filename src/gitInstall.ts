import { invoke } from '@tauri-apps/api/core';

/** Whether Git Bash and winget are present (docs/design.md section 4.17). */
export interface GitInstallStatus {
  gitBashFound: boolean;
  wingetFound: boolean;
}

export function gitInstallStatus(): Promise<GitInstallStatus> {
  return invoke<GitInstallStatus>('git_install_status');
}

/** Installs Git for Windows through winget; takes minutes, and rejects with winget's output tail. */
export function gitInstall(): Promise<void> {
  return invoke<void>('git_install');
}

const GIT_DOWNLOAD_URL = 'https://git-scm.com/download/win';

/** Opens the Git for Windows download page in the default browser. */
export function openGitDownload(): Promise<void> {
  return invoke<void>('open_url', { url: GIT_DOWNLOAD_URL });
}
