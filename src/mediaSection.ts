import './mediaSection.css';
import { mediaArt, mediaControl, mediaState, onMediaChanged } from './mediaApi';
import { mediaIcon, type MediaIconName } from './mediaIcon';
import { MediaSlider } from './mediaSlider';
import {
  REPEAT_TITLES,
  formatTime,
  hasTimeline,
  heading,
  positionAt,
  subtitle,
  type MediaCommand,
  type MediaSnapshot,
} from './mediaModel';
import type { MediaPartsShown } from './mediaMenu';
import { shouldPoll, type PollGate } from './pollTimer';

const TICK_MS = 1000;

/**
 * The dashboard's Media section: what an app is playing, its transport, and the master volume
 * (docs/design/dashboard.md section 4.31). It hides itself while no app has a media session.
 */
export class MediaSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly headTitle: HTMLElement;
  private readonly headPlay: HTMLButtonElement;
  private readonly art: HTMLElement;
  private readonly now: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly text: HTMLElement;
  private readonly shuffle: HTMLButtonElement;
  private readonly previous: HTMLButtonElement;
  private readonly play: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly repeat: HTMLButtonElement;
  private readonly mute: HTMLButtonElement;
  private readonly volume: MediaSlider;
  private readonly timeline: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly seek: MediaSlider;
  private readonly total: HTMLElement;
  private snapshot: MediaSnapshot | null = null;
  private artId = 0;
  private artUrl: string | null = null;
  private gate: PollGate = { enabled: false, expanded: false, onScreen: false, windowShown: true };
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section media-section';
    this.el.hidden = true;

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Media';
    this.headTitle = document.createElement('span');
    this.headTitle.className = 'media-head-title';
    this.headPlay = this.button('media-head-play', 'Play or pause', { kind: 'playPause' });
    this.head.append(h, this.headTitle, this.headPlay);

    this.art = document.createElement('div');
    this.art.className = 'media-art';
    this.title = document.createElement('div');
    this.title.className = 'media-title';
    this.sub = document.createElement('div');
    this.sub.className = 'media-sub';
    this.text = document.createElement('div');
    this.text.className = 'media-text';
    this.text.append(this.title, this.sub);
    this.now = document.createElement('div');
    this.now.className = 'media-now';
    this.now.append(this.art, this.text);

    this.shuffle = this.button('media-toggle', 'Shuffle', { kind: 'toggleShuffle' });
    this.previous = this.button('', 'Previous', { kind: 'previous' });
    this.play = this.button('media-play', 'Play or pause', { kind: 'playPause' });
    this.next = this.button('', 'Next', { kind: 'next' });
    this.repeat = this.button('media-toggle', 'Repeat', { kind: 'cycleRepeat' });
    this.setIcon(this.shuffle, 'shuffle');
    this.setIcon(this.previous, 'previous');
    this.setIcon(this.next, 'next');
    const transport = document.createElement('div');
    transport.className = 'media-transport';
    transport.append(this.shuffle, this.previous, this.play, this.next, this.repeat);

    this.mute = this.button('media-mute', 'Mute', { kind: 'toggleMute' });
    const setVolume = (level: number): void => mediaControl({ kind: 'setVolume', level });
    this.volume = new MediaSlider('media-volume', 'Volume', setVolume, setVolume);
    this.volume.el.addEventListener(
      'wheel',
      (e) => {
        const s = this.snapshot;
        if (!s) return;
        e.preventDefault();
        const level = Math.min(1, Math.max(0, s.volume + (e.deltaY < 0 ? 0.05 : -0.05)));
        this.volume.set(level);
        setVolume(level);
      },
      { passive: false },
    );
    const volume = document.createElement('div');
    volume.className = 'media-volume-row';
    volume.append(this.mute, this.volume.el);
    this.head.append(volume);

    const controls = document.createElement('div');
    controls.className = 'media-controls';
    controls.append(transport);

    this.elapsed = document.createElement('span');
    this.total = document.createElement('span');
    this.seek = new MediaSlider(
      'media-seek',
      'Position',
      (f) => {
        if (this.snapshot) this.elapsed.textContent = formatTime(f * this.snapshot.durationMs);
      },
      (f) => {
        if (this.snapshot) mediaControl({ kind: 'seek', positionMs: Math.round(f * this.snapshot.durationMs) });
      },
    );
    this.timeline = document.createElement('div');
    this.timeline.className = 'media-timeline';
    this.timeline.append(this.elapsed, this.seek.el, this.total);

    const body = document.createElement('div');
    body.className = 'dashboard-list media-body';
    body.append(this.now, controls, this.timeline);
    this.el.append(this.head, body);

    mediaState()
      .then((s) => this.apply(s))
      .catch(() => {
        // Without the core (a browser-only run) the section stays hidden.
      });
    onMediaChanged((s) => this.apply(s)).catch((e) => console.warn('media updates unavailable:', e));
  }

  setGate(partial: Partial<PollGate>): void {
    this.gate = { ...this.gate, ...partial };
    this.syncTicker();
  }

  /**
   * `dashboard.mediaArt`, `mediaTitle`, and `mediaArtist`. Without the art the text takes its
   * width; with none of the three the whole row goes, leaving the controls.
   */
  setShown(shown: MediaPartsShown): void {
    this.art.hidden = !shown.art;
    this.title.hidden = !shown.title;
    this.sub.hidden = !shown.artist;
    this.text.hidden = !shown.title && !shown.artist;
    this.now.classList.toggle('no-art', !shown.art);
    this.now.hidden = !shown.art && this.text.hidden;
  }

  private apply(s: MediaSnapshot | null): void {
    this.snapshot = s;
    this.el.hidden = s === null;
    if (s) {
      this.render(s);
      if (s.artId !== this.artId) void this.loadArt(s.artId);
    }
    this.syncTicker();
  }

  private render(s: MediaSnapshot): void {
    const name = heading(s);
    this.title.textContent = name;
    this.title.title = s.album ? `${name}\n${s.album}` : name;
    this.sub.textContent = subtitle(s);
    this.sub.title = s.artist ? `${s.artist} · ${s.app}` : s.app;
    this.headTitle.textContent = name;

    for (const b of [this.play, this.headPlay]) {
      this.setIcon(b, s.playing ? 'pause' : 'play');
      b.disabled = !s.canPlayPause;
      b.title = s.playing ? 'Pause' : 'Play';
      b.setAttribute('aria-label', b.title);
    }
    this.previous.disabled = !s.canPrevious;
    this.next.disabled = !s.canNext;

    this.shuffle.hidden = s.shuffle === null;
    this.shuffle.setAttribute('aria-pressed', String(s.shuffle === true));
    this.shuffle.title = s.shuffle ? 'Shuffle on' : 'Shuffle off';
    this.repeat.hidden = s.repeat === null;
    this.setIcon(this.repeat, s.repeat === 'track' ? 'repeatOne' : 'repeat');
    this.repeat.setAttribute('aria-pressed', String(s.repeat !== null && s.repeat !== 'none'));
    this.repeat.title = REPEAT_TITLES[s.repeat ?? 'none'];

    this.setIcon(this.mute, s.muted || s.volume === 0 ? 'muted' : 'volume');
    this.mute.title = s.muted ? 'Unmute' : 'Mute';
    this.mute.setAttribute('aria-label', this.mute.title);
    this.volume.set(s.volume);
    this.volume.el.classList.toggle('muted', s.muted);

    this.timeline.hidden = !hasTimeline(s);
    this.seek.setDisabled(!s.canSeek);
    this.total.textContent = formatTime(s.durationMs);
    this.renderPosition();
  }

  private renderPosition(): void {
    const s = this.snapshot;
    if (!s || !hasTimeline(s) || this.seek.held) return;
    const ms = positionAt(s, Date.now());
    this.elapsed.textContent = formatTime(ms);
    this.seek.set(ms / s.durationMs);
  }

  /** Counts the position forward only while it moves and someone can see it. */
  private syncTicker(): void {
    const s = this.snapshot;
    const run = s !== null && s.playing && hasTimeline(s) && shouldPoll(this.gate);
    if (run && this.ticker === undefined) {
      this.renderPosition();
      this.ticker = setInterval(() => this.renderPosition(), TICK_MS);
    } else if (!run && this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  private async loadArt(id: number): Promise<void> {
    this.artId = id;
    const bytes = id === 0 ? null : await mediaArt().catch(() => null);
    // A newer track may have arrived while this one's art loaded.
    if (id !== this.artId) return;
    if (this.artUrl) URL.revokeObjectURL(this.artUrl);
    this.artUrl = bytes && bytes.byteLength > 0 ? URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) : null;
    if (this.artUrl) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = this.artUrl;
      this.art.replaceChildren(img);
    } else {
      this.art.replaceChildren(mediaIcon('note'));
    }
  }

  private button(className: string, label: string, command: MediaCommand): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `media-control ${className}`.trim();
    b.title = label;
    b.setAttribute('aria-label', label);
    b.addEventListener('click', () => mediaControl(command));
    return b;
  }

  private setIcon(b: HTMLButtonElement, name: MediaIconName): void {
    if (b.dataset.icon === name) return;
    b.dataset.icon = name;
    b.replaceChildren(mediaIcon(name));
  }
}
