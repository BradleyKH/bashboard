import { invoke } from '@tauri-apps/api/core';
import { isKeyboardContextMenuEvent, openContextMenu } from './contextMenu';
import { item, type MenuEntry, separator } from './contextMenuModel';
import { showToast } from './toast';

export interface TextFieldMenuState {
  hasSelection: boolean;
  readOnly: boolean;
}

export interface TextFieldMenuActions {
  undo: () => void;
  cut: () => void;
  copy: () => void;
  paste: () => void;
  selectAll: () => void;
}

/** The text field menu (docs/v0.2.0-design.md section 11.3), with an owner's extras after a separator. */
export function textFieldMenuItems(
  state: TextFieldMenuState,
  actions: TextFieldMenuActions,
  extras: MenuEntry[] = [],
): MenuEntry[] {
  const { hasSelection, readOnly } = state;
  const entries: MenuEntry[] = [
    item('Undo', actions.undo, { enabled: !readOnly }),
    item('Cut', actions.cut, { enabled: hasSelection && !readOnly }),
    item('Copy', actions.copy, { enabled: hasSelection }),
    item('Paste', actions.paste, { enabled: !readOnly }),
    item('Select all', actions.selectAll),
  ];
  if (extras.length > 0) entries.push(separator(), ...extras);
  return entries;
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);

/** A textarea or text-like input outside a terminal (xterm.js's helper textarea is not one). */
export function isTextField(el: Element | null): el is TextField {
  if (!el || el.closest('.xterm')) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  return tag === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

const extrasByField = new WeakMap<TextField, () => MenuEntry[]>();

/** Adds items after the standard ones in `field`'s menu, built each time the menu opens. */
export function setTextFieldExtras(field: TextField, provider: () => MenuEntry[]): void {
  extrasByField.set(field, provider);
}

interface Range {
  start: number | null;
  end: number | null;
}

function selectionOf(field: TextField): Range {
  // Some input types (email, number) have no selection API and report null or throw.
  try {
    return { start: field.selectionStart, end: field.selectionEnd };
  } catch {
    return { start: null, end: null };
  }
}

function restore(field: TextField, range: Range): void {
  field.focus();
  if (range.start === null || range.end === null) return;
  try {
    field.setSelectionRange(range.start, range.end);
  } catch {
    // No selection API on this input type.
  }
}

/** Resolves true once the selected text is on the clipboard. */
function writeSelection(field: TextField, range: Range): Promise<boolean> {
  const text = field.value.slice(range.start ?? 0, range.end ?? 0);
  return navigator.clipboard.writeText(text).then(
    () => true,
    (e) => {
      showToast(`Could not copy: ${e}`);
      return false;
    },
  );
}

function actionsFor(field: TextField, range: Range): TextFieldMenuActions {
  return {
    undo: () => {
      restore(field, range);
      document.execCommand('undo');
    },
    copy: () => {
      restore(field, range);
      void writeSelection(field, range);
    },
    cut: () => {
      restore(field, range);
      // execCommand keeps the deletion on the field's undo stack and fires `input` for owners.
      void writeSelection(field, range).then((copied) => {
        if (!copied || !field.isConnected) return;
        restore(field, range);
        document.execCommand('delete');
      });
    },
    paste: () => {
      void invoke<string | null>('clipboard_read_text').then(
        (text) => {
          if (!text || !field.isConnected) return;
          restore(field, range);
          document.execCommand('insertText', false, text);
        },
        (e) => showToast(`Could not paste: ${e}`),
      );
    },
    selectAll: () => {
      field.focus();
      field.select();
    },
  };
}

let installed = false;

/**
 * Gives every text field outside a terminal its menu (docs/v0.2.0-design.md section 11.3).
 * Owners' `attachContextMenu` listeners let text field events bubble, so one listener on
 * `document` serves inline renames, filters, find bars, dialogs, and the rest.
 */
export function installTextFieldMenu(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('contextmenu', (e) => {
    const field = e.target instanceof Element ? e.target : null;
    if (!isTextField(field)) return;
    const range = selectionOf(field);
    const isPassword = field instanceof HTMLInputElement && field.type === 'password';
    const state: TextFieldMenuState = {
      hasSelection: !isPassword && range.start !== null && range.end !== null && range.start !== range.end,
      readOnly: field.readOnly || field.disabled,
    };
    const extras = extrasByField.get(field)?.() ?? [];
    e.preventDefault();
    if (isKeyboardContextMenuEvent(e)) {
      const rect = field.getBoundingClientRect();
      openContextMenu(
        textFieldMenuItems(state, actionsFor(field, range), extras),
        { x: rect.left, y: rect.bottom },
        { focusFirst: true },
      );
    } else {
      openContextMenu(textFieldMenuItems(state, actionsFor(field, range), extras), { x: e.clientX, y: e.clientY });
    }
  });
}
