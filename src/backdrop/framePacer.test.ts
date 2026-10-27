import { describe, expect, it } from 'vitest';
import { FramePacer } from './framePacer';

/** Counts rendered frames over one second of rAF callbacks at the given refresh rate. */
function renderedPerSecond(pacer: FramePacer, refreshHz: number, jitterMs = 0): number {
  let rendered = 0;
  for (let i = 0; i < refreshHz; i++) {
    const jitter = i % 2 === 0 ? jitterMs : -jitterMs;
    if (pacer.shouldRender((i * 1000) / refreshHz + jitter)) rendered++;
  }
  return rendered;
}

describe('FramePacer', () => {
  it('renders every frame when uncapped', () => {
    const pacer = new FramePacer();
    pacer.setMaxFps(0);
    expect(renderedPerSecond(pacer, 144)).toBe(144);
  });

  it('holds the average at the cap when it does not divide the refresh rate', () => {
    const pacer = new FramePacer();
    pacer.setMaxFps(60);
    expect(renderedPerSecond(pacer, 144)).toBeGreaterThanOrEqual(59);
    expect(renderedPerSecond(pacer, 144)).toBeLessThanOrEqual(61);
  });

  it('keeps every frame when the cap equals a jittery refresh rate', () => {
    const pacer = new FramePacer();
    pacer.setMaxFps(60);
    expect(renderedPerSecond(pacer, 60, 0.4)).toBe(60);
  });

  it('halves a 120 Hz display at a 60 fps cap', () => {
    const pacer = new FramePacer();
    pacer.setMaxFps(60);
    expect(renderedPerSecond(pacer, 120)).toBe(60);
  });

  it('renders one frame, not a burst, after a stall', () => {
    const pacer = new FramePacer();
    pacer.setMaxFps(30);
    expect(pacer.shouldRender(0)).toBe(true);
    expect(pacer.shouldRender(5000)).toBe(true);
    expect(pacer.shouldRender(5007)).toBe(false);
  });
});
