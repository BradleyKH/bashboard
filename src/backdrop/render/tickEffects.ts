import { Color } from 'three';
import type { TickResult } from '../sim/simulation';
import type { OrganismLayer } from './organismLayer';
import { hueColor, organismColor } from './palette';
import type { SparkLayer } from './sparkLayer';
import { staggerOf } from './stagger';

const color = new Color();

/**
 * Turns one generation's births and deaths into light: faint motes at births,
 * falling ash, rising last breaths. Each fires on its organism's stagger, so a
 * generation's effects trickle out over the next generation instead of all at once.
 */
export function playTickEffects(
  result: TickResult,
  organisms: OrganismLayer,
  sparks: SparkLayer,
  genSeconds: number,
): void {
  // Big generations get fewer sparks per event so the screen stays readable.
  const busy = result.births.length + result.deaths.length > 260;

  for (const { child } of result.births) {
    sparks.emit({
      at: child,
      color: hueColor(child.genome.hue, color).clone().multiplyScalar(0.5),
      count: busy ? 1 : 3,
      speed: 2.5,
      life: 1.4,
      size: 0.3,
      delay: staggerOf(child.id) * genSeconds,
    });
  }

  for (const o of result.deaths) {
    const delay = staggerOf(o.id) * genSeconds;
    if (o.perished) {
      sparks.emit({
        at: o,
        color: organismColor(o.genome.hue, 0, color).clone().multiplyScalar(0.45),
        count: busy ? 1 : 3,
        speed: 1.2,
        life: 1.8,
        size: 0.3,
        buoyancy: -1.5,
        delay,
      });
    } else {
      sparks.emit({
        at: o,
        color: hueColor(o.genome.hue, color).clone().multiplyScalar(0.7),
        count: busy ? 1 : 2,
        speed: 0.6,
        life: 3,
        size: 0.4,
        buoyancy: 1.4,
        delay,
      });
    }
  }

  for (const o of result.removed) organisms.forget(o.id);
}
