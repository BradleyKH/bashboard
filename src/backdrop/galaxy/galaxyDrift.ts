// How `backdrop.mutationRate` ("Color drift") moves the Galaxy style's hues (docs/design/backdrop.md
// section 6.6). 0 holds them still.

/** Hue offset the color drift reaches at `mutationRate`; 4, the slider's top, wanders the full wheel. */
export function wanderAmplitude(mutationRate: number): number {
  return 0.5 * Math.sqrt(Math.max(0, mutationRate) / 4);
}

/** How fast the drift field moves, in radians of its phase per second. */
export function wanderSpeed(mutationRate: number): number {
  return 0.05 * Math.sqrt(Math.max(0, mutationRate));
}
