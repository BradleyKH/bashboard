// Each organism is a single point sprite whose form is drawn procedurally.
// aStage is a continuous 0..4 value eased toward the sim stage, so forms
// morph (a membrane grows in, petals unfurl, the core hollows) rather than pop.

export const organismVertex = /* glsl */ `
uniform float uTime;
uniform float uViewportHeight;
uniform float uDensityGain;

attribute vec3 aColor;
attribute float aSize;
attribute float aGlow;
attribute float aStage;
attribute float aHusk;
attribute float aPhase;
attribute float aPulse;

varying vec3 vColor;
varying float vGlow;
varying float vRing;
varying float vPetal;
varying float vHollow;
varying float vHusk;
varying float vPhase;

void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;

  float breathe = 1.0 + 0.1 * sin(uTime * (1.2 + fract(aPhase * 7.0) * 0.9) + aPhase * 6.2831);
  float px = aSize * breathe * projectionMatrix[1][1] * uViewportHeight * 0.5 / -mv.z;
  gl_PointSize = clamp(px, 0.0, 256.0);

  float s = aStage;
  vRing = smoothstep(1.1, 2.0, s) * (1.0 - smoothstep(3.3, 4.0, s));
  vPetal = smoothstep(2.2, 3.0, s) * (1.0 - smoothstep(3.5, 4.0, s));
  vHollow = smoothstep(3.3, 4.0, s);
  vHusk = aHusk;

  // Distant organisms dim, which reads as depth through murky water.
  float depth = clamp((-mv.z - 50.0) / 170.0, 0.0, 1.0);
  vGlow = aGlow * uDensityGain * (1.0 - depth * 0.7) * smoothstep(0.6, 3.0, px);
  // Organisms brushing the lens would be huge soft blobs; let them slip out of view instead.
  vGlow *= smoothstep(3.0, 12.0, -mv.z);
  vGlow *= 1.0 + aPulse * (1.0 - aHusk) * 0.8 * (0.5 + 0.5 * sin(uTime * 3.0));
  vColor = aColor;
  vPhase = aPhase;
}
`;

export const organismFragment = /* glsl */ `
uniform float uTime;

varying vec3 vColor;
varying float vGlow;
varying float vRing;
varying float vPetal;
varying float vHollow;
varying float vHusk;
varying float vPhase;

float band(float r, float center, float width) {
  float d = (r - center) / width;
  return exp(-d * d);
}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r = length(uv);
  if (r > 1.0) discard;
  float a = atan(uv.y, uv.x);
  float spin = uTime * 0.45 + vPhase * 6.2831;

  float halo = exp(-r * r * 6.0) * 0.2 + exp(-r * 9.0) * 0.14;
  float core = exp(-r * r * 70.0) * (1.0 - vHollow * 0.85);
  float body = exp(-r * r * 16.0) * 0.45 * (1.0 - vHollow * 0.7);

  float wobble = 0.03 * sin(a * 5.0 + uTime * 1.3 + vPhase * 6.2831);
  float ring = vRing * band(r, 0.4 + wobble, 0.045) * 0.85;

  float lobes = pow(max(0.0, cos(a * 5.0 + spin)), 5.0);
  float veins = pow(max(0.0, cos(a * 5.0 + spin)), 60.0) * smoothstep(0.95, 0.2, r);
  float petals = vPetal * (lobes * smoothstep(0.95, 0.5, r) * smoothstep(0.15, 0.38, r) * 0.75 + veins * 0.8);

  float shell = vHollow * band(r, 0.3 + 0.02 * sin(uTime * 0.8 + vPhase * 9.0), 0.07) * 0.65;

  float intensity = core * 2.4 + body + halo + ring + petals + shell;
  intensity = mix(intensity, exp(-r * r * 22.0) * 0.9 + halo * 0.25, vHusk);
  intensity *= smoothstep(1.0, 0.75, r) * vGlow;

  vec3 color = mix(vColor, vec3(1.0), clamp(core * 0.5, 0.0, 1.0) * (1.0 - vHusk));
  gl_FragColor = vec4(color * intensity, 1.0);
}
`;
