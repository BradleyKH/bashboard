import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial, Sphere, Vector3 } from 'three';
import { GALAXY_RADIUS } from './galaxyShape';
import { seedStars, starGain } from './galaxyStars';
import { starFragment, starVertex } from './galaxyShaders';
import type { GalaxyUniforms } from './galaxyUniforms';

/** The disc's stars as one point cloud; the vertex shader turns, recolors, and sizes them. */
export class StarLayer {
  readonly points: Points;
  private readonly material: ShaderMaterial;
  private count = 0;

  constructor(shared: GalaxyUniforms) {
    this.material = new ShaderMaterial({
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: { ...shared, uCoreSpin: { value: 0 }, uViewportHeight: { value: 1 }, uGain: { value: 1 } },
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.points = new Points(new BufferGeometry(), this.material);
    this.points.frustumCulled = false;
  }

  setViewportHeight(px: number): void {
    this.material.uniforms.uViewportHeight.value = px;
  }

  setCoreSpin(radians: number): void {
    this.material.uniforms.uCoreSpin.value = radians;
  }

  /** Reseeds only when the count changes; the first stars keep their places either way. */
  setCount(count: number): void {
    if (count === this.count) return;
    this.count = count;
    const field = seedStars(count);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(field.position, 3));
    geometry.setAttribute('aHue', new BufferAttribute(field.hue, 1));
    geometry.setAttribute('aShade', new BufferAttribute(field.shade, 3));
    geometry.setAttribute('aTint', new BufferAttribute(field.tint, 3));
    geometry.setAttribute('aSize', new BufferAttribute(field.size, 1));
    geometry.setAttribute('aBright', new BufferAttribute(field.brightness, 1));
    geometry.setAttribute('aSwirl', new BufferAttribute(field.swirl, 1));
    geometry.boundingSphere = new Sphere(new Vector3(), GALAXY_RADIUS * 1.2);
    this.points.geometry.dispose();
    this.points.geometry = geometry;
    // Each star dims in proportion as the count grows, so Density changes how fine the field is,
    // not how bright: the disc's total light, and so the readability of panes over it, stays put.
    this.material.uniforms.uGain.value = starGain(count);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
