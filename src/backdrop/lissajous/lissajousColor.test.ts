import { describe, expect, it } from 'vitest';
import { LISSAJOUS_WHITE, lissajousLineColor, lissajousSwatch, spectrumColor } from './lissajousColor';

describe('lissajousLineColor', () => {
  it('resolves accent to the vivid accent, white to white, and passes spectrum through', () => {
    expect(lissajousLineColor('accent', '#a68bff')).toBe('#7a51ff');
    expect(lissajousLineColor('white', '#a68bff')).toBe(LISSAJOUS_WHITE);
    expect(lissajousLineColor('spectrum', '#a68bff')).toBe('spectrum');
  });
});

describe('spectrumColor', () => {
  it('runs the hue once around the wheel along the line, turned by the shift', () => {
    expect(spectrumColor(0, 0)).toBe(spectrumColor(1, 0));
    expect(spectrumColor(0.25, 0)).toBe(spectrumColor(0, 90));
    expect(spectrumColor(0, -30)).toBe(spectrumColor(0, 330));
  });
});

describe('lissajousSwatch', () => {
  it('is the line color, or a gradient for the spectrum', () => {
    expect(lissajousSwatch('white', '#a68bff')).toBe(LISSAJOUS_WHITE);
    expect(lissajousSwatch('spectrum', '#a68bff')).toMatch(/^linear-gradient\(90deg, hsl\(/);
  });
});
