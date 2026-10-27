import { Color } from 'three';
import { STAGES, Stage } from '../sim/stages';

const STAGE_TINTS = STAGES.map((s) => new Color(s.css));

/** How much each stage's tint overrides the lineage hue; mid-life is mostly lineage color. */
const TINT_WEIGHT = [0.55, 0.25, 0.12, 0.4, 0.55, 0.85];
const SATURATION = [0.55, 0.85, 0.95, 1, 0.45, 0.2];
const LIGHTNESS = [0.75, 0.6, 0.55, 0.62, 0.55, 0.35];

const scratch = new Color();

/** Linear-space color for an organism of the given lineage hue at the given stage. */
export function organismColor(hue: number, stage: Stage, out: Color): Color {
  out.setHSL(hue, SATURATION[stage], LIGHTNESS[stage]);
  return out.lerp(STAGE_TINTS[stage], TINT_WEIGHT[stage]);
}

export function hueColor(hue: number, out = scratch): Color {
  return out.setHSL(hue, 0.9, 0.6);
}
