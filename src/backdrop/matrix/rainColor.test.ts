import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS } from '../../accent';
import { accentRain, MATRIX_GREEN, matrixRainColor } from './rainColor';

describe('matrixRainColor', () => {
  it('draws classic green whatever the accent', () => {
    expect(matrixRainColor('green', '#f0a050')).toBe(MATRIX_GREEN);
  });

  it('turns each accent preset into a full-brightness rain of the same hue', () => {
    const rain = Object.fromEntries(ACCENT_PRESETS.map((p) => [p.label, matrixRainColor('accent', p.value)]));
    expect(rain).toMatchInlineSnapshot(`
      {
        "Blue": "#1279ff",
        "Gold": "#ffc809",
        "Green": "#53ff88",
        "Orange": "#ff8000",
        "Pink": "#ff51f1",
        "Silver": "#c2e0ff",
        "Teal": "#18d7ff",
        "Violet": "#7a51ff",
      }
    `);
  });
});

describe('accentRain', () => {
  it('keeps a gray accent gray', () => {
    expect(accentRain('#808080')).toBe('#ffffff');
  });
});
