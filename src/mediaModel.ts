// The dashboard's Media section (docs/design/dashboard.md section 4.31). Pure, no DOM.

/** The core's `MediaSnapshot` (docs/design/dashboard.md section 3.29). */
export interface MediaSnapshot {
  app: string;
  title: string;
  artist: string;
  album: string;
  /** Changes with the album art; 0 while there is none. */
  artId: number;
  playing: boolean;
  canPlayPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
  canSeek: boolean;
  /** Null when the app does not offer shuffle. */
  shuffle: boolean | null;
  /** Null when the app does not offer repeat. */
  repeat: RepeatMode | null;
  positionMs: number;
  durationMs: number;
  /** Unix ms when the app last reported `positionMs`. */
  positionAt: number;
  volume: number;
  muted: boolean;
}

export type RepeatMode = 'none' | 'track' | 'list';

export type MediaCommand =
  | { kind: 'playPause' }
  | { kind: 'next' }
  | { kind: 'previous' }
  | { kind: 'toggleShuffle' }
  | { kind: 'cycleRepeat' }
  | { kind: 'seek'; positionMs: number }
  | { kind: 'setVolume'; level: number }
  | { kind: 'toggleMute' };

/**
 * Where the track is at `now`: apps report the position only when it changes, so while playing
 * it counts forward from the report, held within the track. A report time of 0 or one in the
 * future (a clock skew) counts as just now.
 */
export function positionAt(s: MediaSnapshot, now: number): number {
  let ms = s.positionMs;
  if (s.playing && s.positionAt > 0 && s.positionAt <= now) ms += now - s.positionAt;
  return s.durationMs > 0 ? Math.min(Math.max(0, ms), s.durationMs) : Math.max(0, ms);
}

/** `m:ss`, or `h:mm:ss` from an hour on. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** The muted line under the title: the artist, else the app playing it. */
export function subtitle(s: MediaSnapshot): string {
  return s.artist.trim() || s.app;
}

/** The title, else the app, so a session with no metadata still names itself. */
export function heading(s: MediaSnapshot): string {
  return s.title.trim() || s.app;
}

export const REPEAT_TITLES: Record<RepeatMode, string> = {
  none: 'Repeat off',
  list: 'Repeat all',
  track: 'Repeat one',
};

/** Whether the track has a known length the position bar can show. */
export function hasTimeline(s: MediaSnapshot): boolean {
  return s.durationMs > 0;
}
