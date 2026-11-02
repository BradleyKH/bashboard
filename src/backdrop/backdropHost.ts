// Owns the #backdrop canvas and whichever backdrop style is mounted on it (docs/design.md section 6).
import type { BackdropStyle, Settings } from '../settings';
import type { BackdropHandle } from './backdrop';
import { ColonyRelay } from './colonyRelay';
import type { MatrixBackdrop } from './matrix/matrixBackdrop';

type BackdropSettings = Settings['backdrop'];
type Mounted = { style: 'lights'; handle: BackdropHandle } | { style: 'matrix'; handle: MatrixBackdrop };

export class BackdropHost {
  /** Hand this to ColonySync; it survives style switches and replays sessions into a new colony. */
  readonly colony = new ColonyRelay();
  private readonly template: HTMLCanvasElement;
  private canvas: HTMLCanvasElement;
  private current: Mounted | undefined;
  private wanted: BackdropStyle | undefined;
  /** Bumped by every style switch, so a mount that finishes after a later switch knows it lost. */
  private generation = 0;
  private settings: BackdropSettings | undefined;
  private visible = true;
  private animated = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // Cloned before any style touches the canvas, so a style's inline styles never carry over.
    this.template = canvas.cloneNode(false) as HTMLCanvasElement;
  }

  /** The requested style; undefined until the first apply. */
  get style(): BackdropStyle | undefined {
    return this.wanted;
  }

  /** Rejects only when the latest requested style fails to mount. */
  async apply(settings: BackdropSettings): Promise<void> {
    this.settings = settings;
    this.animated = settings.animate;
    if (settings.style === this.wanted) {
      this.configure();
      return;
    }
    const style = settings.style;
    this.wanted = style;
    const generation = ++this.generation;
    this.unmount();
    if (style === 'none') return;

    const canvas = this.canvas;
    let mounted: Mounted;
    try {
      mounted = await mount(style, canvas, settings);
    } catch (err) {
      if (generation !== this.generation) return;
      throw err;
    }
    if (generation !== this.generation) {
      mounted.handle.dispose();
      return;
    }
    this.current = mounted;
    if (mounted.style === 'lights') this.colony.attach(mounted.handle.colony);
    this.configure();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.current?.handle.setVisible(visible);
  }

  setAnimated(animated: boolean): void {
    this.animated = animated;
    this.current?.handle.setAnimated(animated);
  }

  private configure(): void {
    const settings = this.settings;
    const current = this.current;
    if (!settings || !current) return;
    if (current.style === 'lights') {
      current.handle.setMaxFps(settings.maxFps);
      current.handle.setOptions(settings);
    } else {
      current.handle.setOptions(settings.matrix);
    }
    current.handle.setAnimated(this.animated);
    current.handle.setVisible(this.visible);
  }

  private unmount(): void {
    const current = this.current;
    this.current = undefined;
    if (current) {
      if (current.style === 'lights') this.colony.detach();
      current.handle.dispose();
    }
    // A canvas that held a WebGL context cannot give a 2D one, and the matrix style flips its
    // canvas with an inline transform, so every style gets a fresh element.
    const fresh = this.template.cloneNode(false) as HTMLCanvasElement;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
  }
}

async function mount(style: 'lights' | 'matrix', canvas: HTMLCanvasElement, settings: BackdropSettings): Promise<Mounted> {
  // Dynamic imports keep Three.js out of the main bundle; only the lights style loads it.
  if (style === 'lights') {
    const { mountBackdrop } = await import('./backdrop');
    return { style, handle: mountBackdrop(canvas) };
  }
  const { mountMatrix } = await import('./matrix/matrixBackdrop');
  return { style, handle: mountMatrix(canvas, settings.matrix) };
}
