import { item, separator, type MenuEntry } from './contextMenuModel';

/**
 * The Media section's own menu (docs/design/dashboard.md section 4.31): Show album art, checked
 * while on, then Hide media. Both save the setting; its reload applies the change.
 */
export function mediaMenuItems(
  showArt: boolean,
  onShowArt: (shown: boolean) => void,
  onHide: () => void,
): MenuEntry[] {
  return [item('Show album art', () => onShowArt(!showArt), { checked: showArt }), separator(), item('Hide media', onHide)];
}
