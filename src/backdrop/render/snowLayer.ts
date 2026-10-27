import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Sphere, Vector3 } from 'three';

const COUNT = 6000;
const EXTENT = 130;

const vertex = /* glsl */ `
uniform float uTime;
uniform float uViewportHeight;
attribute float aSeed;
varying float vAlpha;
void main() {
  vec3 p = position;
  float fall = uTime * (0.6 + aSeed * 1.2);
  p.y = mod(p.y - fall + ${EXTENT.toFixed(1)}, ${(EXTENT * 2).toFixed(1)}) - ${EXTENT.toFixed(1)};
  p.x += sin(uTime * 0.3 + aSeed * 40.0) * 1.5;
  p.z += cos(uTime * 0.25 + aSeed * 31.0) * 1.5;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = (0.18 + aSeed * 0.3) * projectionMatrix[1][1] * uViewportHeight * 0.5 / -mv.z;
  gl_PointSize = max(px, 1.0);
  float depth = clamp(-mv.z / 260.0, 0.0, 1.0);
  float twinkle = 0.6 + 0.4 * sin(uTime * (0.5 + aSeed) + aSeed * 90.0);
  vAlpha = (1.0 - depth) * twinkle * min(1.0, px) * 0.35;
}
`;

const fragment = /* glsl */ `
varying float vAlpha;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vec3(0.55, 0.75, 0.9) * exp(-r2 * 3.0) * vAlpha, 1.0);
}
`;

/** Marine snow: drifting organic flecks that give the water depth and motion. Animated entirely on the GPU. */
export class SnowLayer {
  readonly points: Points;
  private readonly material: ShaderMaterial;

  constructor() {
    const position = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      position[i * 3] = (Math.random() * 2 - 1) * EXTENT;
      position[i * 3 + 1] = (Math.random() * 2 - 1) * EXTENT;
      position[i * 3 + 2] = (Math.random() * 2 - 1) * EXTENT;
      seed[i] = Math.random();
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(position, 3));
    geometry.setAttribute('aSeed', new BufferAttribute(seed, 1));
    geometry.boundingSphere = new Sphere(new Vector3(), EXTENT * 2);
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uTime: { value: 0 }, uViewportHeight: { value: 1 } },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  setViewportHeight(px: number): void {
    this.material.uniforms.uViewportHeight.value = px;
  }

  update(time: number): void {
    this.material.uniforms.uTime.value = time;
  }
}
