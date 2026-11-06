// GLSL for the Galaxy style (docs/design/backdrop.md section 6.6). The stars and the gas plate share
// the rotation and color drift, so both read the same uniforms (galaxyUniforms.ts).
import { GALAXY_RADIUS } from './galaxyShape';

const common = /* glsl */ `
#define GALAXY_RADIUS ${GALAXY_RADIUS.toFixed(1)}

uniform float uTime;
/** Rotation of the arms, in radians. */
uniform float uSpin;
uniform float uWanderTime;
uniform float uWanderAmp;

vec3 hsl2rgb(float h, float s, float l) {
  vec3 rgb = clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
  return l + s * (rgb - 0.5) * (1.0 - abs(2.0 * l - 1.0));
}

vec3 toLinear(vec3 c) {
  return pow(max(c, vec3(0.0)), vec3(2.2));
}

/** -1..1 field that drifts across the disc over time, for the color drift. */
float wander(vec2 p, float t) {
  float w = sin(p.x * 0.045 + t) * 0.6
    + sin(p.y * 0.05 - t * 0.77 + 1.7) * 0.6
    + sin((p.x + p.y) * 0.03 + t * 0.53 + 4.1) * 0.5;
  return w / 1.7;
}

vec2 spin(vec2 p, float a) {
  float c = cos(a);
  float s = sin(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}
`;

export const starVertex = /* glsl */ `
${common}
uniform float uCoreSpin;
uniform float uViewportHeight;
uniform float uGain;

attribute float aHue;
attribute vec3 aShade;
attribute vec3 aTint;
attribute float aSize;
attribute float aBright;
attribute float aSwirl;

varying vec3 vColor;
varying float vGlow;

void main() {
  vec2 p = position.xz;

  float hue = fract(aHue + uWanderAmp * wander(p, uWanderTime) + 1.0);
  vColor = toLinear(mix(hsl2rgb(hue, aShade.x, aShade.y), aTint, aShade.z));

  vec2 turned = spin(p, uSpin + uCoreSpin * aSwirl);
  vec4 mv = modelViewMatrix * vec4(turned.x, position.y, turned.y, 1.0);
  gl_Position = projectionMatrix * mv;

  float px = aSize * projectionMatrix[1][1] * uViewportHeight * 0.5 / -mv.z;
  // Stars smaller than a pixel would shimmer as they cross pixel boundaries; hold the sprite at
  // 1.5 px and dim it by the area it lost instead.
  gl_PointSize = clamp(px, 1.5, 48.0);
  float area = min(1.0, (px * px) / 2.25);
  vGlow = aBright * uGain * (0.35 + 0.65 * area);
  // Stars brushing the lens would be huge soft blobs; let them slip out of view instead.
  vGlow *= smoothstep(2.0, 8.0, -mv.z);
}
`;

export const starFragment = /* glsl */ `
varying vec3 vColor;
varying float vGlow;

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 30.0);
  float intensity = core * 1.4 + exp(-r2 * 7.0) * 0.35 + exp(-r2 * 2.5) * 0.06;
  vec3 color = mix(vColor, vec3(1.0), core * 0.45);
  gl_FragColor = vec4(color * intensity * vGlow, 1.0);
}
`;

export const gasVertex = /* glsl */ `
${common}
varying vec2 vLocal;
varying vec2 vUv;

void main() {
  vLocal = position.xz;
  vUv = uv;
  vec2 turned = spin(position.xz, uSpin);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(turned.x, 0.0, turned.y, 1.0);
}
`;

export const gasFragment = /* glsl */ `
${common}
uniform sampler2D uGas;
uniform float uArmHue;
uniform vec3 uClumpColor;
uniform vec3 uCoreColor;
uniform float uGasGain;

varying vec2 vLocal;
varying vec2 vUv;

void main() {
  vec3 gas = texture2D(uGas, vUv).rgb;
  vec2 p = vLocal;
  float hue = fract(uArmHue + uWanderAmp * wander(p, uWanderTime) + 1.0);
  vec3 color = toLinear(hsl2rgb(hue, 0.75, 0.5)) * gas.r * 0.55 + uClumpColor * gas.b * 0.4;

  float rr = length(p) / GALAXY_RADIUS;
  color += uCoreColor * exp(-rr * rr * 60.0) * 0.06;

  color *= 1.0 - gas.g * 0.85;
  gl_FragColor = vec4(color * uGasGain, 1.0);
}
`;

export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

export const skyFragment = /* glsl */ `
uniform sampler2D uSky;
uniform vec3 uBandColor;
uniform vec3 uWispColor;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  vec2 uv = vec2(atan(d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415927 + 0.5);
  vec3 sky = texture2D(uSky, uv).rgb;
  vec3 color = vec3(0.0005, 0.001, 0.003) + uBandColor * sky.r + uWispColor * sky.g;
  gl_FragColor = vec4(color, 1.0);
}
`;

export const skyStarVertex = /* glsl */ `
attribute vec3 aColor;
attribute float aBright;
uniform float uPixelRatio;
varying vec3 vColor;

void main() {
  vColor = pow(aColor, vec3(2.2)) * aBright;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
  gl_PointSize = (1.2 + aBright) * uPixelRatio;
}
`;

export const skyStarFragment = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * exp(-r2 * 4.0), 1.0);
}
`;
