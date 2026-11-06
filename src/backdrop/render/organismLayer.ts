import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Points,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Organism } from '../sim/simulation';
import { HUSK_GENERATIONS, Stage } from '../sim/stages';
import { organismColor } from './palette';
import { staggerOf } from './stagger';
import { organismFragment, organismVertex } from './shaders/organism';

const MAX_ORGANISMS = 12000;

/** World-space sprite size per stage; the sprite includes the halo, so it is larger than the body. */
const SIZE = [1.0, 1.8, 2.9, 4.4, 3.2, 0.9];
const GLOW = [0.9, 1.0, 1.1, 1.45, 0.6, 0.2];

interface Visual {
  /** Sim stage the visual is easing toward; trails the sim by this organism's stagger. */
  shown: Stage;
  /** Seconds until `shown` catches up with the sim stage. */
  switchIn: number;
  /** Generations spent visibly as a husk, advancing continuously rather than per tick. */
  huskAge: number;
  stage: number;
  husk: number;
  size: number;
  glow: number;
  color: Color;
  phase: number;
  /** Seconds since visibly born (negative while its stagger delay runs), for the grow-in and thread glow. */
  born: number;
}

const target = new Color();

export class OrganismLayer {
  readonly points: Points;
  private readonly visuals = new Map<number, Visual>();
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position = new Float32Array(MAX_ORGANISMS * 3);
  private readonly color = new Float32Array(MAX_ORGANISMS * 3);
  private readonly size = new Float32Array(MAX_ORGANISMS);
  private readonly glow = new Float32Array(MAX_ORGANISMS);
  private readonly stage = new Float32Array(MAX_ORGANISMS);
  private readonly husk = new Float32Array(MAX_ORGANISMS);
  private readonly phase = new Float32Array(MAX_ORGANISMS);

  constructor() {
    this.geometry.setAttribute('position', new BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.color, 3));
    this.geometry.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.geometry.setAttribute('aGlow', new BufferAttribute(this.glow, 1));
    this.geometry.setAttribute('aStage', new BufferAttribute(this.stage, 1));
    this.geometry.setAttribute('aHusk', new BufferAttribute(this.husk, 1));
    this.geometry.setAttribute('aPhase', new BufferAttribute(this.phase, 1));
    // Positions change every frame; a fixed bound avoids recomputing it.
    this.geometry.boundingSphere = new Sphere(new Vector3(), 400);

    this.material = new ShaderMaterial({
      vertexShader: organismVertex,
      fragmentShader: organismFragment,
      uniforms: { uTime: { value: 0 }, uViewportHeight: { value: 1 }, uDensityGain: { value: 1 } },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  setViewportHeight(px: number): void {
    this.material.uniforms.uViewportHeight.value = px;
  }

  visualOf(id: number): { born: number } | undefined {
    return this.visuals.get(id);
  }

  forget(id: number): void {
    this.visuals.delete(id);
  }

  clear(): void {
    this.visuals.clear();
  }

  /**
   * @param genSeconds Real-time length of a generation at the current speed.
   * @param running False while paused, so husks hold still instead of dissolving.
   */
  update(organisms: Organism[], dt: number, time: number, genSeconds: number, running: boolean): void {
    this.material.uniforms.uTime.value = time;
    const ease = 1 - Math.exp(-dt * 2.4);
    const colorEase = 1 - Math.exp(-dt * 2);
    const count = Math.min(organisms.length, MAX_ORGANISMS);

    for (let i = 0; i < count; i++) {
      const o = organisms[i];
      let v = this.visuals.get(o.id);
      if (!v) {
        const delay = staggerOf(o.id) * genSeconds;
        v = {
          shown: o.stage,
          switchIn: 0,
          huskAge: 0,
          stage: o.stage === Stage.Husk ? 0 : o.stage,
          husk: 0,
          size: 0,
          glow: 0,
          color: organismColor(o.genome.hue, o.stage, new Color()),
          phase: (o.id * 0.6180339887) % 1,
          born: -delay,
        };
        this.visuals.set(o.id, v);
      }

      if (o.stage !== v.shown) {
        if (v.switchIn <= 0) v.switchIn = staggerOf(o.id) * genSeconds;
        v.switchIn -= dt;
        if (v.switchIn <= 0) v.shown = o.stage;
      }
      v.born += dt;

      const shown = v.shown;
      const isHusk = shown === Stage.Husk;
      if (isHusk && running) v.huskAge += dt / genSeconds;
      const visible = v.born >= 0 ? 1 : 0;
      v.stage += ((isHusk ? v.stage : shown) - v.stage) * ease;
      v.husk += ((isHusk ? 1 : 0) - v.husk) * ease;
      v.size += (SIZE[shown] * visible - v.size) * ease;
      // Fully dark a generation before the sim removes the husk, so it never pops out.
      const dissolve = isHusk ? Math.max(0, 1 - v.huskAge / (HUSK_GENERATIONS - 1)) : 1;
      v.glow += (GLOW[shown] * dissolve * visible - v.glow) * ease;
      v.color.lerp(organismColor(o.genome.hue, shown, target), colorEase);

      this.position[i * 3] = o.x;
      this.position[i * 3 + 1] = o.y;
      this.position[i * 3 + 2] = o.z;
      this.color[i * 3] = v.color.r;
      this.color[i * 3 + 1] = v.color.g;
      this.color[i * 3 + 2] = v.color.b;
      this.size[i] = v.size;
      this.glow[i] = v.glow;
      this.stage[i] = v.stage;
      this.husk[i] = v.husk;
      this.phase[i] = v.phase;
    }

    // Thousands of additive halos sum to a white fog, so the crowd dims as it grows.
    const gain = Math.min(1.3, Math.pow(260 / Math.max(1, count), 0.5));
    const uniform = this.material.uniforms.uDensityGain;
    uniform.value += (gain - uniform.value) * colorEase;

    this.geometry.setDrawRange(0, count);
    for (const name of ['position', 'aColor', 'aSize', 'aGlow', 'aStage', 'aHusk', 'aPhase']) {
      const attr = this.geometry.getAttribute(name) as BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, count * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}
