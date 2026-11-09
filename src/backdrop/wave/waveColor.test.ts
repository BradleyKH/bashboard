import { describe, expect, it } from 'vitest';
import { WAVE_WHITE, waveLineColor, waveSwatch, spectrumColor } from './waveColor';

describe('waveLineColor', () => {
  it('resolves accent to the vivid accent, white to white, and passes spectrum through', () => {
    expect(waveLineColor('accent', '#a68bff')).toBe('#7a51ff');
    expect(waveLineColor('white', '#a68bff')).toBe(WAVE_WHITE);
    expect(waveLineColor('spectrum', '#a68bff')).toBe('spectrum');
  });
});

describe('spectrumColor', () => {
  it('runs the hue once around the wheel along the line, turned by the shift', () => {
    expect(spectrumColor(0, 0)).toBe(spectrumColor(1, 0));
    expect(spectrumColor(0.25, 0)).toBe(spectrumColor(0, 90));
    expect(spectrumColor(0, -30)).toBe(spectrumColor(0, 330));
  });
});

describe('waveSwatch', () => {
  it('is the line color, or a gradient for the spectrum', () => {
    expect(waveSwatch('white', '#a68bff')).toBe(WAVE_WHITE);
    expect(waveSwatch('spectrum', '#a68bff')).toMatch(/^linear-gradient\(90deg, hsl\(/);
  });
});
