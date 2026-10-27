import { describe, expect, it, vi } from 'vitest';
import { applyScrim, nextScrim, scrimFromSettings, SCRIM_PRESETS } from './scrim';

describe('scrimFromSettings', () => {
  it('returns the configured opacity and blur', () => {
    expect(scrimFromSettings({ opacity: 0.6, blurPx: 4 })).toEqual({ opacity: 0.6, blurPx: 4 });
  });

  it('drops blur at zero opacity, like the none preset', () => {
    expect(scrimFromSettings({ opacity: 0, blurPx: 4 })).toEqual({ opacity: 0, blurPx: 0 });
  });
});

describe('nextScrim', () => {
  it('cycles from the default 0.5 through none, light, medium, and back to none', () => {
    let state = scrimFromSettings({ opacity: 0.5, blurPx: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      state = nextScrim(state, 0);
      seen.push(state.opacity);
    }
    expect(seen).toEqual([SCRIM_PRESETS.none, SCRIM_PRESETS.light, SCRIM_PRESETS.medium, SCRIM_PRESETS.none]);
  });

  it('goes to none from a custom 0.6', () => {
    expect(nextScrim({ opacity: 0.6, blurPx: 0 }, 0).opacity).toBe(0);
  });

  it('goes to light from a custom 0.1', () => {
    expect(nextScrim({ opacity: 0.1, blurPx: 0 }, 0).opacity).toBe(0.25);
  });

  it('uses the configured blur for nonzero opacity and 0 at none', () => {
    expect(nextScrim({ opacity: 0, blurPx: 0 }, 6)).toEqual({ opacity: 0.25, blurPx: 6 });
    expect(nextScrim({ opacity: 0.25, blurPx: 0 }, 6)).toEqual({ opacity: 0.5, blurPx: 6 });
    expect(nextScrim({ opacity: 0.5, blurPx: 6 }, 6)).toEqual({ opacity: 0, blurPx: 0 });
  });
});

describe('applyScrim', () => {
  it('sets the opacity and blur custom properties', () => {
    const setProperty = vi.fn();
    applyScrim({ style: { setProperty } }, { opacity: 0.25, blurPx: 3 });
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenCalledWith('--scrim-opacity', '0.25');
    expect(setProperty).toHaveBeenCalledWith('--scrim-blur', '3px');
  });
});
