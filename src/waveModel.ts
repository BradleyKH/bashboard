// The dashboard's Wave element: a looping figure shaped by machine load (docs/design/dashboard.md
// section 4.6). Pure, no DOM.

/** Network rate that reads as full activity; the scale is logarithmic below it. */
const NET_FULL_BYTES_PER_SEC = 10 * 1024 * 1024;

/** The figure redraws at most this often while animating. */
export const WAVE_FPS = 20;

/** Seconds for an eased input to cover about two thirds of the way to a new reading. */
export const WAVE_EASE_SECONDS = 1.5;

/** Points along one drawing of the figure. */
export const WAVE_POINTS = 360;

/** CPU percent as 0..1; a missing reading counts as idle. */
export function cpuLevel(percent: number | null): number {
  if (percent === null || !Number.isFinite(percent)) return 0;
  return Math.min(1, Math.max(0, percent / 100));
}

/** Combined network rate as 0..1 on a log scale, so a trickle still shows and a download tops out. */
export function netLevel(rx: number | null, tx: number | null): number {
  const total = Math.max(0, rx ?? 0) + Math.max(0, tx ?? 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.log1p(total) / Math.log1p(NET_FULL_BYTES_PER_SEC));
}

/** Moves `current` toward `target` over `dt` seconds with exponential easing. */
export function ease(current: number, target: number, dt: number, tau = WAVE_EASE_SECONDS): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Radians per second the figure's phase turns: a slow drift at rest, livelier with traffic. */
export function phaseSpeed(net: number): number {
  return 0.25 + 1.1 * net;
}

/**
 * The figure as `n` points in -1..1. CPU sets the horizontal frequency against a fixed vertical
 * one, so an idle machine draws a calm loop and a busy one a tighter weave; `phase` turns it.
 */
export function wavePoints(cpu: number, phase: number, n = WAVE_POINTS): Array<[number, number]> {
  const a = 1 + 1.5 * cpu;
  const b = 2;
  const span = Math.PI * 2;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * span;
    out.push([Math.sin(a * t + phase), Math.sin(b * t)]);
  }
  return out;
}
