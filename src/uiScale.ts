/**
 * The two size settings (docs/design/README.md section 5): Interface size (`uiScale`) and the
 * root half of Text size (`font.size`), each published as a CSS custom property on `:root`.
 */
export const UI_SCALE_MIN = 1;
export const UI_SCALE_MAX = 2;

/** The `font.size` at which pane text renders at its designed px size. */
export const TEXT_SCALE_BASE_PX = 14;

type StyleRoot = { style: { setProperty(name: string, value: string): void } };

/** Sets --ui-scale, which styles.css applies to controls through `zoom` and to bar heights and chrome text. */
export function applyUiScale(root: StyleRoot, scale: number): void {
  const clamped = Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, scale));
  root.style.setProperty('--ui-scale', String(clamped));
}

/**
 * Sets --text-scale, `font.size` relative to its default, for pane text designed at a fixed px
 * size (the Files list, Markdown and CSV previews, the Git diff). Relative rather than absolute so
 * those surfaces keep their designed sizes at the default instead of all jumping to 14px.
 */
export function applyTextScale(root: StyleRoot, fontSize: number): void {
  root.style.setProperty('--text-scale', String(fontSize / TEXT_SCALE_BASE_PX));
}
