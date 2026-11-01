import { inverseOps, ownerOf } from './keybindingEdit';
import type { NoticeActions } from './keybindingNotice';
import type { Chord, KeybindingEntry } from './keymap';
import type { KeybindingOp } from './settings';

/** A chord a write takes from `ownerId`, flashed once the update shows it gone. */
export interface Taken {
  ownerId: string;
  chord: Chord;
  keys: string;
}

export interface AfterWrite {
  taken?: Taken[];
  notice?: string;
  assignRowId?: string;
}

export interface WriteNotice {
  show(text: string, actions: NoticeActions): void;
  showError(text: string): void;
  clear(): void;
}

export interface KeybindingWritesHost {
  /** Resolves to the raw keybindings array the write replaced. */
  onEdit(ops: KeybindingOp[]): Promise<unknown[]>;
  /** The live keybindings, as of the last hot reload. */
  entries(): KeybindingEntry[];
  notice(): WriteNotice | null;
  isOpen(): boolean;
  assign(rowId: string): void;
  render(): void;
}

const FLASH_MS = 1000;
const PENDING_FLASH_MS = 4000;

/** The shortcut guide's keybinding writes, their Undo, and the row flashes that follow them. */
export class KeybindingWrites {
  private busyFlag = false;
  private pending: { taken: Taken[]; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly flashing = new Map<string, string[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly host: KeybindingWritesHost) {}

  get busy(): boolean {
    return this.busyFlag;
  }

  /** The chords struck through on a flashing row, or undefined when the row is not flashing. */
  flashOf(rowId: string): string[] | undefined {
    return this.flashing.get(rowId);
  }

  async send(ops: KeybindingOp[], after: AfterWrite = {}): Promise<void> {
    if (this.busyFlag || ops.length === 0) return;
    this.busyFlag = true;
    this.host.notice()?.clear();
    const before = this.host.entries();
    // The update can arrive before the write resolves, so the flash waits from the start.
    if (after.taken) this.setPending(after.taken);
    let previous: unknown[];
    try {
      previous = await this.host.onEdit(ops);
    } catch (e) {
      this.dropPending();
      this.host.notice()?.showError(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
      return;
    } finally {
      this.busyFlag = false;
    }
    if (!this.host.isOpen() || !after.notice) return;
    const assignRowId = after.assignRowId;
    this.host.notice()?.show(after.notice, {
      onUndo: () => void this.send(inverseOps(ops, before, previous)),
      onAssign: assignRowId ? () => this.host.assign(assignRowId) : undefined,
    });
  }

  /** Flashes each pending taken chord whose owner the live entries show it has left. */
  consumePending(): void {
    const pending = this.pending;
    if (!pending) return;
    const entries = this.host.entries();
    const left = pending.taken.filter((t) => {
      if (ownerOf(t.chord, entries)?.id === t.ownerId) return true;
      this.flash(t.ownerId, [t.keys]);
      return false;
    });
    if (left.length === 0) this.dropPending();
    else pending.taken = left;
  }

  flash(rowId: string, struck: string[]): void {
    this.flashing.set(rowId, struck);
    this.later(() => {
      if (this.flashing.get(rowId) !== struck) return;
      this.flashing.delete(rowId);
      this.host.render();
    }, FLASH_MS);
  }

  /** Runs `fn` after `ms` unless `dispose` comes first. */
  later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.dropPending();
    this.flashing.clear();
  }

  private setPending(taken: Taken[]): void {
    this.dropPending();
    const timer = setTimeout(() => {
      this.pending = null;
    }, PENDING_FLASH_MS);
    this.pending = { taken, timer };
  }

  private dropPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
