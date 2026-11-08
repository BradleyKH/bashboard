import { boundSession } from './dashboardModel';
import { DoneTracker } from './doneStatus';
import type { CommandEvent } from './pane';
import type { PtyActivity } from './persistence';
import type { AgentId } from './savedWorkspace';
import type { HookEvent, Session } from './sessions';
import { applyActivity } from './sweepTracker';
import {
  shellStatus,
  terminalStatus,
  waitingText,
  type OscShellState,
  type ShellStatus,
  type SweepState,
  type TerminalStatus,
} from './terminalStatus';

/** The parts of a terminal pane that session and status tracking read. */
export interface SessionTerminal {
  readonly ptyId: number | null;
  oscState(): OscShellState;
}

/** A terminal's agent session as the saved workspace records it. */
export interface SavedSession {
  sessionId: string;
  permissionMode?: string;
  agent?: AgentId;
  resumeModel?: string;
}

/**
 * The workspace's per-terminal session and status bookkeeping (docs/design/sessions.md section
 * 4.7, docs/design/terminal.md section 4.8): the core's session list, shell activity sweeps,
 * sessions carried over from the saved workspace, and the unseen `done` marks. No DOM.
 */
export class WorkspaceSessions {
  private list: Session[] = [];
  /** Keyed by pty id. */
  private sweeps = new Map<number, SweepState>();
  /** Sessions from the restored workspace, kept until a session binds to the pane. */
  private readonly restored = new Map<string, SavedSession>();
  /** Newest model per session id, fed from appEvents.ts; only Copilot's resume needs it. */
  private readonly models = new Map<string, string>();
  private readonly done = new DoneTracker();

  get sessions(): Session[] {
    return this.list;
  }

  setSessions(sessions: Session[]): void {
    this.list = sessions;
  }

  bound(ptyId: number | null): Session | null {
    return boundSession(ptyId, this.list);
  }

  /** Drops the pane's restored session once a live one has bound to it. */
  settle(paneId: string, ptyId: number | null): void {
    if (this.bound(ptyId)) this.restored.delete(paneId);
  }

  restore(paneId: string, session: SavedSession): void {
    this.restored.set(paneId, session);
  }

  /** The bound session, or the restored one while nothing has bound yet. */
  saved(paneId: string, ptyId: number | null): { sessionId: string | null } & Omit<SavedSession, 'sessionId'> {
    const bound = this.bound(ptyId);
    const s = bound ?? this.restored.get(paneId);
    if (!s) return { sessionId: null };
    const agent = s.agent ?? 'claude';
    // Copilot drops the model on resume, so keep the newest one seen; a restored pane that has
    // not heard a fresh model keeps the one it was saved with.
    const model = agent === 'copilot' ? (this.models.get(s.sessionId) ?? ('resumeModel' in s ? s.resumeModel : undefined)) : undefined;
    return {
      sessionId: s.sessionId,
      ...(s.permissionMode !== undefined && { permissionMode: s.permissionMode }),
      ...(agent !== 'claude' && { agent }),
      ...(model && { resumeModel: model }),
    };
  }

  /** Records a session's newest model (from the agent context stream) for the next save. */
  setModel(sessionId: string, model: string | null): void {
    if (model) this.models.set(sessionId, model);
  }

  /** Folds in an activity sweep; true when any pty's busy state changed. */
  applyActivity(list: PtyActivity[], now: number): boolean {
    const { next, changed } = applyActivity(this.sweeps, list, now);
    this.sweeps = next;
    return changed;
  }

  shellOf(pane: SessionTerminal, openedAt: number): ShellStatus {
    const sweep = pane.ptyId === null ? null : (this.sweeps.get(pane.ptyId) ?? null);
    return shellStatus(pane.oscState(), sweep, openedAt);
  }

  resolve(paneId: string, pane: SessionTerminal | undefined, openedAt: number): { status: TerminalStatus; changedAt: number } {
    if (!pane) return { status: 'idle', changedAt: 0 };
    const session = this.bound(pane.ptyId);
    return this.done.resolve(paneId, session, terminalStatus(session, this.shellOf(pane, openedAt)));
  }

  waitingReason(pane: SessionTerminal | undefined): string {
    return waitingText(pane ? this.bound(pane.ptyId)?.waitingReason : null);
  }

  /** Design 4.8: a long command that ends unseen marks the terminal `done` or `failed`. */
  onCommand(paneId: string, ev: CommandEvent, seen: boolean, minSeconds: number): void {
    if (ev.kind === 'start') {
      this.done.commandStarted(paneId);
      return;
    }
    this.done.markCommand(paneId, {
      durationMs: ev.durationMs,
      exitCode: ev.exitCode,
      at: Date.now(),
      seen,
      minSeconds,
    });
  }

  /**
   * Design 4.8: an unseen `Stop` for a terminal's bound session shows `done` on it. `byPty` is the
   * pane running the event's pty, when it names one; else the terminal bound to its session gets
   * it. Returns the marked pane, or null when nothing changed.
   */
  onHook(
    ev: HookEvent,
    byPty: string | null,
    terminals: Iterable<[string, SessionTerminal]>,
    isSeen: (paneId: string) => boolean,
  ): string | null {
    if (ev.hookEventName !== 'Stop') return null;
    let match = byPty;
    if (!match) {
      for (const [id, pane] of terminals) {
        if (this.bound(pane.ptyId)?.sessionId === ev.sessionId) {
          match = id;
          break;
        }
      }
    }
    if (!match || !this.done.mark(match, ev.sessionId, ev.at, isSeen(match))) return null;
    return match;
  }

  /** Design 4.8: `done` lasts until the terminal is the one being looked at; true when cleared. */
  clearDone(paneId: string): boolean {
    return this.done.clear(paneId);
  }

  forget(paneId: string): void {
    this.restored.delete(paneId);
    this.done.forget(paneId);
  }
}
