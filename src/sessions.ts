import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type SessionStatus = 'busy' | 'idle' | 'waiting' | 'unknown';

/** A Claude Code session; mirrors the Rust roster payload (docs/design.md section 7). */
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
