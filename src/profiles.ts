import { invoke } from '@tauri-apps/api/core';

/** One shell the core can launch in a pane (docs/design/terminal.md section 3.1). */
export interface ShellProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  /** Takes the shell integration lines: Git Bash, and on Unix any profile that runs zsh or bash. */
  integration: boolean;
}

/** Browser-only runs have no core to ask, so Git Bash stands in. */
export const GIT_BASH_PROFILE: ShellProfile = {
  id: 'gitBash',
  name: 'Git Bash',
  path: 'C:\\Program Files\\Git\\bin\\bash.exe',
  args: ['--login', '-i'],
  integration: true,
};

export function loadProfiles(): Promise<ShellProfile[]> {
  return invoke<ShellProfile[]>('shell_profiles');
}

/** Names for the core's fixed profile ids, for views that have no profile list at hand. */
export const PROFILE_NAMES: Readonly<Record<string, string>> = {
  gitBash: 'Git Bash',
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: 'Command Prompt',
  loginShell: 'Login shell',
  zsh: 'zsh',
  bash: 'bash',
};

/** Display name for a profile id: the listed profile's name, else the static name, else the id. */
export function profileName(id: string, profiles: ShellProfile[] = []): string {
  const listed = profiles.find((p) => p.id === id)?.name;
  if (listed) return listed;
  return Object.prototype.hasOwnProperty.call(PROFILE_NAMES, id) ? PROFILE_NAMES[id] : id;
}

const PROFILE_ID = /^[A-Za-z]{1,32}$/;

/** The id when `raw` is a well-formed profile id, else undefined. */
export function parseProfileId(raw: unknown): string | undefined {
  return typeof raw === 'string' && PROFILE_ID.test(raw) ? raw : undefined;
}

/** Small label naming a shell other than `shell.defaultProfile`; null for the default, which needs no marker. */
export function profileBadge(id: string, defaultProfile: string): HTMLElement | null {
  if (id === defaultProfile) return null;
  const el = document.createElement('span');
  el.className = 'profile-badge';
  el.textContent = profileName(id);
  el.title = `Runs ${profileName(id)}`;
  return el;
}
