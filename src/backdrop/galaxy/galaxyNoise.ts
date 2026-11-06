// Seeded value noise for the Galaxy style's baked textures and star dimming (docs/design/backdrop.md
// section 6.6). Pure and deterministic, so the stars and the gas plate sample the same field.

function hash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 0..1 value noise on the integer lattice, smoothly interpolated. */
export function noise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const a = lerp(hash(xi, yi, 0, seed), hash(xi + 1, yi, 0, seed), u);
  const b = lerp(hash(xi, yi + 1, 0, seed), hash(xi + 1, yi + 1, 0, seed), u);
  return lerp(a, b, v);
}

export function noise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const u = smooth(x - xi);
  const v = smooth(y - yi);
  const w = smooth(z - zi);
  const plane = (zz: number): number =>
    lerp(
      lerp(hash(xi, yi, zz, seed), hash(xi + 1, yi, zz, seed), u),
      lerp(hash(xi, yi + 1, zz, seed), hash(xi + 1, yi + 1, zz, seed), u),
      v,
    );
  return lerp(plane(zi), plane(zi + 1), w);
}

/** Fractal sum of `octaves` layers of noise2, normalized to 0..1. */
export function fbm2(x: number, y: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2(x, y, seed + o);
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}

export function fbm3(x: number, y: number, z: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise3(x, y, z, seed + o);
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    z *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}
