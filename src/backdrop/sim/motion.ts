import type { Organism } from './simulation';
import { SpatialHash } from './spatialHash';
import { Stage } from './stages';

/** Radius of the habitable volume; organisms beyond it are eased back in. */
export const WORLD_RADIUS = 52;

const FLOW_SCALE = 0.065;
const FLOW_SPEED = 1.6;
const SEPARATION_RADIUS = 1.4;
const SEPARATION_FORCE = 6;
const HUSK_SINK = 1.4;

/** How strongly each stage rides the current; spores disperse, blooms hold station. */
const DRIFT = [1.7, 1.15, 0.8, 0.45, 0.6, 0.35];

/**
 * Moves organisms through a time-varying Arnold-Beltrami-Childress flow. ABC
 * flow is divergence-free and chaotic, so colonies get drawn out into the
 * long streamers you see in real plankton blooms instead of clumping.
 */
export class Motion {
  private readonly hash = new SpatialHash<Organism>(SEPARATION_RADIUS);

  step(organisms: Organism[], dt: number, time: number): void {
    this.hash.rebuild(organisms);
    const relax = 1 - Math.exp(-dt * 1.4);
    const k = FLOW_SCALE;
    const pa = time * 0.05;
    const pb = time * 0.037;
    const sep2 = SEPARATION_RADIUS * SEPARATION_RADIUS;

    for (const o of organisms) {
      const drift = DRIFT[o.stage] * FLOW_SPEED;
      let fx = Math.sin(o.z * k + pa) + 0.8 * Math.cos(o.y * k - pb);
      let fy = 0.9 * Math.sin(o.x * k + pb) + Math.cos(o.z * k + pa);
      let fz = 0.8 * Math.sin(o.y * k - pb) + 0.9 * Math.cos(o.x * k + pb);
      fx *= drift;
      fy *= drift;
      fz *= drift;
      if (o.stage === Stage.Husk) fy -= HUSK_SINK;

      o.vx += (fx - o.vx) * relax;
      o.vy += (fy - o.vy) * relax;
      o.vz += (fz - o.vz) * relax;

      if (o.stage !== Stage.Husk) {
        this.hash.forEachNear(o.x, o.y, o.z, (n) => {
          if (n === o || n.stage === Stage.Husk) return;
          const dx = o.x - n.x;
          const dy = o.y - n.y;
          const dz = o.z - n.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= sep2 || d2 < 1e-6) return;
          const push = ((1 - Math.sqrt(d2) / SEPARATION_RADIUS) * SEPARATION_FORCE * dt) / Math.sqrt(d2);
          o.vx += dx * push;
          o.vy += dy * push;
          o.vz += dz * push;
        });
      }

      const r = Math.hypot(o.x, o.y, o.z);
      if (r > WORLD_RADIUS) {
        const pull = ((r - WORLD_RADIUS) * 0.8 * dt) / r;
        o.vx -= o.x * pull;
        o.vy -= o.y * pull;
        o.vz -= o.z * pull;
      }

      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.z += o.vz * dt;
    }
  }
}
