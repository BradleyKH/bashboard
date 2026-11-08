// Strokes Wave figures on a 2D canvas, for the dashboard's Wave (docs/design/dashboard.md
// section 4.6) and the Lissajous backdrop (docs/design/backdrop.md section 6.7).
import type { WaveFigure, WavePoint } from './waveModel';

/** The canvas in CSS pixels, the scale the figure draws at, and the margin kept clear at each edge. */
export interface WaveBox {
  w: number;
  h: number;
  scale: number;
  inset: number;
}

/** How the lines are stroked. */
export interface WaveLook {
  /** The main line's width on its nearest side; the far side draws at about a third of it. */
  lineWidth: number;
  echoWidth: number;
  /** The nearest echo's opacity at full weight; each one behind it fades by an equal step. */
  echoAlpha: number;
  /** The color at a share 0..1 along the line, or one color for all of it. */
  color: string | ((along: number) => string);
}

/** Points an echo strokes as one path when its color changes along the line. */
const ECHO_CHUNK = 24;

export function drawWave(ctx: CanvasRenderingContext2D, box: WaveBox, figures: readonly WaveFigure[], look: WaveLook): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (typeof look.color === 'string') ctx.strokeStyle = look.color;
  for (const f of figures) {
    const count = f.echoes.length;
    // Farthest first, so the nearer copies draw over it.
    for (let k = count - 1; k >= 0; k--) {
      strokeEcho(ctx, box, f.echoes[k], look, (look.echoAlpha * f.weight * (count - k)) / count);
    }
    // Each segment is its own translucent stroke, so round caps would overlap at every joint and
    // bead the line; the segments are short enough that butt ends meet without a visible gap.
    ctx.lineCap = 'butt';
    strokeDepth(ctx, box, f.main, look, f.weight);
    ctx.lineCap = 'round';
  }
  ctx.globalAlpha = 1;
}

function strokeEcho(ctx: CanvasRenderingContext2D, box: WaveBox, pts: WavePoint[], look: WaveLook, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.lineWidth = look.echoWidth;
  const color = look.color;
  const step = typeof color === 'string' ? pts.length : ECHO_CHUNK;
  for (let start = 0; start < pts.length - 1; start += step) {
    const end = Math.min(pts.length - 1, start + step);
    if (typeof color !== 'string') ctx.strokeStyle = color((start + end) / 2 / (pts.length - 1));
    ctx.beginPath();
    for (let i = start; i <= end; i++) {
      const [px, py] = place(box, pts[i]);
      if (i === start) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

/** The main line, stroked a segment at a time so its near side draws brighter and thicker. */
function strokeDepth(ctx: CanvasRenderingContext2D, box: WaveBox, pts: WavePoint[], look: WaveLook, weight: number): void {
  const color = look.color;
  let [x0, y0] = place(box, pts[0]);
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = place(box, pts[i]);
    const near = (1 - (pts[i - 1][2] + pts[i][2]) / 2) / 2;
    ctx.globalAlpha = weight * (0.15 + 0.8 * near);
    ctx.lineWidth = look.lineWidth * (0.32 + 0.68 * near);
    if (typeof color !== 'string') ctx.strokeStyle = color((i - 0.5) / (pts.length - 1));
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    x0 = x1;
    y0 = y1;
  }
}

/** A figure point in canvas pixels. */
function place(box: WaveBox, [x, y]: WavePoint): [number, number] {
  const rx = box.w / 2 - box.inset;
  const ry = box.h / 2 - box.inset;
  return [box.w / 2 + x * box.scale * rx, box.h / 2 + y * box.scale * ry];
}
