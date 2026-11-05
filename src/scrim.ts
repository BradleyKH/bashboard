// The backdrop's dimming and blur, both applied as a CSS filter on the backdrop canvas so the
// gaps between panes match what sits behind them. Presets are cycled with Ctrl+Shift+B.

export interface ScrimState {
  opacity: number;
  blurPx: number;
}

export const SCRIM_PRESETS = {
  none: 0,
  light: 0.25,
  medium: 0.5,
  heavy: 0.75,
} as const;

const PRESET_OPACITIES: number[] = Object.values(SCRIM_PRESETS);

/** Blur holds at every opacity, none included. */
export function scrimFromSettings(scrim: { opacity: number; blurPx: number }): ScrimState {
  return { opacity: scrim.opacity, blurPx: scrim.blurPx };
}

/**
 * Advances to the next preset strictly darker than the current opacity, wrapping to none.
 * A custom opacity between presets therefore steps to the next preset above it.
 */
export function nextScrim(current: ScrimState, configuredBlurPx: number): ScrimState {
  const opacity = PRESET_OPACITIES.find((o) => o > current.opacity) ?? SCRIM_PRESETS.none;
  return { opacity, blurPx: configuredBlurPx };
}

export function applyScrim(
  root: { style: { setProperty(name: string, value: string): void } },
  state: ScrimState,
): void {
  // A black fill at opacity o scales every pixel by 1 - o, which is what brightness() does.
  root.style.setProperty('--backdrop-brightness', String(1 - state.opacity));
  root.style.setProperty('--backdrop-blur', `${state.blurPx}px`);
}
