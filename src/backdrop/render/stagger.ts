/**
 * Fraction of a generation (0..1) by which an organism's visible changes lag
 * the simulation. The sim updates everyone on the same frame; spreading the
 * visible changes over the following generation keeps the colony from pulsing
 * in lockstep. Derived from the id so births, sparks, and threads agree.
 */
export function staggerOf(id: number): number {
  return (id * 0.7548776662) % 1;
}
