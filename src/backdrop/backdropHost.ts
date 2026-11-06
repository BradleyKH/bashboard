// Owns the #backdrop canvas and whichever backdrop style is mounted on it (docs/design/backdrop.md
// section 6).
import type { BackdropStyle, Settings } from '../settings';
import type { BackdropHandle } from './backdrop';
import type { ImageBackdrop, ImageOptions } from './image/imageBackdrop';
import type { MatrixBackdrop, MatrixOptions } from './matrix/matrixBackdrop';
import { matrixRainColor } from './matrix/rainColor';

type BackdropSettings = Settings['backdrop'];
type Mounted =
  | { style: 'lights'; handle: BackdropHandle }
  | { style: 'galaxy'; handle: BackdropHandle }
  | { style: 'matrix'; handle: MatrixBackdrop }
  | { style: 'image' | 'slideshow'; handle: ImageBackdrop };

export class BackdropHost {
  private readonly template: HTMLCanvasElement;
  private canvas: HTMLCanvasElement;
  private current: Mounted | undefined;
  private wanted: BackdropStyle | undefined;
  /** Bumped by every style switch, so a mount that finishes after a later switch knows it lost. */
  private generation = 0;
  private settings: BackdropSettings | undefined;
  /** The Matrix rain can follow the accent. */
  private accent = '';
  private visible = true;
  private animated = true;

  /** `onError` reports a picture the Image or Slideshow style could not show after mounting. */
  constructor(canvas: HTMLCanvasElement, private readonly onError: (message: string) => void = () => {}) {
    this.canvas = canvas;
    // Cloned before any style touches the canvas, so a style's inline styles never carry over.
    this.template = canvas.cloneNode(false) as HTMLCanvasElement;
  }

  /** The requested style; undefined until the first apply. */
  get style(): BackdropStyle | undefined {
    return this.wanted;
  }

  /** Rejects only when the latest requested style fails to mount. */
  async apply(settings: BackdropSettings, accent: string): Promise<void> {
    this.settings = settings;
    this.accent = accent;
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
      mounted = await mount(style, canvas, settings, accent, this.onError);
    } catch (err) {
      if (generation !== this.generation) return;
      throw err;
    }
    if (generation !== this.generation) {
      mounted.handle.dispose();
      return;
    }
    this.current = mounted;
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
    if (current.style === 'lights' || current.style === 'galaxy') {
      current.handle.setMaxFps(settings.maxFps);
      current.handle.setOptions(settings);
    } else if (current.style === 'matrix') {
      current.handle.setOptions(matrixOptions(settings, this.accent));
    } else {
      current.handle.setOptions(imageOptions(settings, current.style));
    }
    current.handle.setAnimated(this.animated);
    current.handle.setVisible(this.visible);
  }

  private unmount(): void {
    const current = this.current;
    this.current = undefined;
    current?.handle.dispose();
    // A canvas that held a WebGL context cannot give a 2D one, and the matrix style flips its
    // canvas with an inline transform, so every style gets a fresh element.
    const fresh = this.template.cloneNode(false) as HTMLCanvasElement;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
  }
}

/** The Matrix settings with the color mode resolved to the #rrggbb the renderer draws. */
function matrixOptions(settings: BackdropSettings, accent: string): MatrixOptions {
  return { ...settings.matrix, color: matrixRainColor(settings.matrix.color, accent) };
}

function imageOptions(settings: BackdropSettings, mode: 'image' | 'slideshow'): ImageOptions {
  return { ...settings.image, mode };
}

async function mount(
  style: Exclude<BackdropStyle, 'none'>,
  canvas: HTMLCanvasElement,
  settings: BackdropSettings,
  accent: string,
  onError: (message: string) => void,
): Promise<Mounted> {
  // Dynamic imports keep Three.js out of the main bundle; only the lights and galaxy styles load it.
  if (style === 'lights') {
    const { mountBackdrop } = await import('./backdrop');
    return { style, handle: mountBackdrop(canvas) };
  }
  if (style === 'galaxy') {
    const { mountGalaxy } = await import('./galaxy/galaxyBackdrop');
    return { style, handle: mountGalaxy(canvas) };
  }
  if (style === 'matrix') {
    const { mountMatrix } = await import('./matrix/matrixBackdrop');
    return { style, handle: mountMatrix(canvas, matrixOptions(settings, accent)) };
  }
  const { mountImage } = await import('./image/imageBackdrop');
  return { style, handle: mountImage(canvas, imageOptions(settings, style), onError) };
}
