import { describe, expect, it } from 'vitest';
import { decodeSize, placeImage } from './imageFit';

describe('placeImage', () => {
  it('fill covers the canvas and centers the overhang', () => {
    expect(placeImage('fill', 1000, 500, 200, 200)).toEqual({ x: 0, y: -250, w: 1000, h: 1000 });
  });

  it('fit shows the whole image with bars', () => {
    expect(placeImage('fit', 1000, 500, 200, 200)).toEqual({ x: 250, y: 0, w: 500, h: 500 });
  });

  it('stretch takes the canvas size', () => {
    expect(placeImage('stretch', 1000, 500, 200, 300)).toEqual({ x: 0, y: 0, w: 1000, h: 500 });
  });

  it('center keeps actual size, overhanging when larger', () => {
    expect(placeImage('center', 1000, 500, 200, 100)).toEqual({ x: 400, y: 200, w: 200, h: 100 });
    expect(placeImage('center', 100, 100, 300, 300)).toEqual({ x: -100, y: -100, w: 300, h: 300 });
  });

  it('tile returns the first tile at actual size', () => {
    expect(placeImage('tile', 1000, 500, 64, 32)).toEqual({ x: 0, y: 0, w: 64, h: 32 });
  });
});

describe('decodeSize', () => {
  it('shrinks a large image to just cover the area', () => {
    expect(decodeSize('fill', 1920, 1080, 7680, 4320)).toEqual({ w: 1920, h: 1080 });
    expect(decodeSize('fit', 1920, 1080, 8000, 2000)).toEqual({ w: 4320, h: 1080 });
  });

  it('never upscales', () => {
    expect(decodeSize('stretch', 1920, 1080, 800, 600)).toEqual({ w: 800, h: 600 });
  });

  it('keeps actual size for center and tile', () => {
    expect(decodeSize('center', 1920, 1080, 7680, 4320)).toEqual({ w: 7680, h: 4320 });
    expect(decodeSize('tile', 1920, 1080, 7680, 4320)).toEqual({ w: 7680, h: 4320 });
  });
});
