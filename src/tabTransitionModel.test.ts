import { describe, expect, it } from 'vitest';
import { IN_DELAY_MS, IN_MS, REDUCED_MS, transitionMs, transitionPlan } from './tabTransitionModel';

describe('transitionPlan', () => {
  it('recedes the outgoing panes and raises the incoming ones through the same depth', () => {
    const { outgoing, incoming } = transitionPlan(false);
    const last = (frames: Keyframe[]): Keyframe => frames[frames.length - 1];
    expect(last(outgoing.keyframes)).toEqual(incoming.keyframes[0]);
    expect(outgoing.keyframes[0]).toEqual(last(incoming.keyframes));
    expect(last(incoming.keyframes)).toMatchObject({ opacity: 1, transform: 'none', filter: 'none' });
  });

  it('holds the outgoing ghosts at the end and the incoming panes through the delay', () => {
    const plan = transitionPlan(false);
    expect(plan.outgoing.options.fill).toBe('forwards');
    expect(plan.incoming.options.fill).toBe('backwards');
  });

  it('keeps only a crossfade under reduced motion', () => {
    const plan = transitionPlan(true);
    for (const leg of [plan.outgoing, plan.incoming]) {
      for (const frame of leg.keyframes) expect(Object.keys(frame)).toEqual(['opacity']);
    }
    expect(transitionMs(plan)).toBe(REDUCED_MS);
  });
});

describe('transitionMs', () => {
  it('ends when the last incoming pane is at rest', () => {
    expect(transitionMs(transitionPlan(false))).toBe(IN_DELAY_MS + IN_MS);
  });
});
