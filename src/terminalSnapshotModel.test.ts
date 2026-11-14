import { describe, expect, it } from 'vitest';
import { background, foreground, paletteColor, rgbColor } from './terminalSnapshotModel';

describe('paletteColor', () => {
  it('prefers the theme, then falls back to xterm.js colors', () => {
    expect(paletteColor(1, { red: '#ff0000' })).toBe('#ff0000');
    expect(paletteColor(1, {})).toBe('#cc0000');
    expect(paletteColor(15, {})).toBe('#eeeeec');
  });

  it('computes the color cube and the gray ramp', () => {
    expect(paletteColor(16, {})).toBe('#000000');
    expect(paletteColor(196, {})).toBe('#ff0000');
    expect(paletteColor(231, {})).toBe('#ffffff');
    expect(paletteColor(232, {})).toBe('#080808');
    expect(paletteColor(255, {})).toBe('#eeeeee');
  });

  it('takes an extended slot from the theme', () => {
    const extendedAnsi: string[] = [];
    extendedAnsi[231 - 16] = '#abcdef';
    expect(paletteColor(231, { extendedAnsi })).toBe('#abcdef');
    expect(paletteColor(230, { extendedAnsi })).toBe('#ffffd7');
  });
});

describe('cell colors', () => {
  it('reads truecolor', () => {
    expect(rgbColor(0x12ab34)).toBe('#12ab34');
    expect(foreground({ mode: 'rgb', packed: 0x010203 }, false, {})).toBe('#010203');
  });

  it('brightens the first eight colors when bold', () => {
    expect(foreground({ mode: 'palette', index: 2 }, true, {})).toBe('#8ae234');
    expect(foreground({ mode: 'palette', index: 2 }, false, {})).toBe('#4e9a06');
    expect(foreground({ mode: 'palette', index: 100 }, true, {})).toBe(paletteColor(100, {}));
  });

  it('leaves defaults to the caller', () => {
    expect(foreground({ mode: 'default' }, true, {})).toBeNull();
    expect(background({ mode: 'default' }, {})).toBeNull();
    expect(background({ mode: 'palette', index: 4 }, {})).toBe('#3465a4');
  });
});
