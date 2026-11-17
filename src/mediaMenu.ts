import { item, separator, type MenuEntry } from './contextMenuModel';

/** The parts of the Media section's now-playing block that can be turned off. */
export type MediaPart = 'art' | 'title' | 'artist';

export type MediaPartsShown = Record<MediaPart, boolean>;

/** The `dashboard` setting behind each part. */
export const MEDIA_PART_SETTINGS: Record<MediaPart, 'mediaArt' | 'mediaTitle' | 'mediaArtist'> = {
  art: 'mediaArt',
  title: 'mediaTitle',
  artist: 'mediaArtist',
};

const LABELS: [MediaPart, string][] = [
  ['art', 'Show album art'],
  ['title', 'Show title'],
  ['artist', 'Show artist'],
];

/**
 * The Media section's own menu (docs/design/dashboard.md section 4.31): Show album art, Show
 * title, and Show artist, each checked while on, then Hide media. Each saves its setting; the
 * setting's reload applies the change.
 */
export function mediaMenuItems(
  shown: MediaPartsShown,
  onSetShown: (part: MediaPart, shown: boolean) => void,
  onHide: () => void,
): MenuEntry[] {
  return [
    ...LABELS.map(([part, label]) => item(label, () => onSetShown(part, !shown[part]), { checked: shown[part] })),
    separator(),
    item('Hide media', onHide),
  ];
}
