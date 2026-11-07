// Device size presets for the Local Browser pane (docs/design/browser.md section 4.21). Pure, no DOM.

export interface DevicePreset {
  id: string;
  label: string;
  /** CSS pixels; null for Responsive, which fills the pane. */
  width: number | null;
  height: number | null;
}

export interface Size {
  width: number;
  height: number;
}

export const RESPONSIVE_ID = 'responsive';

export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { id: RESPONSIVE_ID, label: 'Responsive', width: null, height: null },
  { id: 'phone', label: 'Phone 390x844', width: 390, height: 844 },
  { id: 'phone-large', label: 'Phone large 430x932', width: 430, height: 932 },
  { id: 'tablet', label: 'Tablet 820x1180', width: 820, height: 1180 },
  { id: 'laptop', label: 'Laptop 1280x800', width: 1280, height: 800 },
  { id: 'desktop', label: 'Desktop 1920x1080', width: 1920, height: 1080 },
];

/** The preset with this id; a saved id that no longer exists falls back to Responsive. */
export function presetById(id: string | null | undefined): DevicePreset {
  return DEVICE_PRESETS.find((p) => p.id === id) ?? DEVICE_PRESETS[0];
}

/** The preset turned on its side; Responsive has no orientation and is returned unchanged. */
export function rotate(preset: DevicePreset): DevicePreset {
  if (preset.width === null || preset.height === null) return preset;
  return { ...preset, width: preset.height, height: preset.width };
}

/**
 * The factor that makes a fixed preset fit `available` while keeping its aspect ratio. It only
 * shrinks (never above 1), and is 1 for Responsive or while the pane has no measurable size yet.
 */
export function fitScale(preset: DevicePreset, available: Size): number {
  if (preset.width === null || preset.height === null) return 1;
  if (available.width <= 0 || available.height <= 0) return 1;
  return Math.min(1, available.width / preset.width, available.height / preset.height);
}
