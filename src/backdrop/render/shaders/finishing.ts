import { Vector2 } from 'three';

/** Final display-space pass: soft vignette, a touch of lens fringing at the edges, and film grain. */
export const finishingShader = {
  name: 'FinishingShader',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float edge = dot(c, c);
      vec2 shift = c * edge * 0.012;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + shift).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - shift).b;

      float vignette = smoothstep(0.85, 0.15, length(c * vec2(uResolution.x / uResolution.y, 1.0) * 0.9));
      col *= mix(0.35, 1.0, vignette);

      float grain = hash(vUv * uResolution + fract(uTime * 17.0) * 100.0) - 0.5;
      col += grain * 0.022;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};
