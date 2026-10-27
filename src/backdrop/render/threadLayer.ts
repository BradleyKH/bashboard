import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  LineSegments,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import type { Organism } from '../sim/simulation';
import { Stage } from '../sim/stages';
import { hueColor } from './palette';

const MAX_THREADS = 12000;
/** Seconds a newborn's thread takes to brighten, then to settle back to the lineage glow. */
const GLOW_RISE = 0.6;
const GLOW_FALL = 3;

const vertex = /* glsl */ `
attribute vec3 aColor;
attribute float aAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = clamp((-mv.z - 50.0) / 170.0, 0.0, 1.0);
  vColor = aColor;
  vAlpha = aAlpha * (1.0 - depth * 0.7);
}
`;

const fragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(vColor * vAlpha, 1.0);
}
`;

/**
 * Glowing threads from each living organism to its living parent. A
 * newborn's thread brightens gently and settles; with lineage mode on, the
 * threads persist faintly so the colony reads as a family tree drifting in
 * the current.
 */
export class ThreadLayer {
  readonly lines: LineSegments;
  showLineage = false;
  private readonly geometry = new BufferGeometry();
  private readonly position = new Float32Array(MAX_THREADS * 6);
  private readonly color = new Float32Array(MAX_THREADS * 6);
  private readonly alpha = new Float32Array(MAX_THREADS * 2);
  private readonly byId = new Map<number, Organism>();

  constructor() {
    this.geometry.setAttribute('position', new BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.color, 3));
    this.geometry.setAttribute('aAlpha', new BufferAttribute(this.alpha, 1));
    this.geometry.boundingSphere = new Sphere(new Vector3(), 400);
    const material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
  }

  update(organisms: Organism[], ageOf: (id: number) => number): void {
    this.byId.clear();
    for (const o of organisms) if (o.stage !== Stage.Husk) this.byId.set(o.id, o);

    let n = 0;
    for (const child of organisms) {
      if (n >= MAX_THREADS) break;
      if (child.parentId === null || child.stage === Stage.Husk) continue;
      const parent = this.byId.get(child.parentId);
      if (!parent) continue;

      const age = ageOf(child.id);
      if (age < 0) continue;
      const rise = Math.min(1, age / GLOW_RISE);
      const fall = Math.max(0, 1 - age / GLOW_FALL);
      const glow = rise * rise * (3 - 2 * rise) * fall * fall;
      const base = (this.showLineage ? 0.16 : 0) * rise;
      const strength = base + glow * 0.3;
      if (strength < 0.01) continue;

      const c = hueColor(child.genome.hue);
      const p = n * 6;
      this.position[p] = parent.x;
      this.position[p + 1] = parent.y;
      this.position[p + 2] = parent.z;
      this.position[p + 3] = child.x;
      this.position[p + 4] = child.y;
      this.position[p + 5] = child.z;
      for (let k = 0; k < 2; k++) {
        this.color[p + k * 3] = c.r;
        this.color[p + k * 3 + 1] = c.g;
        this.color[p + k * 3 + 2] = c.b;
      }
      // Brighter at the child end, so the thread reads as flowing outward.
      this.alpha[n * 2] = strength * 0.25;
      this.alpha[n * 2 + 1] = strength;
      n++;
    }

    this.geometry.setDrawRange(0, n * 2);
    for (const name of ['position', 'aColor', 'aAlpha']) {
      const attr = this.geometry.getAttribute(name) as BufferAttribute;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * 2 * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}
