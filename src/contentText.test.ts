import { describe, expect, it } from 'vitest';
import { ACCENT_PRESETS, DEFAULT_ACCENT, relativeLuminance } from './accent';
import { accentTint, CONTENT_TEXT_MIN_LUMINANCE, contentTextColor, terminalWhites, WHITE_TEXT } from './contentText';

describe('terminalWhites', () => {
  it('tints the default foreground, bright white, and cube white only', () => {
    const t = terminalWhites('#b5d8df');
    expect(t.foreground).toBe('#b5d8df');
    expect(t.brightWhite).toBe('#b5d8df');
    expect(t).not.toHaveProperty('white');
    expect(t.extendedAnsi[231 - 16]).toBe('#b5d8df');
    expect(t.extendedAnsi.filter((c) => c !== undefined)).toHaveLength(1);
  });
});

describe('accentTint', () => {
  it('reproduces the pale tint of every accent preset', () => {
    const expected: Record<string, string> = {
      Silver: '#d4dadf',
      Orange: '#edd1b5',
      Gold: '#e8ddb5',
      Green: '#bfdec9',
      Teal: '#b5d8df',
      Blue: '#b9d0ed',
      Violet: '#d4caf3',
      Pink: '#e8c4e5',
    };
    for (const p of ACCENT_PRESETS) expect(accentTint(p.value), p.label).toBe(expected[p.label]);
  });

  it('keeps a dim accent above the text floor', () => {
    // #5050ff sits near the accent floor; a straight 35% mix would land below 0.5.
    expect(relativeLuminance(accentTint('#5050ff'))).toBeGreaterThanOrEqual(CONTENT_TEXT_MIN_LUMINANCE);
  });
});

describe('contentTextColor', () => {
  it('tints the accent, or gives white whatever the accent', () => {
    expect(contentTextColor('accent', DEFAULT_ACCENT)).toBe('#b5d8df');
    expect(contentTextColor('white', '#f0a050')).toBe(WHITE_TEXT);
  });
});
