// Textures the Galaxy style bakes once at mount, so its gas and sky cost a texture lookup per frame
// rather than per-pixel noise (docs/design/backdrop.md section 6.6). Pure: each returns RGBA bytes.
import { createRng } from '../sim/rng';
import { fbm2, fbm3, noise2 } from './galaxyNoise';
import { GALAXY_RADIUS, armProfile, dustAt, smoothstep, swirlAt } from './galaxyShape';

/** Half-width of the square the gas plate covers, past the rim so the gas fades out before its edge. */
export const GAS_EXTENT = GALAXY_RADIUS * 1.3;

/**
 * The gas plate over the disc, row-major with row 0 at z = -GAS_EXTENT. R is glowing gas along the
 * swirl, G the dust lanes that dim it, B the pink star-forming clumps.
 */
export function bakeGas(size: number): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    const z = ((j + 0.5) / size) * 2 * GAS_EXTENT - GAS_EXTENT;
    for (let i = 0; i < size; i++) {
      const x = ((i + 0.5) / size) * 2 * GAS_EXTENT - GAS_EXTENT;
      const r = Math.hypot(x, z);
      const rr = r / GALAXY_RADIUS;
      // Mostly the swirl, with a share of the arms so the gas hints at them too.
      const swirl = swirlAt(x, z);
      const arm = armProfile(x, z);
      const flow = 0.45 * swirl + 0.15 * arm;
      const window = smoothstep(0.04, 0.15, rr) * (1 - smoothstep(0.85, 1.2, rr));
      const clouds = fbm2(x * 0.09, z * 0.09, 4, 11);
      // A faint haze under the whole disc and a little past its rim, so the gaps between streaks
      // are never much darker than the streaks and the far side fades gradually into the sky.
      const haze = 0.15 * clouds * (1 - smoothstep(0.95, 1.28, rr));
      const emission = flow * (0.6 + 0.4 * smoothstep(0.3, 0.7, clouds)) * window + haze;
      const clumps = swirl * swirl * arm * window * Math.pow(noise2(x * 0.32, z * 0.32, 23), 8) * 1.5;
      const o = (j * size + i) * 4;
      out[o] = Math.round(Math.min(1, emission) * 255);
      out[o + 1] = Math.round(dustAt(x, z) * 255);
      out[o + 2] = Math.round(Math.min(1, clumps) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Normal of the sky's bright band, tilted off the disc so the band never lines up with it. */
const BAND_NORMAL = (() => {
  const [x, y, z] = [0.35, 1, 0.2];
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
})();

/**
 * An equirectangular sky, row 0 at the bottom pole. R is a faint band of distant light, G violet
 * wisps of far nebulae.
 */
export function bakeSky(width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let j = 0; j < height; j++) {
    const lat = ((j + 0.5) / height - 0.5) * Math.PI;
    for (let i = 0; i < width; i++) {
      const lon = ((i + 0.5) / width - 0.5) * Math.PI * 2;
      const dx = Math.cos(lat) * Math.cos(lon);
      const dy = Math.sin(lat);
      const dz = Math.cos(lat) * Math.sin(lon);
      const across = (dx * BAND_NORMAL[0] + dy * BAND_NORMAL[1] + dz * BAND_NORMAL[2]) * 3.2;
      const band = Math.exp(-across * across);
      const clouds = fbm3(dx * 2.2, dy * 2.2, dz * 2.2, 4, 31);
      const wisps = smoothstep(0.5, 0.85, fbm3(dx * 3.1 + 7, dy * 3.1, dz * 3.1, 4, 47));
      const o = (j * width + i) * 4;
      out[o] = Math.round(band * smoothstep(0.3, 0.8, clouds) * 255);
      out[o + 1] = Math.round(Math.min(1, wisps * (0.3 + band)) * 255);
      out[o + 2] = 0;
      out[o + 3] = 255;
    }
  }
  return out;
}

export interface SkyStars {
  count: number;
  /** Unit directions. */
  direction: Float32Array;
  /** sRGB. */
  color: Float32Array;
  brightness: Float32Array;
}

/** Distant stars, fixed on the sky, mostly faint, pale versions of the disc's blue-greens. */
export function seedSkyStars(count: number): SkyStars {
  const rng = createRng(0x51c7);
  const stars: SkyStars = {
    count,
    direction: new Float32Array(count * 3),
    color: new Float32Array(count * 3),
    brightness: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const y = rng() * 2 - 1;
    const theta = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - y * y);
    stars.direction.set([s * Math.cos(theta), y, s * Math.sin(theta)], i * 3);
    const pale = 0.65 + rng() * 0.35;
    const tone = rng();
    stars.color.set([pale * (0.75 + 0.25 * tone), pale * 0.92, pale], i * 3);
    stars.brightness[i] = 0.15 + Math.pow(rng(), 6) * 1.2;
  }
  return stars;
}
