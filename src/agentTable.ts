// The shared agent table (agents.json), read by the Rust core via include_str! and by
// the front end through this module. One row per coding agent holds the facts that
// used to be scattered: names, launch and resume commands, status app, hook shell.

import table from './agents.json';

/** Declared by hand because a JSON import widens every id to string. */
export type AgentId = 'claude' | 'codex' | 'copilot';

export type Platform = 'windows' | 'posix';

/** One string for every platform, or a per-platform pair. */
export type PlatformCommand = string | { windows: string; posix: string };

export interface AgentRow {
  id: AgentId;
  name: string;
  preview: boolean;
  home: { dir: string; env: string | null; detectMarker: string | null };
  process: { executables: string[]; nodeMarker: string | null };
  /** The `app` value the agent sends in OSC 7501 reports, or null. */
  statusApp: string | null;
  launch: PlatformCommand;
  /** Offered in the Launch menu's "<agent> on a local model" submenu. */
  localModels: boolean;
  resume: {
    /** Template with an {id} placeholder. */
    command: PlatformCommand;
    /** Appended when a non-default permission mode is saved; {mode} placeholder. */
    modeArg: string | null;
    /** Appended when a model is saved; {model} placeholder. */
    modelArg: string | null;
  };
  hookShell: { windows: 'cmd' | 'powershell'; posix: string };
}

const ROWS = table as AgentRow[];

export const AGENT_IDS: readonly AgentId[] = ROWS.map((r) => r.id);

export function isAgentId(v: unknown): v is AgentId {
  return typeof v === 'string' && (AGENT_IDS as readonly string[]).includes(v);
}

export function agentRow(id: AgentId): AgentRow {
  const row = ROWS.find((r) => r.id === id);
  if (!row) throw new Error(`unknown agent id: ${id}`);
  return row;
}

export function agentName(id: AgentId): string {
  return agentRow(id).name;
}

export function isPreviewAgent(id: AgentId): boolean {
  return agentRow(id).preview;
}

export function agentForStatusApp(app: string): AgentId | null {
  return ROWS.find((r) => r.statusApp === app)?.id ?? null;
}

export function platformCommand(cmd: PlatformCommand, platform: Platform): string {
  return typeof cmd === 'string' ? cmd : cmd[platform];
}

export function launchCommand(id: AgentId, platform: Platform): string {
  return platformCommand(agentRow(id).launch, platform);
}

/** Callers validate the session id, mode, and model; nothing is escaped here. */
export function resumeCommandFor(
  id: AgentId,
  sessionId: string,
  opts: { mode?: string; model?: string },
  platform: Platform,
): string {
  const { resume } = agentRow(id);
  const parts = [platformCommand(resume.command, platform).replace('{id}', sessionId)];
  if (opts.mode && resume.modeArg) parts.push(resume.modeArg.replace('{mode}', opts.mode));
  if (opts.model && resume.modelArg) parts.push(resume.modelArg.replace('{model}', opts.model));
  return parts.join(' ');
}
