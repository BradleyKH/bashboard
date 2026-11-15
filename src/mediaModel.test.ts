import { describe, expect, it } from 'vitest';
import { formatTime, heading, positionAt, subtitle, type MediaSnapshot } from './mediaModel';

const base: MediaSnapshot = {
  app: 'Spotify',
  title: 'Brandenburg Concerto No. 3',
  artist: 'Johann Sebastian Bach',
  album: 'Bach: Brandenburg Concertos',
  artId: 1,
  playing: true,
  canPlayPause: true,
  canNext: true,
  canPrevious: true,
  canSeek: true,
  shuffle: false,
  repeat: 'none',
  positionMs: 10_000,
  durationMs: 60_000,
  positionAt: 1_000_000,
  volume: 0.5,
  muted: false,
};

describe('positionAt', () => {
  it('counts forward from the report while playing', () => {
    expect(positionAt(base, 1_005_000)).toBe(15_000);
  });

  it('holds still while paused', () => {
    expect(positionAt({ ...base, playing: false }, 1_005_000)).toBe(10_000);
  });

  it('stops at the end of the track', () => {
    expect(positionAt(base, 2_000_000)).toBe(60_000);
  });

  it('does not count from a missing or future report time', () => {
    expect(positionAt({ ...base, positionAt: 0 }, 1_005_000)).toBe(10_000);
    expect(positionAt(base, 999_000)).toBe(10_000);
  });

  it('keeps counting with no known length', () => {
    expect(positionAt({ ...base, durationMs: 0 }, 1_100_000)).toBe(110_000);
  });
});

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(128_400)).toBe('2:08');
    expect(formatTime(336_600)).toBe('5:36');
    expect(formatTime(3_725_000)).toBe('1:02:05');
    expect(formatTime(-5)).toBe('0:00');
  });
});

describe('heading and subtitle', () => {
  it('fall back to the app name', () => {
    expect(heading(base)).toBe('Brandenburg Concerto No. 3');
    expect(subtitle(base)).toBe('Johann Sebastian Bach');
    expect(heading({ ...base, title: ' ' })).toBe('Spotify');
    expect(subtitle({ ...base, artist: '' })).toBe('Spotify');
  });
});
