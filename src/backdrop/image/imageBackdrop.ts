// Image and Slideshow backdrop styles: a local picture, or a folder of them in turn, drawn with
// Canvas 2D (docs/design.md section 6.5). The scrim's brightness and blur apply through the
// canvas's CSS filter like every other style.
import { invoke } from '@tauri-apps/api/core';
import type { Settings } from '../../settings';
import type { StyleBackdrop } from '../backdropHandle';
import { decodeSize, placeImage } from './imageFit';
import { SlideshowOrder } from './slideshowOrder';

export type ImageOptions = Settings['backdrop']['image'] & { mode: 'image' | 'slideshow' };

export interface ImageBackdrop extends StyleBackdrop {
  setOptions(options: ImageOptions): void;
}

/** A slideshow tries this many files in a row before giving up until the next interval. */
const MAX_ATTEMPTS = 10;

export function mountImage(canvas: HTMLCanvasElement, options: ImageOptions, onError: (message: string) => void): ImageBackdrop {
  const loop = new ImageLoop(canvas, options, onError);
  loop.setVisible(true);
  return loop;
}

class ImageLoop implements ImageBackdrop {
  private ctx: CanvasRenderingContext2D | null;
  private readonly order = new SlideshowOrder();
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private readonly handleResize = (): void => this.resize();
  /** The bars and empty space left by fit and center match the page behind the panes. */
  private readonly background = getComputedStyle(document.body).backgroundColor || '#01070c';

  private options: ImageOptions;
  private current: { path: string; bitmap: ImageBitmap } | undefined;
  private incoming: { path: string; bitmap: ImageBitmap; start: number } | undefined;
  private frameId: number | null = null;
  private timer: number | undefined;
  /** Time left until the next slide while the window is hidden; the timer stops meanwhile. */
  private remainingMs: number | undefined;
  private nextAt = 0;
  private visible = false;
  private disposed = false;
  /** Bumped when the source changes, so a load that finishes afterwards knows it lost. */
  private generation = 0;
  /** The last error reported, so a slideshow stuck on a bad folder does not toast every interval. */
  private lastError = '';

  constructor(private readonly canvas: HTMLCanvasElement, options: ImageOptions, private readonly onError: (message: string) => void) {
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.options = options;
    this.resize();
    window.addEventListener('resize', this.handleResize);
    void this.reload();
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      if (this.remainingMs !== undefined) this.schedule(this.remainingMs);
    } else if (this.timer !== undefined) {
      this.remainingMs = Math.max(0, this.nextAt - performance.now());
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Image and Slideshow ignore `backdrop.animate`; the slideshow always cycles. */
  setAnimated(): void {}

  setOptions(options: ImageOptions): void {
    if (this.disposed) return;
    const prev = this.options;
    this.options = options;
    if (sourceKey(options) !== sourceKey(prev)) {
      this.order.reset();
      void this.reload();
    } else if (options.fit !== prev.fit) {
      // The decoded size depends on the fit (center and tile keep every pixel), so decode again.
      const path = this.current?.path;
      if (path) void this.show(path, this.generation, false);
    } else if (options.mode === 'slideshow' && options.intervalSeconds !== prev.intervalSeconds) {
      this.schedule(options.intervalSeconds * 1000);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.stopTimer();
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    window.removeEventListener('resize', this.handleResize);
    this.current?.bitmap.close();
    this.incoming?.bitmap.close();
    this.current = undefined;
    this.incoming = undefined;
    this.ctx = null;
  }

  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.stopTimer();
    const o = this.options;
    if (o.mode === 'image') {
      // An empty path is the unset state, not an error: the dialog shows the empty field.
      if (!o.file) return this.clearImage();
      await this.show(o.file, generation, true);
    } else {
      if (!o.folder) return this.clearImage();
      await this.advance(generation);
    }
  }

  /** Lists the folder fresh, shows the next image that loads, and schedules the one after. */
  private async advance(generation: number): Promise<void> {
    const o = this.options;
    let files: string[];
    try {
      files = await invoke<string[]>('backdrop_image_list', { folder: o.folder, includeSubfolders: o.includeSubfolders });
    } catch (err) {
      if (generation !== this.generation) return;
      this.report(String(err));
      this.schedule(o.intervalSeconds * 1000);
      return;
    }
    if (generation !== this.generation) return;
    if (files.length === 0) {
      this.report(`No images in ${o.folder}`);
    } else {
      let current = this.current?.path;
      for (let attempt = 0; attempt < Math.min(files.length, MAX_ATTEMPTS); attempt++) {
        const path = this.order.next(files, current, o.shuffle);
        if (path === undefined || (await this.show(path, generation, true))) break;
        if (generation !== this.generation) return;
        current = path;
      }
    }
    if (generation === this.generation) this.schedule(this.options.intervalSeconds * 1000);
  }

  /** Reads, decodes, and fades to the image; false when it failed (already reported). */
  private async show(path: string, generation: number, fade: boolean): Promise<boolean> {
    let bitmap: ImageBitmap;
    try {
      bitmap = await this.decode(path);
    } catch (err) {
      if (generation === this.generation) this.report(String(err));
      return false;
    }
    if (generation !== this.generation || this.disposed) {
      bitmap.close();
      return false;
    }
    this.lastError = '';
    this.incoming?.bitmap.close();
    this.incoming = { path, bitmap, start: performance.now() };
    if (!fade || !this.current || !this.visible || this.reducedMotion.matches || this.options.crossfadeSeconds <= 0) {
      this.finishFade();
    } else if (this.frameId === null) {
      this.frameId = requestAnimationFrame(this.frame);
    }
    return true;
  }

  private async decode(path: string): Promise<ImageBitmap> {
    const bytes = await invoke<ArrayBuffer>('backdrop_image_read', { path });
    const full = await createImageBitmap(new Blob([bytes]));
    // The window can grow to the screen, so decode for the screen rather than the window.
    const dpr = window.devicePixelRatio || 1;
    const maxW = Math.max(screen.width, window.innerWidth) * dpr;
    const maxH = Math.max(screen.height, window.innerHeight) * dpr;
    const size = decodeSize(this.options.fit, maxW, maxH, full.width, full.height);
    if (size.w === full.width && size.h === full.height) return full;
    try {
      return await createImageBitmap(full, { resizeWidth: size.w, resizeHeight: size.h, resizeQuality: 'high' });
    } finally {
      full.close();
    }
  }

  private readonly frame = (now: number): void => {
    this.frameId = null;
    const incoming = this.incoming;
    if (!incoming || this.disposed) return;
    const t = (now - incoming.start) / (this.options.crossfadeSeconds * 1000);
    if (t >= 1) {
      this.finishFade();
      return;
    }
    // Smoothstep, so the fade eases in and out rather than starting and stopping abruptly.
    this.redraw(t * t * (3 - 2 * t));
    this.frameId = requestAnimationFrame(this.frame);
  };

  private finishFade(): void {
    if (this.frameId !== null) cancelAnimationFrame(this.frameId);
    this.frameId = null;
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = undefined;
    if (this.current && this.current.bitmap !== incoming.bitmap) this.current.bitmap.close();
    this.current = { path: incoming.path, bitmap: incoming.bitmap };
    this.redraw();
  }

  /** Draws the current image, with the incoming one over it at `fade` (0 to 1) during a crossfade. */
  private redraw(fade?: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.current) this.drawBitmap(ctx, this.current.bitmap, 1);
    if (this.incoming && fade !== undefined) this.drawBitmap(ctx, this.incoming.bitmap, fade);
    ctx.globalAlpha = 1;
  }

  private drawBitmap(ctx: CanvasRenderingContext2D, bitmap: ImageBitmap, alpha: number): void {
    ctx.globalAlpha = alpha;
    const fit = this.options.fit;
    if (fit === 'tile') {
      const pattern = ctx.createPattern(bitmap, 'repeat');
      if (!pattern) return;
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    const r = placeImage(fit, this.canvas.width, this.canvas.height, bitmap.width, bitmap.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, r.x, r.y, r.w, r.h);
  }

  private clearImage(): void {
    this.incoming?.bitmap.close();
    this.current?.bitmap.close();
    this.incoming = undefined;
    this.current = undefined;
    this.redraw();
  }

  private schedule(ms: number): void {
    this.stopTimer();
    const generation = this.generation;
    if (!this.visible) {
      this.remainingMs = ms;
      return;
    }
    this.nextAt = performance.now() + ms;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.advance(generation);
    }, ms);
  }

  private stopTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs = undefined;
  }

  private report(message: string): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.onError(message);
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
    this.redraw();
  }
}

/** What decides which images are shown; a change starts over. */
function sourceKey(o: ImageOptions): string {
  return o.mode === 'image' ? `image\n${o.file}` : `slideshow\n${o.folder}\n${o.includeSubfolders}`;
}
