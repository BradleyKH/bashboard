import { describe, expect, it, vi } from 'vitest';
import { applyScrim, nextScrim, scrimFromSettings, SCRIM_PRESETS } from './scrim';

describe('scrimFromSettings', () => {
  it('returns the configured opacity and blur', () => {
    expect(scrimFromSettings({ opacity: 0.6, blurPx: 4 })).toEqual({ opacity: 0.6, blurPx: 4 });
  });

  it('keeps blur at zero opacity', () => {
    expect(scrimFromSettings({ opacity: 0, blurPx: 4 })).toEqual({ opacity: 0, blurPx: 4 });
  });
});

describe('nextScrim', () => {
  it('cycles from the default 0.5 through heavy, none, light, medium, and back to heavy', () => {
    let state = scrimFromSettings({ opacity: 0.5, blurPx: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      state = nextScrim(state, 0);
      seen.push(state.opacity);
    }
    expect(seen).toEqual([
      SCRIM_PRESETS.heavy,
      SCRIM_PRESETS.none,
      SCRIM_PRESETS.light,
      SCRIM_PRESETS.medium,
      SCRIM_PRESETS.heavy,
    ]);
  });

  it('goes to heavy from a custom 0.6', () => {
    expect(nextScrim({ opacity: 0.6, blurPx: 0 }, 0).opacity).toBe(0.75);
  });

  it('goes to none from a custom 0.9', () => {
    expect(nextScrim({ opacity: 0.9, blurPx: 0 }, 0).opacity).toBe(0);
  });

  it('goes to light from a custom 0.1', () => {
    expect(nextScrim({ opacity: 0.1, blurPx: 0 }, 0).opacity).toBe(0.25);
  });

  it('uses the configured blur at every preset, none included', () => {
    expect(nextScrim({ opacity: 0, blurPx: 0 }, 6)).toEqual({ opacity: 0.25, blurPx: 6 });
    expect(nextScrim({ opacity: 0.25, blurPx: 0 }, 6)).toEqual({ opacity: 0.5, blurPx: 6 });
    expect(nextScrim({ opacity: 0.5, blurPx: 6 }, 6)).toEqual({ opacity: 0.75, blurPx: 6 });
    expect(nextScrim({ opacity: 0.75, blurPx: 6 }, 6)).toEqual({ opacity: 0, blurPx: 6 });
  });
});

describe('applyScrim', () => {
  it('sets the backdrop brightness and blur custom properties', () => {
    const setProperty = vi.fn();
    applyScrim({ style: { setProperty } }, { opacity: 0.25, blurPx: 3 });
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenCalledWith('--backdrop-brightness', '0.75');
    expect(setProperty).toHaveBeenCalledWith('--backdrop-blur', '3px');
  });
});
