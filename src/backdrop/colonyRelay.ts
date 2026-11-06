import type { ColonyLike } from '../colonySync';

type Mood = Parameters<ColonyLike['setMood']>[1];

/**
 * Stands in for the colony across backdrop style switches (docs/design/backdrop.md section 6.2).
 * ColonySync only reports changes, so a colony mounted after sessions already exist would never
 * hear of them; the relay remembers each live session and replays it into a newly attached one.
 */
export class ColonyRelay implements ColonyLike {
  private readonly sessions = new Map<string, { hue: number; mood?: Mood }>();
  private target: ColonyLike | undefined;

  attach(target: ColonyLike): void {
    this.target = target;
    for (const [id, { hue, mood }] of this.sessions) {
      target.ensure(id, hue);
      if (mood !== undefined) target.setMood(id, mood);
    }
  }

  detach(): void {
    this.target = undefined;
  }

  ensure(sessionId: string, hue: number): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.hue = hue;
    else this.sessions.set(sessionId, { hue });
    this.target?.ensure(sessionId, hue);
  }

  setMood(sessionId: string, mood: Mood): void {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.mood = mood;
    this.target?.setMood(sessionId, mood);
  }

  release(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.target?.release(sessionId);
  }
}
