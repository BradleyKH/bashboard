import { chordFromEvent, type Chord } from './keymap';

export interface RecorderCallbacks {
  /** The modifiers currently held, as "Ctrl+Shift+", or "" when none are. */
  onHeld(text: string): void;
  /** A chord with a key. Recording continues; the caller stops it when it is done. */
  onChord(chord: Chord): void;
  /** Escape with no modifiers, or a click outside the kept elements. Recording has stopped. */
  onCancel(): void;
}

const KEY_TYPES = ['keydown', 'keypress', 'keyup'] as const;

function heldText(e: KeyboardEvent): string {
  return (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.metaKey ? 'Win+' : '');
}

function keyId(e: KeyboardEvent): string {
  return e.code || e.key;
}

/**
 * Records one chord at a time for the keybinding editor. Listeners sit on window in the capture
 * phase, which runs before keys.ts, xterm.js, the dialog's own Escape/F1 handler, and
 * Workspace's window listener, so pressing a bound chord records it instead of running it.
 */
export class KeybindingRecorder {
  private callbacks: RecorderCallbacks | null = null;
  private keep: () => HTMLElement[] = () => [];
  /** Keys that went down while recording and have not come up yet. */
  private readonly down = new Set<string>();
  private recording = false;
  private draining = false;

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keydown') {
      this.down.add(keyId(e));
      const chord = chordFromEvent(e);
      if (!chord.key) {
        this.callbacks?.onHeld(heldText(e));
      } else if (chord.key === 'escape' && !chord.ctrl && !chord.alt && !chord.shift && !chord.meta) {
        const callbacks = this.callbacks;
        this.stop();
        callbacks?.onCancel();
      } else {
        this.callbacks?.onChord(chord);
      }
    } else if (e.type === 'keyup') {
      this.down.delete(keyId(e));
      if (!chordFromEvent(e).key) this.callbacks?.onHeld(heldText(e));
    }
  };

  /**
   * After stop, the release of the recorded chord (and the keypress or autorepeat of a key still
   * held) must not reach the shell or the keymap, so those are swallowed until every key that went
   * down while recording is up.
   */
  private readonly onDrainKey = (e: KeyboardEvent): void => {
    const id = keyId(e);
    if (!this.down.has(id)) return;
    if (e.type === 'keydown' && !e.repeat) {
      this.down.delete(id);
      this.endDrainIfIdle();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keyup') {
      this.down.delete(id);
      this.endDrainIfIdle();
    }
  };

  /** Keyups lost to another window would otherwise leave the drain listeners attached. */
  private readonly onBlur = (): void => {
    this.down.clear();
    this.endDrainIfIdle();
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.recording) return;
    const target = e.target;
    if (target instanceof Node && this.keep().some((el) => el.contains(target))) return;
    const callbacks = this.callbacks;
    this.stop();
    callbacks?.onCancel();
  };

  start(callbacks: RecorderCallbacks, keep: () => HTMLElement[]): void {
    if (this.recording) this.detachRecording();
    if (this.draining) this.detachDrain();
    this.callbacks = callbacks;
    this.keep = keep;
    this.recording = true;
    for (const type of KEY_TYPES) window.addEventListener(type, this.onKey, true);
    window.addEventListener('mousedown', this.onMouseDown, true);
    window.addEventListener('blur', this.onBlur);
  }

  stop(): void {
    if (!this.recording) return;
    this.detachRecording();
    this.callbacks = null;
    this.keep = () => [];
    if (this.down.size === 0) {
      window.removeEventListener('blur', this.onBlur);
      return;
    }
    this.draining = true;
    for (const type of KEY_TYPES) window.addEventListener(type, this.onDrainKey, true);
  }

  isRecording(): boolean {
    return this.recording;
  }

  private detachRecording(): void {
    this.recording = false;
    for (const type of KEY_TYPES) window.removeEventListener(type, this.onKey, true);
    window.removeEventListener('mousedown', this.onMouseDown, true);
  }

  private detachDrain(): void {
    this.draining = false;
    for (const type of KEY_TYPES) window.removeEventListener(type, this.onDrainKey, true);
  }

  private endDrainIfIdle(): void {
    if (this.recording || this.down.size > 0) return;
    if (this.draining) this.detachDrain();
    window.removeEventListener('blur', this.onBlur);
  }
}
