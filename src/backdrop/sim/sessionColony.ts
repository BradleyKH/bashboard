import { WORLD_RADIUS } from './motion';
import { randomUnitVector, type Rng } from './rng';
import type { Organism, Simulation } from './simulation';
import { Stage } from './stages';

export type SessionMood = 'busy' | 'idle' | 'waiting';

export interface SessionColony {
  ensure(sessionId: string, hue: number): void;
  setMood(sessionId: string, mood: SessionMood): void;
  release(sessionId: string): void;
}

const BUSY_FERTILITY = 1.8;
const IDLE_FERTILITY = 0.35;
const FOUNDER_STRATEGY = 0.5;
const OFFSET_MIN = 4;
const OFFSET_SPAN = 4;
const DRIFT_SPEED = 3;
/** Keeps a founder off the rim, where Motion would immediately push it back. */
const MAX_FOUNDING_RADIUS = WORLD_RADIUS - 4;

interface SessionEntry {
  lineage: number;
  hue: number;
  mood: SessionMood;
}

/**
 * Gives each live session its own blight-immune lineage in the sim
 * (docs/design.md sections 6.2 and 6.3).
 */
export class SimSessionColony implements SessionColony {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly sim: Simulation,
    private readonly rng: Rng = Math.random,
  ) {}

  ensure(sessionId: string, hue: number): void {
    if (this.sessions.has(sessionId)) return;
    const founder = this.plant(hue);
    this.sim.lineageTraits.set(founder.lineage, { fertility: IDLE_FERTILITY, hue });
    this.sessions.set(sessionId, { lineage: founder.lineage, hue, mood: 'idle' });
  }

  setMood(sessionId: string, mood: SessionMood): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    entry.mood = mood;
    if (mood === 'waiting') return;
    const traits = this.sim.lineageTraits.get(entry.lineage);
    if (traits) traits.fertility = mood === 'busy' ? BUSY_FERTILITY : IDLE_FERTILITY;
  }

  release(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sim.lineageTraits.delete(entry.lineage);
    this.sessions.delete(sessionId);
  }

  /** Re-founds session lineages with no living organisms; call after every sim.tick(). */
  afterTick(): void {
    if (this.sessions.size === 0) return;
    const alive = new Set<number>();
    for (const o of this.sim.organisms) if (o.stage !== Stage.Husk) alive.add(o.lineage);
    for (const entry of this.sessions.values()) {
      if (alive.has(entry.lineage)) continue;
      const traits = this.sim.lineageTraits.get(entry.lineage) ?? { fertility: IDLE_FERTILITY, hue: entry.hue };
      const founder = this.plant(entry.hue);
      this.sim.lineageTraits.delete(entry.lineage);
      this.sim.lineageTraits.set(founder.lineage, traits);
      entry.lineage = founder.lineage;
    }
  }

  /** Lineage numbers whose session is waiting, for the render-level pulse. */
  pulsingLineages(): ReadonlySet<number> {
    const out = new Set<number>();
    for (const entry of this.sessions.values()) if (entry.mood === 'waiting') out.add(entry.lineage);
    return out;
  }

  /** Founds a spore a short way off the living colony's centroid, drifting toward it. */
  private plant(hue: number): Organism {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;
    for (const o of this.sim.organisms) {
      if (o.stage === Stage.Husk) continue;
      cx += o.x;
      cy += o.y;
      cz += o.z;
      n++;
    }
    if (n > 0) {
      cx /= n;
      cy /= n;
      cz /= n;
    }
    const [dx, dy, dz] = randomUnitVector(this.rng);
    const dist = OFFSET_MIN + this.rng() * OFFSET_SPAN;
    let x = cx + dx * dist;
    let y = cy + dy * dist;
    let z = cz + dz * dist;
    const r = Math.hypot(x, y, z);
    if (r > MAX_FOUNDING_RADIUS) {
      const s = MAX_FOUNDING_RADIUS / r;
      x *= s;
      y *= s;
      z *= s;
    }
    const founder = this.sim.found(x, y, z, { hue, strategy: FOUNDER_STRATEGY });
    const tx = cx - x;
    const ty = cy - y;
    const tz = cz - z;
    const len = Math.hypot(tx, ty, tz);
    if (len > 1e-6) {
      founder.vx = (tx / len) * DRIFT_SPEED;
      founder.vy = (ty / len) * DRIFT_SPEED;
      founder.vz = (tz / len) * DRIFT_SPEED;
    }
    return founder;
  }
}
