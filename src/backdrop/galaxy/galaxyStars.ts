// Seeds the Galaxy style's fixed starfield (docs/design/backdrop.md section 6.6). Each star draws
// from its own index-seeded generator, so raising the count adds stars without moving the others.
import { createRng, gaussian } from '../sim/rng';
import { STAGES, Stage } from '../sim/stages';
import { ARMS, GALAXY_RADIUS, armAngle, armProfile, armSpread, dustAt, smoothstep, swirlAt } from './galaxyShape';

const SEED = 0x5eed;

/** Where Swirling Lights' founders start on the hue wheel, the blue-green of bioluminescence. */
const HUE_LOW = 0.42;
const HUE_SPAN = 0.2;

/** Stars drawn per unit of `backdrop.capacity` ("Density"). */
export const STARS_PER_CAPACITY = 8;
/** Kept under the GPU-friendly ceiling even with capacity at its 5000 maximum. */
export const MAX_STARS = 40000;

export function starCountFor(capacity: number): number {
  return Math.min(MAX_STARS, Math.max(1, Math.round(capacity * STARS_PER_CAPACITY)));
}

/**
 * Per-star brightness for `count` stars, falling about as fast as the count rises so their summed
 * light holds steady. Slightly slower than 1/count, since the bloom lifts a few bright stars more
 * than many dim ones and a sparse field would otherwise read brighter than a dense one.
 */
export function starGain(count: number): number {
  return Math.pow(8000 / Math.max(1, count), 0.88);
}

export interface StarField {
  count: number;
  /** x, y, z in the disc's frame. */
  position: Float32Array;
  /** Base hue, 0..1, before the color drift wanders it. */
  hue: Float32Array;
  /** Saturation, lightness, and how far the tint overrides the hue, each 0..1. */
  shade: Float32Array;
  /** sRGB tint from Swirling Lights' stage colors. */
  tint: Float32Array;
  /** World-space sprite size. */
  size: Float32Array;
  brightness: Float32Array;
  /** 0..1 share of the core's extra swirl; 0 turns rigidly with the arms. */
  swirl: Float32Array;
}

function hexToRgb(css: string): [number, number, number] {
  const n = parseInt(css.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const TINTS = STAGES.map((s) => hexToRgb(s.css));

/** Placements a disc star tries before settling, so dense swirls win most of them. */
const DISC_TRIES = 12;

/**
 * Radius uniform by area out to `outer` (a share of the radius), so the disc's light is even from
 * the core to the rim; the backdrop sits behind text, and a hot core would make panes over it
 * harder to read than panes over the rim.
 */
function evenRadius(rng: () => number, inner: number, outer: number): number {
  return GALAXY_RADIUS * Math.sqrt(inner * inner + (outer * outer - inner * inner) * rng());
}

/** Dims the outer edge gently, so the disc ends softly without a dark ring around a bright middle. */
function rimFade(r: number): number {
  return 1 - 0.5 * smoothstep(0.8, 1.03, r / GALAXY_RADIUS);
}

interface Star {
  x: number;
  y: number;
  z: number;
  hue: number;
  sat: number;
  light: number;
  tintWeight: number;
  tint: Stage;
  size: number;
  brightness: number;
  swirl: number;
}

function seedStar(index: number): Star {
  const rng = createRng(SEED ^ Math.imul(index + 1, 0x9e3779b1));
  const R = GALAXY_RADIUS;
  const kind = rng();
  const hue = HUE_LOW + rng() * HUE_SPAN;

  if (kind < 0.015) {
    // The bulge: a small, pale, fast-swirling knot of old light, only a little brighter than the disc.
    const r = R * Math.min(0.2, Math.abs(gaussian(rng)) * 0.08);
    const theta = rng() * Math.PI * 2;
    const heat = 1 - r / (R * 0.2);
    return {
      x: Math.cos(theta) * r,
      y: gaussian(rng) * R * 0.045 * (0.4 + heat),
      z: Math.sin(theta) * r,
      hue,
      sat: 0.5,
      light: 0.72 + heat * 0.12,
      tintWeight: 0.6,
      tint: Stage.Spore,
      size: 0.5 + rng() * 0.5,
      brightness: 0.3 + heat * 0.15,
      swirl: heat,
    };
  }

  if (kind < 0.25) {
    // A loose scatter about each arm's spine, enough to hint at the arms through the swirl.
    const r = evenRadius(rng, 0.05, 1);
    const arm = Math.floor(rng() * ARMS);
    const theta = armAngle(arm, r) + gaussian(rng) * armSpread(r) * 0.9;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    const fade = rimFade(r);
    const dim = 1 - dustAt(x, z) * 0.8;
    // A few bright giants are what the bloom picks up, the way blooms stand out in Swirling Lights.
    const giant = rng() < 0.06;
    return {
      x,
      y: gaussian(rng) * (0.25 + 0.55 * (1 - r / R)),
      z,
      hue,
      sat: giant ? 1 : 0.85 + rng() * 0.1,
      light: giant ? 0.62 : 0.55 + rng() * 0.08,
      tintWeight: giant ? 0.4 : 0.12 + rng() * 0.13,
      tint: giant ? Stage.Bloom : rng() < 0.5 ? Stage.Larva : Stage.Adult,
      size: giant ? 1.1 + rng() * 0.6 : 0.4 + rng() * 0.45,
      brightness: (giant ? 1.5 : 0.55 + rng() * 0.35) * fade * dim,
      swirl: 0,
    };
  }

  // The swirl: most of the disc, crowding into streaks that wind with the spiral, a little
  // fuller near the arms.
  let x = 0;
  let z = 0;
  let r = 0;
  for (let tries = 0; tries < DISC_TRIES; tries++) {
    r = evenRadius(rng, 0, 1.03);
    const theta = rng() * Math.PI * 2;
    x = Math.cos(theta) * r;
    z = Math.sin(theta) * r;
    const swirl = swirlAt(x, z);
    const density = 0.03 + 0.72 * swirl * swirl + 0.25 * armProfile(x, z);
    if (rng() < density) break;
  }
  const fade = rimFade(r);
  const dim = 1 - dustAt(x, z) * 0.8;
  const y = gaussian(rng) * (0.4 + 0.7 * (1 - r / R));
  if (rng() < 0.3) {
    // Older, dimmer, violet like Swirling Lights' elders.
    return {
      x,
      y,
      z,
      hue,
      sat: 0.45,
      light: 0.55,
      tintWeight: 0.55,
      tint: Stage.Elder,
      size: 0.35 + rng() * 0.35,
      brightness: (0.3 + rng() * 0.2) * fade * dim,
      swirl: 0,
    };
  }
  const giant = rng() < 0.04;
  return {
    x,
    y,
    z,
    hue,
    sat: giant ? 1 : 0.8 + rng() * 0.12,
    light: giant ? 0.62 : 0.55 + rng() * 0.08,
    tintWeight: giant ? 0.4 : 0.12 + rng() * 0.13,
    tint: giant ? Stage.Bloom : rng() < 0.5 ? Stage.Larva : Stage.Adult,
    size: giant ? 1.1 + rng() * 0.6 : 0.4 + rng() * 0.4,
    brightness: (giant ? 1.4 : 0.45 + rng() * 0.35) * fade * dim,
    swirl: 0,
  };
}

export function seedStars(count: number): StarField {
  const field: StarField = {
    count,
    position: new Float32Array(count * 3),
    hue: new Float32Array(count),
    shade: new Float32Array(count * 3),
    tint: new Float32Array(count * 3),
    size: new Float32Array(count),
    brightness: new Float32Array(count),
    swirl: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const s = seedStar(i);
    field.position.set([s.x, s.y, s.z], i * 3);
    field.hue[i] = s.hue;
    field.shade.set([s.sat, s.light, s.tintWeight], i * 3);
    field.tint.set(TINTS[s.tint], i * 3);
    field.size[i] = s.size;
    field.brightness[i] = s.brightness;
    field.swirl[i] = s.swirl;
  }
  return field;
}
