/**
 * The two size settings (docs/design/README.md section 5): Interface size (`uiScale`) and the
 * root half of Text size (`font.size`), each published as a CSS custom property on `:root`.
 *
 * How styles.css applies --ui-scale:
 * - Buttons, single-line text boxes, and dropdowns take `zoom` by it, so glyph, padding, and border
 *   grow together and a toolbar row keeps one height. Left out: the Launch buttons (the size the
 *   scale tops out at), the hidden dashboard's 8px edge handle, buttons that read as text (dialog
 *   links, Ship repo rows, Ports column headers), and rename boxes standing in for a row's or tab's
 *   text.
 * - Bars with a fixed px height (pane title strip, tab strip, and offsets below them) multiply it,
 *   and so does text you click or drag: pane and tab titles and their status dots, the dashboard's
 *   section titles, and the find bar's match count.
 * - The app dialog zooms each tab's whole panel instead and widens by the same factor; its controls
 *   reset their own zoom to 1 so the scale applies once.
 * - A control whose font an ancestor already scales would be scaled twice, so the tab strip leaves
 *   its buttons' font explicit and its rename box out.
 * - The dashboard top bar's buttons keep their side padding unscaled, so both menus and the icons
 *   fit up to about 1.4 at the dashboard's minimum width; past that the menu labels ellipsize.
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
