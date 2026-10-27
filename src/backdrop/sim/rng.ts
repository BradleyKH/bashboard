export type Rng = () => number;

/** Small seedable PRNG (mulberry32) so runs and tests are reproducible. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximately normal sample, mean 0, standard deviation ~1. */
export function gaussian(rng: Rng): number {
  return (rng() + rng() + rng() + rng() - 2) * 1.7320508;
}

export function randomUnitVector(rng: Rng): [number, number, number] {
  const z = rng() * 2 - 1;
  const theta = rng() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(theta), r * Math.sin(theta), z];
}
