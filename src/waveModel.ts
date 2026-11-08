// The dashboard's Wave element: a looping figure shaped by machine load (docs/design/dashboard.md
// section 4.6), also drawn large as the Lissajous backdrop (docs/design/backdrop.md section 6.7).
// Pure, no DOM.

import type { SystemSample } from './systemModel';

/** Network rate that reads as full activity; the scale is logarithmic below it. */
const NET_FULL_BYTES_PER_SEC = 10 * 1024 * 1024;

/** The figure redraws at most this often while animating. */
export const WAVE_FPS = 20;

/** Seconds for an eased input to cover about two thirds of the way to a new reading. */
export const WAVE_EASE_SECONDS = 1;

/** Points along one drawing of the figure, enough to keep the densest step smooth. */
export const WAVE_POINTS = 480;

/**
 * Horizontal to vertical frequency, from idle to full load. Each step adds a lobe, so the weave
 * tightens steadily with load. Equal frequencies collapse to an ellipse, so no step repeats a
 * number.
 */
export const WAVE_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [1, 2],
  [3, 2],
  [3, 4],
  [5, 4],
];

/** The detune sweeps between 0 and this, added to each step's horizontal frequency. */
export const WAVE_DETUNE_MAX = 0.6;

/** Radians per second the figure tilts, always the same way: a full turn every 30 s. */
export const WAVE_TILT_SPEED = (Math.PI * 2) / 30;

/** How far the echo trails the main line in its spin, in radians. */
export const WAVE_ECHO_LAG = 0.18;

/** Share of the box the figure's widest point fills. */
const WAVE_FIT = 0.97;

/** Seconds for the fit to regrow most of the way after the figure narrows. */
const WAVE_FIT_REGROW_SECONDS = 6;

/** Perspective strength: the near side draws up to about this much larger. */
const PERSPECTIVE = 0.35;

/** Phase offset of the depth wave, so it does not peak with the vertical one. */
const DEPTH_OFFSET = 0.7;

/** Lowest memory share the detune sweep runs at, so an idle reading still moves it. */
const MEMORY_FLOOR = 0.08;

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

/** Memory in use as 0..1; an unknown total counts as empty. */
export function memLevel(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(1, Math.max(0, used / total));
}

/** A system sample as the readings the figure follows. */
export function waveReading(s: SystemSample): WaveReading {
  return {
    cpu: cpuLevel(s.cpuPercent),
    net: netLevel(s.netRxPerSec, s.netTxPerSec),
    mem: memLevel(s.memoryUsedBytes, s.memoryTotalBytes),
  };
}

/** Moves `current` toward `target` over `dt` seconds with exponential easing. */
export function ease(current: number, target: number, dt: number, tau = WAVE_EASE_SECONDS): number {
  if (dt <= 0) return current;
  return target + (current - target) * Math.exp(-dt / tau);
}

/** Radians per second the figure spins: a slow drift at rest, livelier with traffic. */
export function spinSpeed(net: number): number {
  return 0.075 + 0.33 * net;
}

/**
 * Radians per second of the detune sweep's own phase. One sweep from 0 to the maximum is half a
 * turn, so it takes 5 / memory seconds: 20 s at 25% memory, 5 s at 100%.
 */
export function detuneSpeed(mem: number): number {
  return (Math.PI * Math.max(MEMORY_FLOOR, Math.min(1, mem))) / 5;
}

/** The detune at sweep phase `theta`, easing at both ends of 0..`WAVE_DETUNE_MAX`. */
export function detuneAt(theta: number): number {
  return (WAVE_DETUNE_MAX / 2) * (1 - Math.cos(theta));
}

/** One figure on `WAVE_RATIOS` and the share of the line's opacity it takes. */
export interface WaveLayer {
  ratio: readonly [number, number];
  weight: number;
}

/**
 * Where CPU sits on `WAVE_RATIOS`: an idle machine draws a calm figure eight and a busy one a
 * tighter weave. Between two steps both figures draw whole and split the opacity, so every line on
 * screen is one figure rather than a blend of two.
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

/** How the figure sits in space: its detune, its spin about the vertical, and its tilt. */
export interface WavePose {
  detune: number;
  spin: number;
  tilt: number;
}

/** A projected point: screen x and y (before fitting), and depth in -1 (near) to 1 (far). */
export type WavePoint = [x: number, y: number, depth: number];

/**
 * One figure as `n` projected points. The flat Lissajous gains a depth wave at the vertical
 * frequency, spins about the vertical axis, tilts about the horizontal one, and is drawn in
 * perspective, so its near side is larger. The spin also turns the horizontal phase.
 */
export function wavePoints(ratio: readonly [number, number], pose: WavePose, n = WAVE_POINTS): WavePoint[] {
  const a = ratio[0] + pose.detune;
  const b = ratio[1];
  const cs = Math.cos(pose.spin);
  const sn = Math.sin(pose.spin);
  const ct = Math.cos(pose.tilt);
  const st = Math.sin(pose.tilt);
  const out: WavePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * Math.PI * 2;
    const x0 = Math.sin(a * t + pose.spin);
    const y0 = Math.sin(b * t);
    const z0 = Math.sin(b * t + DEPTH_OFFSET);
    const x = x0 * cs + z0 * sn;
    const z1 = -x0 * sn + z0 * cs;
    const y = y0 * ct - z1 * st;
    // Rotation keeps every point within √3 of the center, so depth stays in -1..1.
    const depth = (y0 * st + z1 * ct) / Math.sqrt(3);
    const p = 1 / (1 + depth * PERSPECTIVE);
    out.push([x * p, y * p, depth]);
  }
  return out;
}

/** The farthest any point reaches from the center on either axis. */
export function waveExtent(figures: ReadonlyArray<readonly WavePoint[]>): number {
  let max = 0;
  for (const pts of figures) {
    for (const [x, y] of pts) max = Math.max(max, Math.abs(x), Math.abs(y));
  }
  return max;
}

/**
 * The scale that keeps the figure inside the box. It shrinks at once when the figure would cross
 * an edge and regrows slowly when it narrows, so the zoom holds steady instead of pulsing with
 * the spin.
 */
export function waveFit(current: number | undefined, extent: number, dt: number): number {
  const need = WAVE_FIT / (extent > 0 ? extent : 1);
  if (current === undefined || need < current) return need;
  return need + (current - need) * Math.exp(-Math.max(0, dt) / WAVE_FIT_REGROW_SECONDS);
}

/** The load readings the figure follows, each 0..1. */
export interface WaveReading {
  cpu: number;
  net: number;
  mem: number;
}

/** The eased readings and the angles they drive; advanced by `stepWave`. */
export interface WaveMotion extends WaveReading {
  spin: number;
  tilt: number;
  detunePhase: number;
}

/** The figure at rest: idle readings and a slight tilt, so it opens as a figure eight seen at an angle. */
export function restingWave(): WaveMotion {
  return { cpu: 0, net: 0, mem: 0, spin: 0, tilt: 0.4, detunePhase: 0 };
}

/**
 * Eases `m` toward `target` over `dt` seconds and turns its angles. `pace` scales the spin, tilt,
 * and detune sweep together, never the easing, so a slower figure still follows load as promptly.
 */
export function stepWave(m: WaveMotion, target: WaveReading, dt: number, pace = 1): void {
  m.cpu = ease(m.cpu, target.cpu, dt);
  m.net = ease(m.net, target.net, dt);
  m.mem = ease(m.mem, target.mem, dt);
  const turn = Math.PI * 2;
  m.spin = (m.spin + spinSpeed(m.net) * pace * dt) % turn;
  m.tilt = (m.tilt + WAVE_TILT_SPEED * pace * dt) % turn;
  m.detunePhase = (m.detunePhase + detuneSpeed(m.mem) * pace * dt) % turn;
}

/** Jumps straight to `target`, for a still figure that redraws on each reading. */
export function settleWave(m: WaveMotion, target: WaveReading): void {
  m.cpu = target.cpu;
  m.net = target.net;
  m.mem = target.mem;
}

/** One figure on the ladder: its main line, the faint copies trailing it in the spin, and its opacity share. */
export interface WaveFigure {
  weight: number;
  main: WavePoint[];
  /** Nearest first; each trails the one before by `echoLag` more radians of spin. */
  echoes: WavePoint[][];
}

/** Every figure `m` draws, each with `echoes` trailing copies, `n` points to a line. */
export function waveFigures(m: WaveMotion, echoes: number, echoLag: number, n = WAVE_POINTS): WaveFigure[] {
  const detune = detuneAt(m.detunePhase);
  return waveLayers(m.cpu).map(({ ratio, weight }) => ({
    weight,
    main: wavePoints(ratio, { detune, spin: m.spin, tilt: m.tilt }, n),
    echoes: Array.from({ length: echoes }, (_, k) =>
      wavePoints(ratio, { detune, spin: m.spin - echoLag * (k + 1), tilt: m.tilt }, n),
    ),
  }));
}

/** Every line of `figures`, for `waveExtent`. */
export function figureLines(figures: readonly WaveFigure[]): WavePoint[][] {
  return figures.flatMap((f) => [f.main, ...f.echoes]);
}
