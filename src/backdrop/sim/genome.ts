import { gaussian, type Rng } from './rng';

export interface Genome {
  /** Lineage color on the hue wheel, 0..1. Selectively neutral, so it drifts. */
  hue: number;
  /**
   * Life strategy, 0..1. Near 0 is hardy and sparing with offspring; near 1
   * is prolific and fragile. Selection on it is what makes the population
   * visibly evolve as crowding changes.
   */
  strategy: number;
}

export function randomFounderGenome(rng: Rng): Genome {
  // Founders start in the blue-green band real bioluminescence lives in.
  return { hue: 0.42 + rng() * 0.2, strategy: 0.35 + rng() * 0.3 };
}

export function mutate(parent: Genome, rate: number, rng: Rng): Genome {
  const hue = (parent.hue + gaussian(rng) * 0.02 * rate + 1) % 1;
  const strategy = Math.min(1, Math.max(0, parent.strategy + gaussian(rng) * 0.05 * rate));
  return { hue, strategy };
}

export function fertilityOf(g: Genome): number {
  return 0.55 + 0.9 * g.strategy;
}

export function fragilityOf(g: Genome): number {
  return 0.45 + 1.1 * g.strategy;
}
