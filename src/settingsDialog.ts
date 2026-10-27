import { getVersion } from '@tauri-apps/api/app';
import type { SettingsPayload } from './settings';
import type { ShellProfile } from './profiles';
import { listEditors, type Editor } from './editors';
import { appliesNote, installedChoices, isShown, parseInput, readField, SETTINGS_SECTIONS, type SettingsField } from './settingsModel';

export interface SettingsDialogCallbacks {
  /** Dismissed; the caller refocuses the terminal. */
  onClose(): void;
  onSave(path: string[], value: unknown): Promise<void>;
  onOpenFile(): Promise<void>;
  /** The shells the core can launch, for fields limited to installed options. */
  getProfiles(): ShellProfile[];
  /** Run setup was clicked; the dialog has already closed without onClose. */
  onRunSetup(): void;
  /** Check for updates was clicked; the dialog stays open. Omit to hide the button. */
  onCheckForUpdates?(): void;
}

const SLIDER_DEBOUNCE_MS = 250;
const DEFAULT_EDITOR: Editor = { id: 'default', name: "The file's default app" };

interface Control {
  field: SettingsField;
  labelCell: HTMLElement;
  cell: HTMLElement;
  error: HTMLElement;
  /** The last value read from the file or sent to onSave; saves equal to it are skipped. */
  last: unknown;
  show(value: unknown): void;
  /** Slider only: a debounced save waiting to fire. */
  pending?: () => void;
  /** Typed inputs only: the current raw value, committed on close so Escape keeps an edit. */
  read?: () => string;
}

/** The settings editor; each control writes one value to settings.json (docs/design.md section 8). */
export class SettingsDialog {
  private backdrop: HTMLElement | null = null;
  private warnings: HTMLElement | null = null;
  private controls: Control[] = [];
  /** The editors the core found; just `default` until the list arrives or when it cannot be read. */
  private editors: Editor[] = [DEFAULT_EDITOR];

  constructor(private readonly callbacks: SettingsDialogCallbacks) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(payload: SettingsPayload): void {
    if (this.backdrop) this.close();

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-dialog-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'settings-dialog';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Settings');
    box.addEventListener('keydown', (e) => this.onKey(e));

    const header = document.createElement('div');
    header.className = 'settings-dialog-header';
    const title = document.createElement('h2');
    title.textContent = 'Settings';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'settings-dialog-close';
    close.textContent = '×';
    close.title = 'Close (Escape)';
    close.addEventListener('click', () => this.dismiss());
    header.append(title, close);

    const warnings = document.createElement('div');
    warnings.className = 'settings-dialog-warnings';
    warnings.setAttribute('role', 'status');
    this.warnings = warnings;

    const body = document.createElement('div');
    body.className = 'settings-dialog-body';
    this.controls = [];
    for (const section of SETTINGS_SECTIONS) {
      const el = document.createElement('section');
      const h = document.createElement('h3');
      h.textContent = section.title;
      const rows = document.createElement('div');
      rows.className = 'settings-dialog-rows';
      for (const field of section.fields) rows.append(...this.row(field));
      el.append(h, rows);
      body.append(el);
    }

    box.append(header, warnings, body, this.footer());
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.update(payload);
    box.focus();
    void this.loadEditors(backdrop);
  }

  private async loadEditors(owner: HTMLElement): Promise<void> {
    try {
      const found = await listEditors();
      if (found.length > 0) this.editors = found;
    } catch {
      return;
    }
    if (this.backdrop !== owner) return;
    const active = document.activeElement;
    for (const c of this.controls) {
      if (c.field.installedFrom !== 'editors' || (active && c.cell.contains(active))) continue;
      c.show(c.last);
    }
  }

  /** Refreshes from a reloaded file, leaving the control being edited alone. */
  update(payload: SettingsPayload): void {
    if (!this.backdrop || !this.warnings) return;
    this.warnings.replaceChildren(
      ...payload.warnings.map((w) => {
        const p = document.createElement('p');
        p.textContent = w;
        return p;
      }),
    );
    this.warnings.hidden = payload.warnings.length === 0;

    const active = document.activeElement;
    for (const c of this.controls) {
      if (c.pending || (active && c.cell.contains(active))) continue;
      const value = readField(payload.settings, c.field.path);
      c.last = value;
      c.show(value);
      setError(c, '');
    }
    this.applyVisibility();
  }

  /** Hides fields whose `shownWhen` doesn't hold, judged from each control's last saved value. */
  private applyVisibility(): void {
    const read = (path: string[]): unknown => this.controls.find((c) => c.field.path.join('.') === path.join('.'))?.last;
    for (const c of this.controls) {
      const hide = !isShown(c.field, read);
      c.labelCell.hidden = hide;
      c.cell.hidden = hide;
    }
  }

  close(): void {
    const active = document.activeElement;
    for (const c of this.controls) {
      c.pending?.();
      // Only the focused input can hold an edit that blur hasn't committed yet.
      if (c.read && active && c.cell.contains(active)) this.commit(c, c.read());
    }
    this.controls = [];
    this.backdrop?.remove();
    this.backdrop = null;
    this.warnings = null;
  }

  private row(field: SettingsField): HTMLElement[] {
    const id = `settings-${field.path.join('-')}`;

    const labelCell = document.createElement('div');
    labelCell.className = 'settings-dialog-label';
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = field.label;
    labelCell.append(label);
    const noteText = [field.hint, appliesNote(field)].filter((s) => s).join('. ');
    const describedBy: string[] = [];
    if (noteText) {
      const note = document.createElement('div');
      note.className = 'settings-dialog-note';
      note.id = `${id}-note`;
      note.textContent = noteText;
      labelCell.append(note);
      describedBy.push(note.id);
    }

    const cell = document.createElement('div');
    cell.className = 'settings-dialog-control';
    const error = document.createElement('div');
    error.className = 'settings-dialog-error';
    error.id = `${id}-error`;
    error.setAttribute('role', 'alert');
    error.hidden = true;
    describedBy.push(error.id);

    const control: Control = { field, labelCell, cell, error, last: undefined, show: () => {} };
    const input = this.input(control);
    input.id = id;
    input.setAttribute('aria-describedby', describedBy.join(' '));
    cell.prepend(input);
    cell.append(error);
    this.controls.push(control);
    return [labelCell, cell];
  }

  /** Builds the field's input, wires its save trigger, and sets control.show. */
  private input(c: Control): HTMLElement {
    const f = c.field;
    if (f.kind === 'toggle') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'settings-dialog-toggle';
      box.addEventListener('change', () => this.commit(c, box.checked));
      c.show = (v) => (box.checked = v === true);
      return box;
    }

    if (f.kind === 'select') {
      const sel = document.createElement('select');
      sel.className = 'settings-dialog-input';
      const fill = (options: { value: string; label: string }[]): void => {
        sel.replaceChildren(
          ...options.map((o) => {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            return opt;
          }),
        );
      };
      sel.addEventListener('change', () => this.commit(c, sel.value));
      if (f.installedFrom) {
        const warn = document.createElement('div');
        warn.className = 'settings-dialog-note';
        warn.hidden = true;
        c.cell.append(warn);
        c.show = (v) => {
          const installed = f.installedFrom === 'editors' ? this.editors : this.callbacks.getProfiles();
          const choices = installedChoices(f.options ?? [], installed, v, f.installedFrom);
          fill(choices.options);
          warn.textContent = choices.note ?? '';
          warn.hidden = !choices.note;
          if (typeof v === 'string') sel.value = v;
        };
      } else {
        fill(f.options ?? []);
        c.show = (v) => {
          if (typeof v === 'string') sel.value = v;
        };
      }
      return sel;
    }

    if (f.kind === 'slider') {
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'settings-dialog-slider';
      if (f.min !== undefined) range.min = String(f.min);
      if (f.max !== undefined) range.max = String(f.max);
      if (f.step !== undefined) range.step = String(f.step);
      const readout = document.createElement('span');
      readout.className = 'settings-dialog-readout';
      readout.setAttribute('aria-hidden', 'true');
      let timer: number | undefined;
      const flush = (): void => {
        window.clearTimeout(timer);
        c.pending = undefined;
        this.commit(c, range.value);
      };
      range.addEventListener('input', () => {
        readout.textContent = formatSlider(f, Number(range.value));
        window.clearTimeout(timer);
        c.pending = flush;
        timer = window.setTimeout(flush, SLIDER_DEBOUNCE_MS);
      });
      c.show = (v) => {
        if (typeof v === 'number') range.value = String(v);
        readout.textContent = formatSlider(f, Number(range.value));
      };
      c.cell.append(readout);
      return range;
    }

    if (f.kind === 'list') {
      const area = document.createElement('textarea');
      area.className = 'settings-dialog-input settings-dialog-list';
      area.rows = 3;
      area.spellcheck = false;
      area.addEventListener('blur', () => this.commit(c, area.value));
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          this.commit(c, area.value);
        }
      });
      c.show = (v) => (area.value = Array.isArray(v) ? v.join('\n') : '');
      c.read = () => area.value;
      return area;
    }

    const input = document.createElement('input');
    input.className = 'settings-dialog-input';
    input.spellcheck = false;
    if (f.kind === 'number') {
      input.type = 'number';
      input.classList.add('settings-dialog-number');
      if (f.min !== undefined) input.min = String(f.min);
      if (f.max !== undefined) input.max = String(f.max);
      if (f.step !== undefined) input.step = String(f.step);
      if (f.unit) {
        const unit = document.createElement('span');
        unit.className = 'settings-dialog-unit';
        unit.textContent = f.unit;
        c.cell.append(unit);
      }
    } else {
      input.type = 'text';
    }
    input.addEventListener('blur', () => this.commit(c, input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit(c, input.value);
      }
    });
    c.show = (v) => (input.value = v === undefined || v === null ? '' : String(v));
    c.read = () => input.value;
    return input;
  }

  private commit(c: Control, raw: string | boolean): void {
    const parsed = parseInput(c.field, raw);
    if (!parsed.ok) {
      setError(c, parsed.error);
      return;
    }
    setError(c, '');
    if (JSON.stringify(parsed.value) === JSON.stringify(c.last)) return;
    const previous = c.last;
    c.last = parsed.value;
    this.applyVisibility();
    this.callbacks.onSave(c.field.path, parsed.value).catch((err: unknown) => {
      setError(c, errorText(err));
      if (c.last !== parsed.value) return; // a later edit or reload superseded this one
      if (c.read) {
        // Keep the typed text for a retry, and forget the value so the same input saves again.
        c.last = undefined;
      } else {
        // Toggles and sliders show the file's value again, since nothing was written.
        c.last = previous;
        c.show(previous);
        this.applyVisibility();
      }
    });
  }

  private footer(): HTMLElement {
    const footer = document.createElement('div');
    footer.className = 'settings-dialog-footer';

    const actions = document.createElement('div');
    actions.className = 'settings-dialog-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'settings-dialog-open';
    open.textContent = 'Open settings.json';
    const error = document.createElement('span');
    error.className = 'settings-dialog-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    open.addEventListener('click', () => {
      error.hidden = true;
      this.callbacks.onOpenFile().catch((err: unknown) => {
        error.textContent = errorText(err);
        error.hidden = false;
      });
    });
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'settings-dialog-open';
    setup.textContent = 'Run setup';
    // close(), not dismiss(): onClose would refocus a terminal under the wizard.
    setup.addEventListener('click', () => {
      this.close();
      this.callbacks.onRunSetup();
    });
    actions.append(open, setup);
    const checkForUpdates = this.callbacks.onCheckForUpdates;
    if (checkForUpdates) {
      const update = document.createElement('button');
      update.type = 'button';
      update.className = 'settings-dialog-open';
      update.textContent = 'Check for updates';
      update.addEventListener('click', () => checkForUpdates());
      actions.append(update);
    }
    actions.append(error);

    const note = document.createElement('p');
    note.className = 'settings-dialog-note';
    note.textContent = 'Keybindings are edited in settings.json, in the "keybindings" list.';

    const version = document.createElement('p');
    version.className = 'settings-dialog-note';
    version.hidden = true;
    // Fails outside Tauri (plain browser); the line just stays hidden.
    getVersion()
      .then((v) => {
        version.textContent = `Bashboard ${v}`;
        version.hidden = false;
      })
      .catch(() => {});

    footer.append(actions, note, version);
    return footer;
  }

  private dismiss(): void {
    this.close();
    this.callbacks.onClose();
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
    }
  }
}

function setError(c: Control, message: string): void {
  c.error.textContent = message;
  c.error.hidden = message === '';
  c.cell.classList.toggle('invalid', message !== '');
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatSlider(field: SettingsField, value: number): string {
  const decimals = field.step !== undefined ? (String(field.step).split('.')[1] ?? '').length : 0;
  const text = value.toFixed(decimals);
  return field.unit ? `${text} ${field.unit}` : text;
}
