import { sessionHue } from './sessionHue';
import type { Session, SessionStatus } from './sessions';

type Mood = 'busy' | 'idle' | 'waiting';

export interface ColonyLike {
  ensure(sessionId: string, hue: number): void;
  setMood(sessionId: string, mood: Mood): void;
  release(sessionId: string): void;
}

function moodFor(status: SessionStatus): Mood {
  return status === 'unknown' ? 'idle' : status;
}

/** Reconciles the session roster with the backdrop's colony (docs/design.md section 6.2). */
export class ColonySync {
  private readonly lastMood = new Map<string, Mood>();

  constructor(private readonly colony: ColonyLike) {}

  /** Ensures and sets the mood of every session in the list, and releases sessions no longer in it. */
  update(sessions: Session[]): void {
    const live = new Set<string>();
    for (const session of sessions) {
      const id = session.sessionId;
      live.add(id);
      const mood = moodFor(session.status);
      if (!this.lastMood.has(id)) {
        this.colony.ensure(id, sessionHue(session));
      }
      if (this.lastMood.get(id) !== mood) {
        this.colony.setMood(id, mood);
        this.lastMood.set(id, mood);
      }
    }
    for (const id of [...this.lastMood.keys()]) {
      if (!live.has(id)) {
        this.colony.release(id);
        this.lastMood.delete(id);
      }
    }
  }
}
