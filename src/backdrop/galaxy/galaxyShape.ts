// The Galaxy style's disc in its own frame: x and z span the disc, y is its thickness
// (docs/design/backdrop.md section 6.6). Pure, so seeding, baking, and tests share one shape.
import { fbm2 } from './galaxyNoise';

/** Disc radius in world units; the camera's home distance is tuned against it. */
export const GALAXY_RADIUS = 45;
export const ARMS = 3;
/** Radians an arm turns per unit of radius. Positive, so arms trail while the disc spins toward negative angles. */
export const WIND = 0.07;
/** Winding of the swirl's streaks; tighter than the arms, so they read as the disc's own flow. */
const SWIRL_WIND = 0.13;
/** Spiral strands the swirl is drawn from; many, so no few of them read as arms. */
const SWIRL_STRANDS = 9;

const TAU = Math.PI * 2;
const SWIRL_SEED = 53;
const DUST_SEED = 71;

/** Angle of an arm's spine at radius `r`. */
export function armAngle(arm: number, r: number): number {
  return (arm / ARMS) * TAU + r * WIND;
}

/** Angular half-width of an arm at radius `r`; arms are fuller toward the core. */
export function armSpread(r: number): number {
  return 0.3 + 0.35 * (1 - Math.min(1, r / GALAXY_RADIUS));
}

/** Signed angle from (x, z) to the nearest arm's spine, -pi/ARMS..pi/ARMS. */
export function armOffset(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const theta = Math.atan2(z, x);
  const sector = TAU / ARMS;
  let d = (theta - r * WIND) % sector;
  if (d < 0) d += sector;
  return d > sector / 2 ? d - sector : d;
}

/** 0..1 closeness to the nearest arm's spine, broad enough to only hint at the arms. */
export function armProfile(x: number, z: number): number {
  const off = armOffset(x, z) / armSpread(Math.hypot(x, z));
  return Math.exp(-off * off);
}

/**
 * Noise sampled with the disc unwound by SWIRL_WIND, so each blob of it shears into a short
 * streak along the spiral's pitch once wound back.
 */
function swirlNoise(x: number, z: number, scale: number, octaves: number, seed: number): number {
  const a = -Math.hypot(x, z) * SWIRL_WIND;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return fbm2((x * c - z * s) * scale, (x * s + z * c) * scale, octaves, seed);
}

/**
 * 0..1 density of the swirling streaks that fill the whole disc: SWIRL_STRANDS thin spiral strands
 * whose phase noise wiggles and breaks them into fragments. Built on a sine rather than a threshold
 * of the noise, so every ring of the disc averages the same density and the light stays even.
 */
export function swirlAt(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const phase = SWIRL_STRANDS * (Math.atan2(z, x) - r * SWIRL_WIND) + 11 * swirlNoise(x, z, 0.05, 3, SWIRL_SEED);
  const strand = 0.5 + 0.5 * Math.sin(phase);
  const breaks = smoothstep(0.3, 0.7, swirlNoise(x, z, 0.12, 2, SWIRL_SEED + 1));
  return smoothstep(0.25, 0.95, strand) * (0.3 + 0.7 * breaks);
}

/** 0..1 dust in thin swirling lanes across the disc, absent from the core and the rim. */
export function dustAt(x: number, z: number): number {
  const rr = Math.hypot(x, z) / GALAXY_RADIUS;
  if (rr < 0.1 || rr > 1.05) return 0;
  const ridge = 1 - Math.abs(2 * swirlNoise(x, z, 0.06, 3, DUST_SEED) - 1);
  const window = smoothstep(0.1, 0.25, rr) * (1 - smoothstep(0.75, 1.05, rr));
  return Math.min(1, smoothstep(0.93, 0.99, ridge) * window * (0.55 + 0.45 * armProfile(x, z)));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
