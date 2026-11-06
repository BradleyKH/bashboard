// The Galaxy style: a fixed swirl of stars over Swirling Lights' viewport and settings
// (docs/design/backdrop.md section 6.6).
import { Timer } from 'three';
import type { BackdropHandle, BackdropOptions } from '../backdrop';
import { FramePacer } from '../framePacer';
import { HOME_DISTANCE, Viewport } from '../render/viewport';
import { wanderAmplitude, wanderSpeed } from './galaxyDrift';
import { starCountFor } from './galaxyStars';
import { createGalaxyUniforms } from './galaxyUniforms';
import { GalaxySky } from './galaxySky';
import { GasPlate } from './gasPlate';
import { StarLayer } from './starLayer';

/** Radians per second. Negative, so the arms trail (galaxyShape.ts). */
const SPIN = -0.012;
/** The core's swirl on top of the arms' turn. */
const CORE_SPIN = -0.02;
/** Camera angle from straight above the disc, in radians, and its slow sway either side. */
const TILT = Math.PI / 4;
const TILT_SWAY = 0.06;
const SWAY_SECONDS = 300;
const AZIMUTH = 0.6;
const TAU = Math.PI * 2;

export function mountGalaxy(canvas: HTMLCanvasElement): BackdropHandle {
  const loop = new GalaxyLoop(canvas);
  loop.setVisible(true);
  return loop;
}

class GalaxyLoop implements BackdropHandle {
  private readonly viewport: Viewport;
  private readonly uniforms = createGalaxyUniforms();
  private readonly stars: StarLayer;
  private readonly gas: GasPlate;
  private readonly sky = new GalaxySky();
  private readonly timer = new Timer();
  private readonly pacer = new FramePacer();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  private visible = false;
  private animated = true;
  private running = false;
  private disposed = false;
  private time = 0;
  private spin = 0;
  private coreSpin = 0;
  private sway = 0;
  private wanderSpeed = 0;
  private wanderTarget = 0;
  private homeDistance = HOME_DISTANCE;
  private distance = HOME_DISTANCE;
  private configured = false;

  constructor(canvas: HTMLCanvasElement) {
    this.viewport = new Viewport(canvas);
    this.stars = new StarLayer(this.uniforms);
    this.gas = new GasPlate(this.uniforms);
    this.stars.setCount(starCountFor(1000));
    this.viewport.scene.add(this.sky.group, this.gas.mesh, this.stars.points);
    // The camera is placed by hand each frame; the viewport's orbit controls stay off.
    this.viewport.controls.enabled = false;
    this.viewport.controls.autoRotate = false;
    this.viewport.onResize((h) => {
      this.stars.setViewportHeight(h);
      this.sky.setPixelRatio(this.viewport.renderer.getPixelRatio());
      // Resizing clears the canvas, and a frozen backdrop has no loop to redraw it.
      if (this.visible && !this.running) this.draw();
    });
    this.placeCamera();
    this.timer.connect(document);
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    this.sync();
  }

  setAnimated(animated: boolean): void {
    if (this.disposed || animated === this.animated) return;
    this.animated = animated;
    this.sync();
  }

  setMaxFps(maxFps: number): void {
    this.pacer.setMaxFps(maxFps);
  }

  setOptions(options: BackdropOptions): void {
    this.stars.setCount(starCountFor(options.capacity));
    this.wanderTarget = wanderAmplitude(options.mutationRate);
    this.wanderSpeed = wanderSpeed(options.mutationRate);
    const { minDistance, maxDistance } = this.viewport.controls;
    this.homeDistance = Math.min(Math.max(HOME_DISTANCE / options.zoom, minDistance), maxDistance);
    // The first options open the view at its zoom, and a frozen backdrop has no loop to ease toward
    // new values, so both jump there.
    if (!this.configured || !this.running) {
      this.configured = true;
      this.uniforms.uWanderAmp.value = this.wanderTarget;
      this.distance = this.homeDistance;
      this.placeCamera();
      if (this.visible && !this.running) this.draw();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.visible = false;
    this.sync();
    this.disposed = true;
    this.timer.disconnect();
    this.viewport.scene.remove(this.sky.group, this.gas.mesh, this.stars.points);
    this.stars.dispose();
    this.gas.dispose();
    this.sky.dispose();
    this.viewport.dispose();
  }

  private sync(): void {
    const run = this.visible && this.animated;
    if (run !== this.running) {
      this.running = run;
      this.pacer.reset();
      this.viewport.renderer.setAnimationLoop(run ? (t) => this.frame(t) : null);
    }
    if (this.visible && !run) this.draw();
  }

  private frame(timestamp: number): void {
    if (!this.pacer.shouldRender(timestamp)) return;
    this.timer.update(timestamp);
    // Clamped at both ends: long stalls and out-of-order timestamps would otherwise jolt the turn.
    this.step(Math.min(Math.max(this.timer.getDelta(), 0), 1 / 20));
    this.draw();
  }

  private step(dt: number): void {
    this.time += dt;
    // Kept within one turn, so the angles never grow large enough to lose float precision on the GPU.
    this.spin = (this.spin + SPIN * dt) % TAU;
    this.coreSpin = (this.coreSpin + CORE_SPIN * dt) % TAU;
    // Windows' animation effects off maps to reduced motion; the camera then holds its angle.
    if (!this.reducedMotion.matches) this.sway = (this.sway + (dt / SWAY_SECONDS) * TAU) % TAU;

    const u = this.uniforms;
    u.uWanderTime.value = (u.uWanderTime.value + this.wanderSpeed * dt) % (TAU * 1000);
    // Eased, so moving the Color drift slider shifts the hues rather than snapping them.
    u.uWanderAmp.value += (this.wanderTarget - u.uWanderAmp.value) * (1 - Math.exp(-dt * 1.5));

    this.distance += (this.homeDistance - this.distance) * (1 - Math.exp(-dt * 2));
    this.placeCamera();
  }

  private draw(): void {
    const u = this.uniforms;
    u.uTime.value = this.time;
    u.uSpin.value = this.spin;
    this.stars.setCoreSpin(this.coreSpin);
    this.viewport.render(this.time);
  }

  private placeCamera(): void {
    const camera = this.viewport.camera;
    const tilt = TILT + Math.sin(this.sway) * TILT_SWAY;
    const d = this.distance;
    camera.position.set(Math.sin(tilt) * Math.cos(AZIMUTH) * d, Math.cos(tilt) * d, Math.sin(tilt) * Math.sin(AZIMUTH) * d);
    camera.lookAt(0, 0, 0);
    this.sky.group.position.copy(camera.position);
  }
}
