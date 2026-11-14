// The tab switch transition's motion (docs/design/workspace.md section 4.30): the outgoing
// panes recede and fade, the incoming panes rise into place. No DOM, so it is unit-tested.

export interface TransitionLeg {
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

export interface TransitionPlan {
  outgoing: TransitionLeg;
  incoming: TransitionLeg;
}

/** How far a receding or rising pane sits behind the screen, as a scale. */
export const DEPTH_SCALE = 0.93;
export const DEPTH_BLUR_PX = 6;
export const OUT_MS = 240;
export const IN_MS = 320;
/** The incoming panes start once the outgoing ones are partly gone, so the two do not read as one blur. */
export const IN_DELAY_MS = 60;
export const REDUCED_MS = 150;

const AT_REST: Keyframe = { opacity: 1, transform: 'none', filter: 'none' };
const AT_DEPTH: Keyframe = { opacity: 0, transform: `scale(${DEPTH_SCALE})`, filter: `blur(${DEPTH_BLUR_PX}px)` };

/** Reduced motion keeps only a short crossfade: no scaling and no blur. */
export function transitionPlan(reducedMotion: boolean): TransitionPlan {
  if (reducedMotion) {
    return {
      outgoing: { keyframes: [{ opacity: 1 }, { opacity: 0 }], options: { duration: REDUCED_MS, easing: 'linear', fill: 'forwards' } },
      incoming: { keyframes: [{ opacity: 0 }, { opacity: 1 }], options: { duration: REDUCED_MS, easing: 'linear', fill: 'backwards' } },
    };
  }
  return {
    outgoing: {
      keyframes: [AT_REST, AT_DEPTH],
      options: { duration: OUT_MS, easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'forwards' },
    },
    incoming: {
      keyframes: [AT_DEPTH, AT_REST],
      // Backwards fill holds the panes at depth through the delay instead of flashing them at rest.
      options: { duration: IN_MS, delay: IN_DELAY_MS, easing: 'cubic-bezier(0, 0, 0.2, 1)', fill: 'backwards' },
    },
  };
}

/** How long a transition runs, start to the last incoming pane at rest. */
export function transitionMs(plan: TransitionPlan): number {
  const end = (leg: TransitionLeg): number => Number(leg.options.delay ?? 0) + Number(leg.options.duration ?? 0);
  return Math.max(end(plan.outgoing), end(plan.incoming));
}
