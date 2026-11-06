import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentId } from './savedWorkspace';

export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'unknown';

/** A coding agent session; mirrors the Rust roster payload (docs/design/data.md section 7). */
export interface Session {
  sessionId: string;
  pid: number;
  name: string | null;
  cwd: string;
  status: SessionStatus;
  /** Present only when status is 'unknown'. */
  rawStatus?: string;
  /** Epoch ms. */
  statusChangedAt: number;
  /** Epoch ms. */
  startedAt: number;
  version: string | null;
  /** Pty id of the pane running the session, or null for sessions outside this app. */
  paneId: number | null;
  /** The `Notification` message, present only while `status` is 'waiting'. */
  waitingReason: string | null;
  /** The newest permission mode a hook reported; absent for a session that sent none. */
  permissionMode?: string;
  /** 'claude' for a session read from Claude Code's session file; others come from hooks alone. */
  agent: AgentId;
}

/** A Claude Code hook event; mirrors `HookEvent` in the Rust core (`paneId` is the pty id). */
export interface HookEvent {
  sessionId: string;
  hookEventName: string;
  cwd: string | null;
  message: string | null;
  /** Claude Code's notice kind on `Notification` (e.g. 'permission_prompt'), else null. */
  notificationType: string | null;
  paneId: number | null;
  /** Epoch ms. */
  at: number;
}

export function loadSessions(): Promise<Session[]> {
  return invoke<Session[]>('sessions_get');
}

export function onSessionsChanged(cb: (sessions: Session[]) => void): Promise<UnlistenFn> {
  return listen<Session[]>('sessions://changed', (e) => cb(e.payload));
}

export function onHookEvent(cb: (ev: HookEvent) => void): Promise<UnlistenFn> {
  return listen<HookEvent>('sessions://hook', (e) => cb(e.payload));
}
