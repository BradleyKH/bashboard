import type { ConfirmOptions } from './confirmDialog';
import { FIXED_SECTION, formatChord, type HelpSection } from './helpModel';
import {
  addOps,
  checkChord,
  editSections,
  filterSections,
  movedNoticeText,
  moveStripText,
  ownerOf,
  removeOps,
  replaceOps,
  resetAllOps,
  resetPlan,
  resetStripText,
  type EditRow,
  type EditSection,
} from './keybindingEdit';
import { renderMoveStrip } from './keybindingMoveStrip';
import { KeybindingNotice } from './keybindingNotice';
import { KeybindingRecorder } from './keybindingRecorder';
import { renderKeybindingRow, type RowCallbacks, type RowView } from './keybindingRow';
import { KeybindingWrites } from './keybindingWrites';
import { chordId, chordKeys, parseChord, type Chord, type KeybindingEntry } from './keymap';
import type { KeybindingOp } from './settings';

export interface HelpDialogCallbacks {
  /** Dismissed; the caller refocuses the terminal. */
  onClose(): void;
  /**
   * Saves keybinding edits and resolves to the raw keybindings array they replaced, for Undo. The
   * rows change only through the `update` that hot reload brings.
   */
  onEdit(ops: KeybindingOp[]): Promise<unknown[]>;
  confirm(options: ConfirmOptions): Promise<boolean>;
}

interface Recording {
  rowId: string;
  /** 'add', or the keys string of the keycap being replaced. */
  target: string;
  text: string;
  /** The conflicting chord the field holds while the move strip is open. */
  held?: string;
  message?: string;
}

type Strip =
  | { kind: 'move'; rowId: string; chord: Chord; owner: EditRow; leavesEmpty: boolean }
  | { kind: 'reset'; rowId: string; ops: KeybindingOp[]; takes: { keys: string; owner: EditRow }[] };

function noModifiers(c: Chord): boolean {
  return !c.ctrl && !c.alt && !c.shift && !c.meta;
}

/** The F1 keyboard shortcut guide and keybinding editor (docs/design.md section 4.5). */
export class HelpDialog {
  private backdrop: HTMLElement | null = null;
  private box: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private filterInput: HTMLInputElement | null = null;
  private findButton: HTMLButtonElement | null = null;
  private resetAllButton: HTMLButtonElement | null = null;
  private notice: KeybindingNotice | null = null;
  private stripElement: HTMLElement | null = null;
  private readonly recorder = new KeybindingRecorder();

  private entries: KeybindingEntry[] = [];
  private sections: EditSection[] = [];
  private filter = '';
  private recording: Recording | null = null;
  private finding = false;
  private strip: Strip | null = null;
  private readonly writes: KeybindingWrites;
  private mouseDown = false;
  private renderOnMouseUp = false;

  private readonly rowCallbacks: RowCallbacks = {
    onAdd: (row) => this.startRecording(row, 'add'),
    onReplace: (row, keys) => this.startRecording(row, keys),
    onRemove: (_row, keys) => {
      this.stopRecording();
      this.render();
      void this.writes.send(removeOps(keys));
    },
    onReset: (row) => this.resetRow(row),
  };

  constructor(private readonly callbacks: HelpDialogCallbacks) {
    this.writes = new KeybindingWrites({
      onEdit: (ops) => this.callbacks.onEdit(ops),
      entries: () => this.entries,
      notice: () => this.notice,
      isOpen: () => this.isOpen(),
      assign: (rowId) => this.assign(rowId),
      render: () => this.render(),
    });
  }

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(entries: KeybindingEntry[]): void {
    if (this.backdrop) this.close();

    const backdrop = document.createElement('div');
    backdrop.className = 'help-dialog-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'help-dialog';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Keyboard shortcuts');
    box.addEventListener('keydown', (e) => this.onKey(e));

    const header = document.createElement('div');
    header.className = 'help-dialog-header';
    const title = document.createElement('h2');
    title.textContent = 'Keyboard shortcuts';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'help-dialog-close';
    close.textContent = '×';
    close.title = 'Close (Escape)';
    close.addEventListener('click', () => this.dismiss());
    header.append(title, close);

    const bar = document.createElement('div');
    bar.className = 'help-dialog-bar';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'help-dialog-filter';
    filter.placeholder = 'Filter actions';
    filter.spellcheck = false;
    filter.addEventListener('input', () => {
      this.filter = filter.value;
      this.render();
    });
    const find = document.createElement('button');
    find.type = 'button';
    find.className = 'help-dialog-find';
    find.title = 'Press a key to find the action it runs';
    find.addEventListener('click', () => this.startFind());
    bar.append(filter, find);

    const body = document.createElement('div');
    body.className = 'help-dialog-body';

    const notice = new KeybindingNotice();

    const footer = document.createElement('div');
    footer.className = 'help-dialog-footer';
    const resetAll = document.createElement('button');
    resetAll.type = 'button';
    resetAll.className = 'help-dialog-reset-all';
    resetAll.textContent = 'Reset all';
    resetAll.title = 'Use the default key for every action';
    resetAll.addEventListener('click', () => void this.resetAll());
    const note = document.createElement('span');
    note.className = 'help-dialog-footer-note';
    note.textContent = 'Keys that type text are added to the "keybindings" list in settings.json.';
    footer.append(resetAll, note);

    box.append(header, bar, body, notice.element, footer);
    backdrop.append(box);
    document.body.append(backdrop);

    this.backdrop = backdrop;
    this.box = box;
    this.body = body;
    this.filterInput = filter;
    this.findButton = find;
    this.resetAllButton = resetAll;
    this.notice = notice;
    this.filter = '';
    // Registered before any recorder start, so these run ahead of the recorder's own capture listener.
    window.addEventListener('mousedown', this.onWindowMouseDown, true);
    window.addEventListener('mouseup', this.onWindowMouseUp, true);

    this.setEntries(entries);
    this.render();
    box.focus();
  }

  /** New live keybindings from hot reload; the only path that changes the rows. */
  update(entries: KeybindingEntry[]): void {
    if (!this.backdrop) return;
    this.setEntries(entries);
    this.writes.consumePending();
    this.reconcile();
    this.render();
  }

  close(): void {
    this.recorder.stop();
    this.notice?.dispose();
    this.writes.dispose();
    window.removeEventListener('mousedown', this.onWindowMouseDown, true);
    window.removeEventListener('mouseup', this.onWindowMouseUp, true);
    this.backdrop?.remove();
    this.backdrop = null;
    this.box = null;
    this.body = null;
    this.filterInput = null;
    this.findButton = null;
    this.resetAllButton = null;
    this.notice = null;
    this.stripElement = null;
    this.recording = null;
    this.finding = false;
    this.strip = null;
    this.mouseDown = false;
    this.renderOnMouseUp = false;
  }

  private setEntries(entries: KeybindingEntry[]): void {
    this.entries = entries;
    this.sections = editSections(entries);
  }

  private findRow(id: string): EditRow | undefined {
    for (const s of this.sections) {
      const row = s.rows.find((r) => r.id === id);
      if (row) return row;
    }
    return undefined;
  }

  private rowElement(id: string): HTMLElement | undefined {
    if (!this.body) return undefined;
    return [...this.body.querySelectorAll<HTMLElement>('.kb-row')].find((el) => el.dataset.rowId === id);
  }

  // Rendering

  private render(): void {
    const body = this.body;
    if (!body) return;
    const scroll = body.scrollTop;
    const active = document.activeElement;
    let focusRow: string | undefined;
    let focusTitle: string | undefined;
    if (active instanceof HTMLElement && body.contains(active)) {
      focusRow = active.closest<HTMLElement>('.kb-row')?.dataset.rowId;
      focusTitle = active.title;
    }

    this.stripElement = null;
    const visible = filterSections(this.sections, this.filter);
    const q = this.filter.trim().toLowerCase();
    const fixedRows = FIXED_SECTION.rows.filter((r) => r.label.toLowerCase().includes(q));
    body.replaceChildren(...visible.map((s) => this.sectionElement(s)));
    if (fixedRows.length > 0) body.append(this.fixedElement({ ...FIXED_SECTION, rows: fixedRows }));
    body.scrollTop = scroll;

    if (focusRow !== undefined) {
      const row = this.rowElement(focusRow);
      const target = [...(row?.querySelectorAll<HTMLElement>('button') ?? [])].find((b) => b.title === focusTitle);
      (target ?? this.box)?.focus({ preventScroll: true });
    }

    if (this.resetAllButton) this.resetAllButton.disabled = !this.sections.some((s) => s.rows.some((r) => r.modified));
    if (this.findButton) {
      this.findButton.classList.toggle('kb-finding', this.finding);
      if (!this.finding) this.findButton.textContent = 'Find by key';
    }
  }

  private sectionElement(section: EditSection): HTMLElement {
    const el = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = section.title;
    const rows = document.createElement('div');
    rows.className = 'help-dialog-rows';
    for (const row of section.rows) {
      const view: RowView = {};
      const rec = this.recording;
      if (rec && rec.rowId === row.id) view.recording = { target: rec.target, text: rec.text, message: rec.message };
      const struck = this.writes.flashOf(row.id);
      if (struck) {
        view.flash = true;
        if (struck.length > 0) view.struck = struck;
      }
      rows.append(renderKeybindingRow(row, view, this.rowCallbacks));
      if (this.strip?.rowId === row.id) {
        this.stripElement = this.stripView(this.strip);
        rows.append(this.stripElement);
      }
    }
    el.append(h, rows);
    return el;
  }

  private stripView(strip: Strip): HTMLElement {
    if (strip.kind === 'move') {
      return renderMoveStrip(
        moveStripText(chordKeys(strip.chord), strip.owner, strip.leavesEmpty),
        () => this.confirmMove(),
        () => {
          this.stopRecording();
          this.render();
        },
      );
    }
    return renderMoveStrip(
      resetStripText(strip.takes),
      () => this.confirmReset(),
      () => {
        this.strip = null;
        this.render();
      },
      'Move',
    );
  }

  private fixedElement(section: HelpSection): HTMLElement {
    const el = document.createElement('section');
    const h = document.createElement('h3');
    h.textContent = section.title;
    const rows = document.createElement('div');
    rows.className = 'help-dialog-rows';
    for (const row of section.rows) {
      const r = document.createElement('div');
      r.className = 'kb-row kb-row-fixed';
      const label = document.createElement('div');
      label.className = 'kb-label';
      label.textContent = row.label;
      if (row.note) {
        const note = document.createElement('div');
        note.className = 'help-dialog-note';
        note.textContent = row.note;
        label.append(note);
      }
      const keys = document.createElement('div');
      keys.className = 'kb-keys-line';
      keys.append(
        ...row.keys.map((k) => {
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          return kbd;
        }),
      );
      r.append(label, keys);
      rows.append(r);
    }
    el.append(h, rows);
    return el;
  }

  // Recording

  private keepElements(): HTMLElement[] {
    const field = this.body?.querySelector<HTMLElement>('.kb-recording');
    return [field, this.stripElement, this.findButton].filter((el): el is HTMLElement => !!el);
  }

  private startRecording(row: EditRow, target: string): void {
    this.strip = null;
    this.finding = false;
    this.recording = { rowId: row.id, target, text: 'Press keys' };
    this.recorder.start(
      {
        onHeld: (text) => this.onHeld(text),
        onChord: (chord) => this.onRowChord(chord),
        onCancel: () => this.onRecordCancel(),
      },
      () => this.keepElements(),
    );
    this.render();
  }

  private stopRecording(): void {
    this.recorder.stop();
    this.recording = null;
    this.finding = false;
    if (this.strip?.kind === 'move') this.strip = null;
  }

  private onHeld(text: string): void {
    if (this.finding) {
      if (this.findButton) this.findButton.textContent = text || 'Press keys';
      return;
    }
    const rec = this.recording;
    if (!rec) return;
    rec.text = text || rec.held || 'Press keys';
    // Patched in place: a full render would rebuild every row and restart any flash animation.
    const field = this.body?.querySelector<HTMLElement>('.kb-recording');
    if (field) field.textContent = rec.text;
    else this.render();
  }

  private onRecordCancel(): void {
    this.recording = null;
    this.finding = false;
    if (this.strip?.kind === 'move') this.strip = null;
    // A click elsewhere cancels on mousedown; re-rendering then would replace the button under
    // the pointer and lose its click, so the render waits for the mouseup.
    if (this.mouseDown) this.renderOnMouseUp = true;
    else this.render();
  }

  private readonly onWindowMouseDown = (): void => {
    this.mouseDown = true;
  };

  private readonly onWindowMouseUp = (): void => {
    this.mouseDown = false;
    if (!this.renderOnMouseUp) return;
    this.renderOnMouseUp = false;
    this.writes.later(() => this.render(), 0);
  };

  private onRowChord(chord: Chord): void {
    const rec = this.recording;
    const row = rec && this.findRow(rec.rowId);
    if (!rec || !row) {
      this.stopRecording();
      this.render();
      return;
    }
    if (this.strip?.kind === 'move' && chord.key === 'enter' && noModifiers(chord)) {
      this.confirmMove();
      return;
    }
    const check = checkChord(chord, row, this.entries);
    switch (check.kind) {
      case 'refused':
        rec.message = check.message;
        rec.text = 'Press keys';
        rec.held = undefined;
        this.strip = null;
        this.render();
        return;
      case 'same':
        this.stopRecording();
        this.render();
        this.notice?.show('Already bound here', {});
        return;
      case 'free': {
        const ops = rec.target === 'add' ? addOps(row, chord) : replaceOps(row, rec.target, chord);
        this.stopRecording();
        this.render();
        void this.writes.send(ops);
        return;
      }
      case 'conflict':
        rec.held = formatChord(chord);
        rec.text = rec.held;
        rec.message = undefined;
        this.strip = { kind: 'move', rowId: row.id, chord, owner: check.owner, leavesEmpty: check.leavesEmpty };
        this.render();
        return;
    }
  }

  private confirmMove(): void {
    const strip = this.strip;
    const rec = this.recording;
    const row = rec && this.findRow(rec.rowId);
    if (!strip || strip.kind !== 'move' || !rec || !row || this.writes.busy) return;
    const ops = rec.target === 'add' ? addOps(row, strip.chord) : replaceOps(row, rec.target, strip.chord);
    const id = chordId(strip.chord);
    const keys = strip.owner.chords.find((k) => chordId(parseChord(k)!) === id) ?? chordKeys(strip.chord);
    this.stopRecording();
    this.render();
    void this.writes.send(ops, {
      taken: [{ ownerId: strip.owner.id, chord: strip.chord, keys }],
      notice: movedNoticeText(keys, strip.owner),
      assignRowId: strip.leavesEmpty ? strip.owner.id : undefined,
    });
  }

  private startFind(): void {
    if (this.finding) return;
    this.stopRecording();
    this.strip = null;
    this.finding = true;
    if (this.findButton) this.findButton.textContent = 'Press keys';
    this.recorder.start(
      {
        onHeld: (text) => this.onHeld(text),
        onChord: (chord) => this.onFindChord(chord),
        onCancel: () => this.onRecordCancel(),
      },
      () => this.keepElements(),
    );
    this.render();
  }

  private onFindChord(chord: Chord): void {
    this.stopRecording();
    const owner = ownerOf(chord, this.entries);
    if (!owner) {
      this.render();
      this.notice?.show('Not bound: reaches the shell', {});
      return;
    }
    this.reveal(owner.id);
    this.writes.flash(owner.id, []);
    this.render();
    this.rowElement(owner.id)?.scrollIntoView({ block: 'center' });
  }

  /** Clears the filter when it hides the row. */
  private reveal(rowId: string): void {
    const shown = filterSections(this.sections, this.filter).some((s) => s.rows.some((r) => r.id === rowId));
    if (shown) return;
    this.filter = '';
    if (this.filterInput) this.filterInput.value = '';
  }

  private assign(rowId: string): void {
    const row = this.findRow(rowId);
    if (!row || !this.backdrop) return;
    this.reveal(rowId);
    this.startRecording(row, 'add');
    this.rowElement(rowId)?.scrollIntoView({ block: 'center' });
  }

  // Reset

  private resetRow(row: EditRow): void {
    if (this.writes.busy) return;
    this.stopRecording();
    const plan = resetPlan(row, this.entries);
    if (plan.takes.length === 0) {
      this.strip = null;
      this.render();
      void this.writes.send(plan.ops);
      return;
    }
    this.strip = { kind: 'reset', rowId: row.id, ops: plan.ops, takes: plan.takes };
    this.render();
  }

  private confirmReset(): void {
    const strip = this.strip;
    if (!strip || strip.kind !== 'reset' || this.writes.busy) return;
    this.strip = null;
    this.render();
    void this.writes.send(strip.ops, {
      taken: strip.takes.map((t) => ({ ownerId: t.owner.id, chord: parseChord(t.keys)!, keys: t.keys })),
      notice: strip.takes.map((t) => movedNoticeText(t.keys, t.owner)).join('; '),
    });
  }

  private async resetAll(): Promise<void> {
    if (this.writes.busy) return;
    this.stopRecording();
    this.strip = null;
    this.render();
    const ok = await this.callbacks.confirm({
      title: 'Reset all keys',
      body: ['Remove every custom key and use the defaults?'],
      confirmLabel: 'Reset all',
    });
    if (!this.backdrop) return;
    this.box?.focus();
    if (ok) await this.writes.send(resetAllOps(), { notice: 'Every key uses its default' });
  }

  /** Keeps an active recording and an open strip in step with new entries. */
  private reconcile(): void {
    const rec = this.recording;
    if (rec) {
      const row = this.findRow(rec.rowId);
      if (!row) {
        this.stopRecording();
      } else if (rec.target !== 'add' && !row.chords.includes(rec.target)) {
        rec.target = 'add';
      }
    }
    const strip = this.strip;
    if (!strip) return;
    const row = this.findRow(strip.rowId);
    if (!row) {
      this.strip = null;
      return;
    }
    if (strip.kind === 'move') {
      if (!this.recording) {
        this.strip = null;
        return;
      }
      const check = checkChord(strip.chord, row, this.entries);
      if (check.kind === 'conflict') {
        this.strip = { ...strip, owner: check.owner, leavesEmpty: check.leavesEmpty };
      } else {
        this.strip = null;
        this.recording!.held = undefined;
        this.recording!.text = 'Press keys';
      }
      return;
    }
    const plan = resetPlan(row, this.entries);
    this.strip = plan.takes.length === 0 ? null : { ...strip, ops: plan.ops, takes: plan.takes };
  }

  private dismiss(): void {
    this.close();
    this.callbacks.onClose();
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm. While recording, the recorder's
    // capture listener has already swallowed the key, so this sees only keys typed outside it.
    e.stopPropagation();
    const strip = this.strip;
    if (strip?.kind === 'reset' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.strip = null;
        this.render();
        return;
      }
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.confirmReset();
        return;
      }
    }
    if (e.key === 'Escape' || e.key === 'F1') {
      e.preventDefault();
      this.dismiss();
    }
  }
}
