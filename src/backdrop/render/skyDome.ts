import { BackSide, Mesh, ShaderMaterial, SphereGeometry } from 'three';

const vertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

const fragment = /* glsl */ `
uniform float uTime;
uniform float uTide;
varying vec3 vDir;

float caustic(vec2 p, float t) {
  float c = 0.0;
  c += pow(0.5 + 0.5 * sin(dot(p, vec2(1.0, 0.3)) * 3.1 + t * 0.7), 6.0);
  c += pow(0.5 + 0.5 * sin(dot(p, vec2(-0.6, 0.9)) * 3.7 - t * 0.6), 6.0);
  c += pow(0.5 + 0.5 * sin(dot(p, vec2(0.2, -1.0)) * 2.9 + t * 0.5), 6.0);
  return c / 3.0;
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;

  vec3 abyss = vec3(0.0, 0.002, 0.006);
  vec3 mid = vec3(0.004, 0.018, 0.032);
  vec3 surface = vec3(0.012, 0.07, 0.10);
  vec3 col = mix(abyss, mid, smoothstep(-0.8, 0.1, y));
  col = mix(col, surface, smoothstep(0.1, 1.0, y));

  // Faint caustic net and light shafts from a surface far above.
  vec2 p = d.xz / max(y + 0.35, 0.08) * 2.2;
  float net = caustic(p, uTime) * smoothstep(0.15, 0.9, y);
  float az = atan(d.z, d.x);
  float shafts = pow(0.5 + 0.5 * sin(az * 9.0 + sin(az * 3.0 + uTime * 0.07) * 2.0 + uTime * 0.05), 10.0);
  shafts *= smoothstep(-0.25, 0.85, y) * (0.6 + 0.4 * sin(uTime * 0.21 + az * 2.0));
  float light = net * 0.05 + shafts * 0.035;
  col += vec3(0.25, 0.75, 0.85) * light * (0.75 + uTide * 0.5);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** Sky-dome for the deep: an abyss gradient with caustics and god rays from above. */
export class SkyDome {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor() {
    this.material = new ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: { uTime: { value: 0 }, uTide: { value: 0.5 } },
      side: BackSide,
      depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(500, 48, 32), this.material);
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
  }

  /** @param tide 0 at low tide, 1 at high tide. */
  update(time: number, tide: number): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uTide.value = tide;
  }
}
