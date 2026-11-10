/**
 * Agent glow and border lights (docs/design/sessions.md section 4.23): a breathing glow inside
 * panes where an AI agent is working, and a comet of light that loops each pane in the gutter
 * around it. Each has an on/off setting; every look-and-feel number lives here. No DOM.
 */
export const PANE_LIGHTS = {
  /** Comet speed along a pane's loop. Constant in pixels, so larger panes take longer laps. */
  speedPxPerSec: 60,
  /** Loop length each comet gets: a pane runs one comet per this many pixels, and at least one. */
  pxPerComet: 1000,
  /**
   * How far past the halfway point between two counts a loop must grow or shrink before its count
   * changes, so dragging a divider near the boundary doesn't make a comet flicker in and out.
   */
  countHysteresis: 0.15,
  tailPx: 60,
  /** 0 to 1; scales the comet and the glow together. */
  intensity: 0.3,
  /** One full glow breath, dim to bright and back. */
  breathSeconds: 7,
  /** The glow's opacity at the bottom and top of a breath, before intensity. */
  glowLow: 0.25,
  glowHigh: 1,
  /** Outward from the pane's edge: half the 4px divider, so the loop runs down the gutter's middle. */
  gutterOffsetPx: 2,
  lineWidthPx: 1.6,
  headRadiusPx: 9,
  /** How fast a comet fades in or out when attention narrows or widens the lit panes. */
  fadePerSec: 4,
  /** Spacing of the tail's drawn steps; smaller is smoother and costs more draws. */
  tailStepPx: 3,
  maxFps: 30,
} as const;

export interface LoopRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TailPoint {
  x: number;
  y: number;
  /** Distance back from the head along the loop. */
  back: number;
}

/** The loop a pane's comet runs: its rect pushed out into the gutter. */
export function loopRect(r: { left: number; top: number; width: number; height: number }, offset: number): LoopRect {
  return { x: r.left - offset, y: r.top - offset, w: r.width + offset * 2, h: r.height + offset * 2 };
}

export function perimeter(r: LoopRect): number {
  return 2 * (Math.max(0, r.w) + Math.max(0, r.h));
}

/** The point `d` along the loop, clockwise from the top-left corner; `d` wraps. */
export function pointAt(r: LoopRect, d: number): { x: number; y: number } {
  const p = perimeter(r);
  if (p === 0) return { x: r.x, y: r.y };
  let t = ((d % p) + p) % p;
  if (t <= r.w) return { x: r.x + t, y: r.y };
  t -= r.w;
  if (t <= r.h) return { x: r.x + r.w, y: r.y + t };
  t -= r.h;
  if (t <= r.w) return { x: r.x + r.w - t, y: r.y + r.h };
  t -= r.w;
  return { x: r.x, y: r.y + r.h - t };
}

/**
 * Points from the head back along the tail, `step` apart, ending exactly at the tail's end. The
 * tail never exceeds the loop, so a tiny pane does not draw over its own head.
 */
export function tailPoints(r: LoopRect, head: number, tail: number, step: number): TailPoint[] {
  const len = Math.min(tail, perimeter(r));
  const out: TailPoint[] = [];
  for (let back = 0; back < len; back += step) out.push({ ...pointAt(r, head - back), back });
  out.push({ ...pointAt(r, head - len), back: len });
  return out;
}

/** Tail opacity at `back` pixels behind the head, before the comet's own fade. */
export function tailAlpha(back: number, tail: number, intensity: number): number {
  const fade = Math.max(0, 1 - back / tail);
  return 0.75 * fade * fade * (0.35 + intensity);
}

/** Every pane on screen is lit, unless some need attention; then only those are. */
export function litPanes(onScreen: Iterable<string>, attention: ReadonlySet<string>): Set<string> {
  const all = [...onScreen];
  const wanting = all.filter((id) => attention.has(id));
  return new Set(wanting.length ? wanting : all);
}


/** How many comets a loop of `p` pixels runs, given how many it runs now. */
export function cometCount(p: number, pxPerComet: number, current: number, hysteresis: number): number {
  const ideal = p / pxPerComet;
  if (current >= 1 && Math.abs(ideal - current) < 0.5 + hysteresis) return current;
  return Math.max(1, Math.round(ideal));
}

/** Where a new comet goes: the middle of the widest gap between the existing ones. */
export function widestGapMidpoint(dists: readonly number[], p: number): number {
  if (dists.length === 0) return 0;
  const sorted = [...dists].map((d) => ((d % p) + p) % p).sort((a, b) => a - b);
  let best = 0;
  let mid = 0;
  for (let i = 0; i < sorted.length; i++) {
    const from = sorted[i];
    const gap = i + 1 < sorted.length ? sorted[i + 1] - from : sorted[0] + p - from;
    if (gap > best) {
      best = gap;
      mid = from + gap / 2;
    }
  }
  return mid % p;
}

/**
 * Which comet to retire: the one with its neighbors closest on both sides, so the ones left stay
 * as evenly spaced as they can. Returns an index into `dists`.
 */
export function mostCrowded(dists: readonly number[], p: number): number {
  if (dists.length < 3) return dists.length - 1;
  const order = dists.map((d, i) => ({ d: ((d % p) + p) % p, i })).sort((a, b) => a.d - b.d);
  const n = order.length;
  let best = Infinity;
  let pick = order[0].i;
  for (let k = 0; k < n; k++) {
    const prev = order[(k + n - 1) % n].d;
    const next = order[(k + 1) % n].d;
    const span = (((next - prev) % p) + p) % p;
    if (span < best) {
      best = span;
      pick = order[k].i;
    }
  }
  return pick;
}
