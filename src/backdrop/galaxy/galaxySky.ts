import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  Points,
  RGBAFormat,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { STAGES, Stage } from '../sim/stages';
import { bakeSky, seedSkyStars } from './galaxyBake';
import { skyFragment, skyStarFragment, skyStarVertex, skyVertex } from './galaxyShaders';

const WIDTH = 512;
const HEIGHT = 256;
const STAR_COUNT = 2500;
const RADIUS = 500;

/** The far sky behind the disc: a baked band of distant light and a fixed scatter of faint stars. */
export class GalaxySky {
  /** Follows the camera, so the sky stays at infinity as the zoom changes. */
  readonly group = new Group();
  private readonly texture: DataTexture;
  private readonly domeMaterial: ShaderMaterial;
  private readonly starMaterial: ShaderMaterial;
  private readonly dome: Mesh;
  private readonly stars: Points;

  constructor() {
    this.texture = new DataTexture(bakeSky(WIDTH, HEIGHT), WIDTH, HEIGHT, RGBAFormat);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    // Repeats across the seam where longitude wraps, so filtering never shows a line there.
    this.texture.wrapS = RepeatWrapping;
    this.texture.needsUpdate = true;

    this.domeMaterial = new ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        uSky: { value: this.texture },
        uBandColor: { value: new Color(STAGES[Stage.Larva].css).multiplyScalar(0.03) },
        uWispColor: { value: new Color(STAGES[Stage.Elder].css).multiplyScalar(0.02) },
      },
      side: BackSide,
      depthWrite: false,
    });
    this.dome = new Mesh(new SphereGeometry(RADIUS, 48, 32), this.domeMaterial);
    this.dome.renderOrder = -2;
    this.dome.frustumCulled = false;

    const seeded = seedSkyStars(STAR_COUNT);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(seeded.direction.map((d) => d * RADIUS * 0.9), 3));
    geometry.setAttribute('aColor', new BufferAttribute(seeded.color, 3));
    geometry.setAttribute('aBright', new BufferAttribute(seeded.brightness, 1));
    this.starMaterial = new ShaderMaterial({
      vertexShader: skyStarVertex,
      fragmentShader: skyStarFragment,
      uniforms: { uPixelRatio: { value: 1 } },
      depthWrite: false,
    });
    this.stars = new Points(geometry, this.starMaterial);
    this.stars.renderOrder = -1;
    this.stars.frustumCulled = false;

    this.group.add(this.dome, this.stars);
  }

  setPixelRatio(ratio: number): void {
    this.starMaterial.uniforms.uPixelRatio.value = ratio;
  }

  dispose(): void {
    this.dome.geometry.dispose();
    this.stars.geometry.dispose();
    this.domeMaterial.dispose();
    this.starMaterial.dispose();
    this.texture.dispose();
  }
}
