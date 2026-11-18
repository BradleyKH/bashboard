import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentId } from './agentTable';

/** A past or live coding agent session from the history index; mirrors the Rust `PastSession` payload. */
export interface PastSession {
  agent: AgentId;
  sessionId: string;
  cwd: string;
  /** False when the folder is gone (a deleted worktree, say). */
  cwdExists: boolean;
  /** Main repo root: a worktree resolves to the repo it belongs to. Null outside git. */
  repoRoot: string | null;
  branch: string | null;
  /** Never empty. */
  title: string;
  firstPrompt: string | null;
  lastPrompt: string | null;
  /** Epoch ms. */
  startedAt: number;
  /** Epoch ms. */
  updatedAt: number;
  permissionMode: string | null;
  model: string | null;
}

export function listSessionHistory(): Promise<PastSession[]> {
  return invoke<PastSession[]>('session_history_list');
}

/** The event carries the full list, not a delta. */
export function onSessionHistoryChanged(cb: (sessions: PastSession[]) => void): Promise<UnlistenFn> {
  return listen<PastSession[]>('history://changed', (e) => cb(e.payload));
}

/** Main repo root holding `cwd` (a worktree resolves to its main repo); null outside git. */
export function sessionRepoRoot(cwd: string): Promise<string | null> {
  return invoke<string | null>('session_history_repo_root', { cwd });
}
