// The dashboard's Wave element: a looping figure shaped by machine load (docs/design/dashboard.md
// section 4.6). Pure, no DOM.

/** Network rate that reads as full activity; the scale is logarithmic below it. */
const NET_FULL_BYTES_PER_SEC = 10 * 1024 * 1024;

/** The figure redraws at most this often while animating. */
export const WAVE_FPS = 20;

/** Seconds for an eased input to cover about two thirds of the way to a new reading. */
export const WAVE_EASE_SECONDS = 1.5;

/** Points along one drawing of the figure, enough to keep the densest step smooth. */
export const WAVE_POINTS = 480;

/**
 * Horizontal to vertical frequency, from idle to full load. Each pair is coprime, so the figure
 * closes over one 2π turn, and each step adds a lobe, so the weave tightens steadily with load.
 * Equal frequencies collapse to an ellipse, so no step repeats a number.
 */
export const WAVE_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [3, 2],
  [3, 4],
  [5, 4],
];

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

/** One figure on `WAVE_RATIOS` and the share of the line's opacity it takes. */
export interface WaveLayer {
  ratio: readonly [number, number];
  weight: number;
}

/**
 * Where CPU sits on `WAVE_RATIOS`: an idle machine draws a calm figure eight and a busy one a
 * tighter weave. Between two steps both figures draw whole and split the opacity, so every line on
 * screen is a closed figure rather than a blend of two.
 */
export function waveLayers(cpu: number): WaveLayer[] {
  const pos = Math.min(1, Math.max(0, cpu)) * (WAVE_RATIOS.length - 1);
  const lo = Math.floor(pos);
  const f = pos - lo;
  if (f === 0) return [{ ratio: WAVE_RATIOS[lo], weight: 1 }];
  return [
    { ratio: WAVE_RATIOS[lo], weight: 1 - f },
    { ratio: WAVE_RATIOS[lo + 1], weight: f },
  ];
}

/** One closed figure as `n` points in -1..1; `phase` turns it. */
export function wavePoints(ratio: readonly [number, number], phase: number, n = WAVE_POINTS): Array<[number, number]> {
  const [a, b] = ratio;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * Math.PI * 2;
    out.push([Math.sin(a * t + phase), Math.sin(b * t)]);
  }
  return out;
}
