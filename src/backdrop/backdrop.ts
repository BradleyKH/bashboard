import { Timer, Vector3 } from 'three';
import type { Material, Object3D } from 'three';
import { SkyDome } from './render/skyDome';
import { OrganismLayer } from './render/organismLayer';
import { SnowLayer } from './render/snowLayer';
import { SparkLayer } from './render/sparkLayer';
import { ThreadLayer } from './render/threadLayer';
import { playTickEffects } from './render/tickEffects';
import { HOME_DISTANCE, Viewport } from './render/viewport';
import type { StyleBackdrop } from './backdropHandle';
import { FramePacer } from './framePacer';
import { Motion } from './sim/motion';
import { SimSessionColony, type SessionColony } from './sim/sessionColony';
import { Simulation } from './sim/simulation';
import { Stage } from './sim/stages';

/** Generations simulated per frame at most, so a slow frame never snowballs. */
const MAX_TICKS_PER_FRAME = 3;
const GENS_PER_SECOND = 12;
/** Sim time run before the first frame, so the backdrop opens on a grown colony, not the lone founding spore. */
const PREWARM_SECONDS = 16;
/** Coarser than a frame: motion cost scales with steps, and each step still runs the full 3 generations. */
const PREWARM_STEP = 1 / 4;
/** Wall-clock cap on the pre-warm, which blocks the window's first paint; a large capacity opens on a younger colony. */
const PREWARM_BUDGET_MS = 500;

export interface BackdropOptions {
  capacity: number;
  mutationRate: number;
  /** Divides the camera's home distance; above 1 fills more of the window with the colony. */
  zoom: number;
  /** Brightness pulse on a waiting session's organisms (docs/design/backdrop.md section 6.2). */
  waitingPulse: boolean;
}

export interface BackdropHandle extends StyleBackdrop {
  /** 0 is uncapped (docs/design/backdrop.md section 6.4). */
  setMaxFps(maxFps: number): void;
  /** The simulation and camera settings (`backdrop.*`). */
  setOptions(options: BackdropOptions): void;
  /** Session organisms planted in the sim (docs/design/backdrop.md section 6.2). */
  colony: SessionColony;
}

export function mountBackdrop(canvas: HTMLCanvasElement): BackdropHandle {
  const loop = new BackdropLoop(canvas);
  loop.setVisible(true);
  return loop;
}

type Renderable = Object3D & { geometry: { dispose(): void }; material: Material | Material[] };

class BackdropLoop implements BackdropHandle {
  private readonly viewport: Viewport;
  private readonly sim = new Simulation({ capacity: 1000, mutationRate: 0.2 });
  readonly colony = new SimSessionColony(this.sim);
  private readonly motion = new Motion();
  private readonly organisms = new OrganismLayer();
  private readonly threads = new ThreadLayer();
  private readonly sparks = new SparkLayer();
  private readonly snow = new SnowLayer();
  private readonly skyDome = new SkyDome();
  private readonly timer = new Timer();
  private readonly centroid = new Vector3();
  private readonly pacer = new FramePacer();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly syncOrbit = (): void => {
    this.viewport.controls.autoRotate = !this.reducedMotion.matches;
  };

  private visible = false;
  private animated = true;
  private running = false;
  private disposed = false;
  private tickDebt = 0;
  private time = 0;
  private homeDistance = HOME_DISTANCE;
  private waitingPulse = false;
  private warmed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.viewport = new Viewport(canvas);
    const { scene } = this.viewport;
    scene.add(this.skyDome.mesh, this.snow.points, this.threads.lines, this.organisms.points);
    scene.add(this.sparks.points);
    this.viewport.onResize((h) => {
      this.organisms.setViewportHeight(h);
      this.sparks.setViewportHeight(h);
      this.snow.setViewportHeight(h);
      // Resizing clears the canvas, and a frozen backdrop has no loop to redraw it.
      if (this.visible && !this.running) this.viewport.render(this.time);
    });
    // The backdrop never takes input; auto-rotate still runs through controls.update.
    this.viewport.controls.enabled = false;
    // Windows animation effects off maps to reduced motion; the camera then holds still.
    this.syncOrbit();
    this.reducedMotion.addEventListener('change', this.syncOrbit);
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
    this.sim.settings.capacity = options.capacity;
    this.sim.settings.mutationRate = options.mutationRate;
    this.waitingPulse = options.waitingPulse;
    const { minDistance, maxDistance } = this.viewport.controls;
    this.homeDistance = Math.min(Math.max(HOME_DISTANCE / options.zoom, minDistance), maxDistance);
    // The host passes options before the first frame, so the pre-warm grows the colony at the configured capacity.
    if (!this.warmed) {
      this.prewarm();
      return;
    }
    // A frozen backdrop has no loop to ease toward the new distance, so jump there and redraw.
    if (!this.running) {
      this.setDistance(this.homeDistance);
      if (this.visible) this.viewport.render(this.time);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.visible = false;
    this.sync();
    this.disposed = true;
    this.timer.disconnect();
    this.reducedMotion.removeEventListener('change', this.syncOrbit);
    const meshes: Renderable[] = [
      this.skyDome.mesh,
      this.snow.points,
      this.threads.lines,
      this.organisms.points,
      this.sparks.points,
    ];
    for (const mesh of meshes) {
      this.viewport.scene.remove(mesh);
      mesh.geometry.dispose();
      for (const material of [mesh.material].flat()) material.dispose();
    }
    this.viewport.dispose();
  }

  private sync(): void {
    const run = this.visible && this.animated;
    if (run !== this.running) {
      this.running = run;
      this.pacer.reset();
      // A long pause yields one large delta on resume, which the 1/20 s clamp in frame() absorbs.
      this.viewport.renderer.setAnimationLoop(run ? (t) => this.frame(t) : null);
    }
    if (this.visible && !run) {
      this.prewarm();
      this.viewport.render(this.time);
    }
  }

  /** Runs the sim and every layer headless at a fixed step, with the camera already at its home distance. */
  private prewarm(): void {
    if (this.warmed) return;
    this.warmed = true;
    this.setDistance(this.homeDistance);
    const deadline = performance.now() + PREWARM_BUDGET_MS;
    for (let t = 0; t < PREWARM_SECONDS && performance.now() < deadline; t += PREWARM_STEP) this.step(PREWARM_STEP);
  }

  private frame(timestamp: number): void {
    if (!this.pacer.shouldRender(timestamp)) return;
    this.prewarm();
    this.timer.update(timestamp);
    // Clamped at both ends: long stalls (tab switches, resuming from hidden) and out-of-order timestamps would otherwise destabilize motion.
    this.step(Math.min(Math.max(this.timer.getDelta(), 0), 1 / 20));
    this.viewport.render(this.time);
  }

  private step(dt: number): void {
    this.time += dt;

    this.tickDebt += dt * GENS_PER_SECOND;
    let ticks = 0;
    while (this.tickDebt >= 1 && ticks < MAX_TICKS_PER_FRAME) {
      this.advance();
      this.tickDebt -= 1;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) this.tickDebt = 0;
    this.motion.step(this.sim.organisms, dt, this.time);

    this.organisms.update(this.sim.organisms, dt, this.time, 1 / GENS_PER_SECOND, true, this.waitingPulse ? this.colony.pulsingLineages() : undefined);
    this.threads.update(this.sim.organisms, (id) => this.organisms.visualOf(id)?.born ?? Infinity);
    this.sparks.update(dt);
    this.snow.update(this.time);
    this.skyDome.update(this.time, this.sim.tideLevel());
    this.skyDome.mesh.position.copy(this.viewport.camera.position);

    this.followColony(dt);
    this.easeZoom(dt);
    this.viewport.controls.update(dt);
  }

  private advance(): void {
    const result = this.sim.tick();
    this.colony.afterTick();
    playTickEffects(result, this.organisms, this.sparks, 1 / GENS_PER_SECOND);
    if (result.newEpoch) this.organisms.clear();
  }

  /** Eases the orbit pivot toward the living colony's center as the current carries it around. */
  private followColony(dt: number): void {
    let x = 0;
    let y = 0;
    let z = 0;
    let n = 0;
    for (const o of this.sim.organisms) {
      if (o.stage === Stage.Husk) continue;
      x += o.x;
      y += o.y;
      z += o.z;
      n++;
    }
    if (n === 0) return;
    const ease = 1 - Math.exp(-dt * 0.35);
    const target = this.viewport.controls.target;
    const before = target.clone();
    target.lerp(this.centroid.set(x / n, y / n, z / n), ease);
    // Move the camera with the pivot so following never changes the viewing distance.
    this.viewport.camera.position.add(target.clone().sub(before));
  }

  /** Glides to a changed zoom. */
  private easeZoom(dt: number): void {
    const distance = this.viewport.camera.position.distanceTo(this.viewport.controls.target);
    if (Math.abs(distance - this.homeDistance) < 0.01) return;
    this.setDistance(distance + (this.homeDistance - distance) * (1 - Math.exp(-dt * 2)));
  }

  private setDistance(distance: number): void {
    const camera = this.viewport.camera;
    const target = this.viewport.controls.target;
    const offset = camera.position.clone().sub(target).setLength(distance);
    camera.position.copy(target).add(offset);
  }
}
