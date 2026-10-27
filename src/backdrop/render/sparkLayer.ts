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

const MAX_SPARKS = 10000;

const vertex = /* glsl */ `
uniform float uViewportHeight;
attribute vec3 aColor;
attribute float aLife;
attribute float aSize;
varying vec3 vColor;
varying float vLife;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / -mv.z, 0.0, 64.0);
  vColor = aColor;
  vLife = aLife;
}
`;

const fragment = /* glsl */ `
varying vec3 vColor;
varying float vLife;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float glow = exp(-r2 * 7.0) * vLife * vLife;
  gl_FragColor = vec4(mix(vColor, vec3(1.0), exp(-r2 * 40.0) * 0.6) * glow, 1.0);
}
`;

export interface SparkBurst {
  /** Read when the burst fires, so a delayed burst follows a drifting organism. */
  at: { x: number; y: number; z: number };
  color: Color;
  count: number;
  speed: number;
  life: number;
  size: number;
  /** Upward (positive) or downward drift added to every spark. */
  buoyancy?: number;
  /** Seconds to wait before the burst fires. */
  delay?: number;
}

/** Short-lived motes thrown off by births, deaths, and blights. */
export class SparkLayer {
  readonly points: Points;
  private readonly geometry = new BufferGeometry();
  private readonly material: ShaderMaterial;
  private readonly position = new Float32Array(MAX_SPARKS * 3);
  private readonly velocity = new Float32Array(MAX_SPARKS * 3);
  private readonly color = new Float32Array(MAX_SPARKS * 3);
  private readonly life = new Float32Array(MAX_SPARKS);
  private readonly maxLife = new Float32Array(MAX_SPARKS);
  private readonly size = new Float32Array(MAX_SPARKS);
  private readonly lifeOut = new Float32Array(MAX_SPARKS);
  private readonly buoyancy = new Float32Array(MAX_SPARKS);
  private cursor = 0;
  private pending: SparkBurst[] = [];

  constructor() {
    this.geometry.setAttribute('position', new BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aColor', new BufferAttribute(this.color, 3));
    this.geometry.setAttribute('aLife', new BufferAttribute(this.lifeOut, 1));
    this.geometry.setAttribute('aSize', new BufferAttribute(this.size, 1));
    this.geometry.boundingSphere = new Sphere(new Vector3(), 400);
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uViewportHeight: { value: 1 } },
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

  emit(b: SparkBurst): void {
    if (b.delay && b.delay > 0) {
      this.pending.push({ ...b });
      return;
    }
    const { x: ox, y: oy, z: oz } = b.at;
    for (let n = 0; n < b.count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_SPARKS;
      const z = Math.random() * 2 - 1;
      const t = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      const s = b.speed * (0.4 + Math.random() * 0.8);
      this.position[i * 3] = ox;
      this.position[i * 3 + 1] = oy;
      this.position[i * 3 + 2] = oz;
      this.velocity[i * 3] = r * Math.cos(t) * s;
      this.velocity[i * 3 + 1] = r * Math.sin(t) * s;
      this.velocity[i * 3 + 2] = z * s;
      this.color[i * 3] = b.color.r;
      this.color[i * 3 + 1] = b.color.g;
      this.color[i * 3 + 2] = b.color.b;
      const life = b.life * (0.6 + Math.random() * 0.6);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.size[i] = b.size * (0.6 + Math.random() * 0.8);
      this.buoyancy[i] = b.buoyancy ?? 0;
    }
  }

  clear(): void {
    this.pending = [];
    this.life.fill(0);
    this.lifeOut.fill(0);
  }

  update(dt: number): void {
    if (this.pending.length) {
      const waiting: SparkBurst[] = [];
      for (const b of this.pending) {
        b.delay! -= dt;
        if (b.delay! <= 0) this.emit({ ...b, delay: 0 });
        else waiting.push(b);
      }
      this.pending = waiting;
    }
    const drag = Math.exp(-dt * 2.2);
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.life[i] <= 0) {
        this.lifeOut[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.velocity[i * 3] *= drag;
      this.velocity[i * 3 + 1] = this.velocity[i * 3 + 1] * drag + this.buoyancy[i] * dt;
      this.velocity[i * 3 + 2] *= drag;
      this.position[i * 3] += this.velocity[i * 3] * dt;
      this.position[i * 3 + 1] += this.velocity[i * 3 + 1] * dt;
      this.position[i * 3 + 2] += this.velocity[i * 3 + 2] * dt;
      this.lifeOut[i] = Math.max(0, this.life[i] / this.maxLife[i]);
    }
    for (const name of ['position', 'aColor', 'aLife', 'aSize']) {
      (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
    }
  }
}
