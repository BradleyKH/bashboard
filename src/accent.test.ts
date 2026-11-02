import { describe, expect, it } from 'vitest';
import { ACCENT_MIN_LUMINANCE, ACCENT_PRESETS, darken, relativeLuminance, terminalAccent } from './accent';

describe('accent', () => {
  it('keeps every preset bright enough for the loader to accept', () => {
    for (const p of ACCENT_PRESETS) {
      expect(p.value).toMatch(/^#[0-9a-f]{6}$/);
      expect(relativeLuminance(p.value), p.label).toBeGreaterThanOrEqual(ACCENT_MIN_LUMINANCE);
    }
  });

  it('measures luminance at the extremes', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1);
  });

  it('darkens toward black', () => {
    expect(darken('#4fb3c8', 0.5)).toBe('#285a64');
    expect(darken('#ffffff', 1)).toBe('#ffffff');
  });

  it('builds opaque terminal shades and a translucent selection', () => {
    const t = terminalAccent('#4fb3c8');
    expect(t.activeMatchBackground).toBe('#4fb3c8');
    expect(t.matchBackground).toMatch(/^#[0-9a-f]{6}$/);
    expect(t.selectionInactiveBackground).toBe('#4fb3c880');
  });
});
