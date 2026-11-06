// Where the Image and Slideshow styles draw a picture on the canvas (docs/design.md section 6.5).

export type ImageFit = 'fill' | 'fit' | 'stretch' | 'center' | 'tile';

export const IMAGE_FITS: { value: ImageFit; label: string }[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'fit', label: 'Fit' },
  { value: 'stretch', label: 'Stretch' },
  { value: 'center', label: 'Center' },
  { value: 'tile', label: 'Tile' },
];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The rectangle to draw the whole image into, in canvas pixels; it may overhang the canvas (fill,
 * center). Tile returns the first tile at the top left, which the caller repeats.
 */
export function placeImage(fit: ImageFit, canvasW: number, canvasH: number, imageW: number, imageH: number): Rect {
  if (fit === 'stretch') return { x: 0, y: 0, w: canvasW, h: canvasH };
  if (fit === 'tile') return { x: 0, y: 0, w: imageW, h: imageH };
  let scale = 1;
  if (fit === 'fill') scale = Math.max(canvasW / imageW, canvasH / imageH);
  if (fit === 'fit') scale = Math.min(canvasW / imageW, canvasH / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

/**
 * The largest size worth decoding an image at: a fit that scales the image only ever needs enough
 * pixels to cover `maxW` x `maxH`, so bigger images are shrunk once at load. Center and tile draw
 * at actual size and keep every pixel. Never upscales.
 */
export function decodeSize(fit: ImageFit, maxW: number, maxH: number, imageW: number, imageH: number): { w: number; h: number } {
  if (fit === 'center' || fit === 'tile') return { w: imageW, h: imageH };
  // Cover scale fits every scaling mode: fill needs it, and fit and stretch need no more.
  const scale = Math.min(1, Math.max(maxW / imageW, maxH / imageH));
  return { w: Math.max(1, Math.round(imageW * scale)), h: Math.max(1, Math.round(imageH * scale)) };
}
