import type { EditRow } from './keybindingEdit';
import { formatChord } from './helpModel';
import { parseChord } from './keymap';

export interface RowView {
  /** `target` is 'add' or the keys string of the keycap being replaced. */
  recording?: { target: 'add' | string; text: string; message?: string; dimMessage?: boolean };
  /** Chords just taken from this row, shown crossed out. */
  struck?: string[];
  flash?: boolean;
}

export interface RowCallbacks {
  onAdd(row: EditRow): void;
  onReplace(row: EditRow, keys: string): void;
  onRemove(row: EditRow, keys: string): void;
  onReset(row: EditRow): void;
}

function button(className: string, text: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = text;
  b.title = title;
  return b;
}

function div(className: string, text?: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  if (text !== undefined) d.textContent = text;
  return d;
}

function display(keys: string): string {
  const c = parseChord(keys);
  return c ? formatChord(c) : keys;
}

function recordingField(text: string): HTMLElement {
  const s = document.createElement('span');
  s.className = 'kb-recording';
  s.textContent = text;
  return s;
}

/** One editable row of the shortcut guide (docs/design/keys.md section 4.5). */
export function renderKeybindingRow(row: EditRow, view: RowView, callbacks: RowCallbacks): HTMLElement {
  const el = div(view.flash ? 'kb-row kb-flash' : 'kb-row');
  el.dataset.rowId = row.id;

  const labelCell = div('kb-label');
  const label = document.createElement('span');
  label.className = 'kb-label-text';
  label.textContent = row.label;
  labelCell.append(label);
  if (row.modified) {
    const dot = document.createElement('span');
    dot.className = 'kb-dot';
    dot.title = 'Differs from the default';
    labelCell.append(dot);
  }
  if (row.note) labelCell.append(div('shortcuts-tab-note', row.note));
  for (const note of row.shellNotes) labelCell.append(div('kb-shell-note', note));

  const keysCell = div('kb-keys');
  const rec = view.recording;
  const line = div('kb-keys-line');

  for (const keys of row.chords) {
    if (rec && rec.target === keys) {
      line.append(recordingField(rec.text));
      continue;
    }
    const shown = display(keys);
    const cap = document.createElement('kbd');
    cap.className = 'kb-key';
    const capButton = button('kb-key-button', shown, `Replace ${shown}`);
    capButton.addEventListener('click', () => callbacks.onReplace(row, keys));
    const x = button('kb-remove', 'x', `Remove ${shown}`);
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onRemove(row, keys);
    });
    cap.append(capButton, x);
    line.append(cap);
  }

  for (const keys of view.struck ?? []) {
    const cap = document.createElement('kbd');
    cap.className = 'kb-key kb-struck';
    cap.textContent = display(keys);
    line.append(cap);
  }

  if (row.chords.length === 0 && !(rec && rec.target === 'add')) {
    const none = document.createElement('span');
    none.className = 'kb-none';
    none.textContent = 'No key';
    line.append(none);
  }

  if (rec && rec.target === 'add') {
    line.append(recordingField(rec.text));
  } else {
    const add = button('kb-add', '+', `Add a key for ${row.label}`);
    add.addEventListener('click', () => callbacks.onAdd(row));
    line.append(add);
  }

  if (row.modified) {
    const reset = button('kb-reset', 'Reset', `Restore the default keys for ${row.label}`);
    reset.addEventListener('click', () => callbacks.onReset(row));
    line.append(reset);
  }

  keysCell.append(line);
  if (rec?.message) keysCell.append(div(rec.dimMessage ? 'kb-message kb-message-dim' : 'kb-message', rec.message));

  el.append(labelCell, keysCell);
  return el;
}
