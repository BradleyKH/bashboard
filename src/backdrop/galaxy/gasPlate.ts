import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  Mesh,
  RGBAFormat,
  ShaderMaterial,
} from 'three';
import { STAGES, Stage } from '../sim/stages';
import { GAS_EXTENT, bakeGas } from './galaxyBake';
import { gasFragment, gasVertex } from './galaxyShaders';
import type { GalaxyUniforms } from './galaxyUniforms';

const SIZE = 512;
/** The arms' gas sits mid-band in Swirling Lights' blue-greens. */
const ARM_HUE = 0.52;

/** The baked gas and dust laid flat in the disc, plus the core's glow. */
export class GasPlate {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly texture: DataTexture;

  constructor(shared: GalaxyUniforms) {
    this.texture = new DataTexture(bakeGas(SIZE), SIZE, SIZE, RGBAFormat);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.needsUpdate = true;

    this.material = new ShaderMaterial({
      vertexShader: gasVertex,
      fragmentShader: gasFragment,
      uniforms: {
        ...shared,
        uGas: { value: this.texture },
        uArmHue: { value: ARM_HUE },
        // Color() converts these sRGB stage colors to the linear values the shader adds.
        uClumpColor: { value: new Color(STAGES[Stage.Bloom].css) },
        uCoreColor: { value: new Color(STAGES[Stage.Spore].css) },
        uGasGain: { value: 0.5 },
      },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(plate(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** A square in the disc's x-z plane, with uv rows following z to match the bake. */
function plate(): BufferGeometry {
  const e = GAS_EXTENT;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-e, 0, -e, e, 0, -e, e, 0, e, -e, 0, e]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  return geometry;
}
