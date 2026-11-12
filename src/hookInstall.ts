import { invoke } from '@tauri-apps/api/core';

export type HookAgentId = 'claude' | 'codex' | 'copilot';

/** Whether Codex will run the installed hooks; `unknown` when its config could not be read. */
export type CodexTrust = 'trusted' | 'untrusted' | 'unknown';

/**
 * The installed hook program against the bundled one: `outdated` covers an older build and a
 * shell script left by an earlier Bashboard, `current` the same version, and `newer` a program
 * from a newer Bashboard, which counts as installed and is never overwritten.
 */
export type HookScriptState = 'missing' | 'outdated' | 'current' | 'newer';

export interface HookInstallPreview {
  /** The agent's hook config file: `settings.json`, `hooks.json`, or `hooks/bashboard.json`. */
  settingsPath: string;
  scriptPath: string;
  additions: Record<string, unknown[]>;
  alreadyInstalled: boolean;
  scriptState: HookScriptState;
  /** `detected` for Claude Code, false for other agents. */
  claudeDetected: boolean;
  /** The core always sends these three; optional so hand-built previews still type-check. */
  agent?: HookAgentId;
  /** Whether the agent's home folder exists, i.e. the agent has run on this machine. */
  detected?: boolean;
  /** Codex only, once Bashboard's hooks are in `hooks.json`; null otherwise. */
  trust?: CodexTrust | null;
}

export function hookInstallPreview(agent: HookAgentId = 'claude'): Promise<HookInstallPreview> {
  return invoke<HookInstallPreview>('hooks_install_preview', { agent });
}

export function hookInstall(agent: HookAgentId = 'claude'): Promise<void> {
  return invoke<void>('hooks_install', { agent });
}
