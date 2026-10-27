import {
  NeutralToneMapping,
  HalfFloatType,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { finishingShader } from './shaders/finishing';

/** Camera distance the opening shot settles at. */
export const HOME_DISTANCE = 125;

export class Viewport {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly finishing: ShaderPass;
  private readonly resizeListeners: ((heightPx: number) => void)[] = [];
  private readonly handleResize = (): void => this.resize();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.95;

    this.camera = new PerspectiveCamera(48, 1, 0.1, 1200);
    this.camera.position.set(0, 4, 24);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 12;
    this.controls.maxDistance = 240;
    this.controls.autoRotate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.controls.autoRotateSpeed = 0.35;
    this.controls.rotateSpeed = 0.6;
    this.controls.zoomSpeed = 0.7;

    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), 0.8, 0.6, 0.16);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finishing = new ShaderPass(finishingShader);
    this.composer.addPass(this.finishing);

    window.addEventListener('resize', this.handleResize);
    this.resize();
  }

  onResize(listener: (heightPx: number) => void): void {
    this.resizeListeners.push(listener);
    listener(this.heightPx());
  }

  render(time: number): void {
    this.finishing.uniforms.uTime.value = time;
    this.composer.render();
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.resizeListeners.length = 0;
    this.controls.dispose();
    // The composer frees only its own targets, not its passes.
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }

  private heightPx(): number {
    return window.innerHeight * this.renderer.getPixelRatio();
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.finishing.uniforms.uResolution.value.set(w, h);
    for (const listener of this.resizeListeners) listener(this.heightPx());
  }
}
