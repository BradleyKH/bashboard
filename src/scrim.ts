// Darkening layer over the backdrop. Presets are cycled with Ctrl+Shift+B.

export interface ScrimState {
  opacity: number;
  blurPx: number;
}

export const SCRIM_PRESETS = {
  none: 0,
  light: 0.25,
  medium: 0.45,
} as const;

const PRESET_OPACITIES: number[] = Object.values(SCRIM_PRESETS);

/** Zero opacity means no scrim at all, matching the "none" preset, so blur is dropped too. */
export function scrimFromSettings(scrim: { opacity: number; blurPx: number }): ScrimState {
  return { opacity: scrim.opacity, blurPx: scrim.opacity === 0 ? 0 : scrim.blurPx };
}

/**
 * Advances to the next preset strictly darker than the current opacity, wrapping to none.
 * A custom opacity between presets therefore steps to the next preset above it.
 */
export function nextScrim(current: ScrimState, configuredBlurPx: number): ScrimState {
  const opacity = PRESET_OPACITIES.find((o) => o > current.opacity) ?? SCRIM_PRESETS.none;
  return { opacity, blurPx: opacity === 0 ? 0 : configuredBlurPx };
}

export function applyScrim(
  root: { style: { setProperty(name: string, value: string): void } },
  state: ScrimState,
): void {
  root.style.setProperty('--scrim-opacity', String(state.opacity));
  root.style.setProperty('--scrim-blur', `${state.blurPx}px`);
}
