import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { invoke } from '@tauri-apps/api/core';
import { isKeyboardContextMenuEvent, openContextMenu } from './contextMenu';
import { item, type MenuEntry, separator } from './contextMenuModel';
import { isTextField } from './textFieldTarget';
import { showToast } from './toast';

export { isTextField };

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

/**
 * The text field menu (docs/design/terminal.md section 4.4), with an owner's extras after a
 * separator.
 */
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

type InputField = HTMLInputElement | HTMLTextAreaElement;

const extrasByField = new WeakMap<Element, () => MenuEntry[]>();

/** Adds items after the standard ones in `field`'s menu, built each time the menu opens. */
export function setTextFieldExtras(field: InputField, provider: () => MenuEntry[]): void {
  extrasByField.set(field, provider);
}

/**
 * What the menu needs from a field, captured when the menu opens: a textarea or input keeps the
 * browser's own editing, and a CodeMirror editor edits through its view.
 */
export interface TextFieldAdapter {
  readonly element: HTMLElement;
  readonly hasSelection: boolean;
  readonly readOnly: boolean;
  /** Where a menu opened from the keyboard goes. */
  anchor(): { x: number; y: number };
  actions(): TextFieldMenuActions;
}

/** The adapter for the field `el` is in, or null when it is not a text field. */
export function textFieldAdapter(el: Element | null): TextFieldAdapter | null {
  if (!isTextField(el)) return null;
  const content = el.closest('.cm-content');
  if (content) {
    const view = EditorView.findFromDOM(content as HTMLElement);
    return view ? editorAdapter(view) : null;
  }
  return inputAdapter(el as InputField);
}

interface Span {
  start: number | null;
  end: number | null;
}

function selectionOf(field: InputField): Span {
  // Some input types (email, number) have no selection API and report null or throw.
  try {
    return { start: field.selectionStart, end: field.selectionEnd };
  } catch {
    return { start: null, end: null };
  }
}

function restore(field: InputField, span: Span): void {
  field.focus();
  if (span.start === null || span.end === null) return;
  try {
    field.setSelectionRange(span.start, span.end);
  } catch {
    // No selection API on this input type.
  }
}

/** Resolves true once `text` is on the clipboard. */
function writeClipboard(text: string): Promise<boolean> {
  return navigator.clipboard.writeText(text).then(
    () => true,
    (e) => {
      showToast(`Could not copy: ${e}`);
      return false;
    },
  );
}

function readClipboard(use: (text: string) => void): void {
  void invoke<string | null>('clipboard_read_text').then(
    (text) => {
      if (text) use(text);
    },
    (e) => showToast(`Could not paste: ${e}`),
  );
}

function inputAdapter(field: InputField): TextFieldAdapter {
  const span = selectionOf(field);
  const isPassword = field instanceof HTMLInputElement && field.type === 'password';
  const selected = (): string => field.value.slice(span.start ?? 0, span.end ?? 0);
  return {
    element: field,
    hasSelection: !isPassword && span.start !== null && span.end !== null && span.start !== span.end,
    readOnly: field.readOnly || field.disabled,
    anchor: () => {
      const rect = field.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom };
    },
    actions: () => ({
      undo: () => {
        restore(field, span);
        document.execCommand('undo');
      },
      copy: () => {
        restore(field, span);
        void writeClipboard(selected());
      },
      cut: () => {
        restore(field, span);
        // execCommand keeps the deletion on the field's undo stack and fires `input` for owners.
        void writeClipboard(selected()).then((copied) => {
          if (!copied || !field.isConnected) return;
          restore(field, span);
          document.execCommand('delete');
        });
      },
      paste: () =>
        readClipboard((text) => {
          if (!field.isConnected) return;
          restore(field, span);
          document.execCommand('insertText', false, text);
        }),
      selectAll: () => {
        field.focus();
        field.select();
      },
    }),
  };
}

function editorAdapter(view: EditorView): TextFieldAdapter {
  const { from, to, head } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to);
  // The document may change while the clipboard is read, so edits clamp to its current length.
  const clamp = (n: number): number => Math.min(n, view.state.doc.length);
  return {
    element: view.contentDOM,
    hasSelection: from !== to,
    readOnly: view.state.readOnly,
    anchor: () => {
      const at = view.coordsAtPos(head);
      if (at) return { x: at.left, y: at.bottom };
      const rect = view.contentDOM.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    },
    actions: () => ({
      undo: () => {
        view.focus();
        undo(view);
      },
      copy: () => void writeClipboard(text),
      cut: () =>
        void writeClipboard(text).then((copied) => {
          if (!copied || view.state.readOnly) return;
          view.dispatch({ changes: { from: clamp(from), to: clamp(to) }, userEvent: 'delete.cut' });
          view.focus();
        }),
      paste: () =>
        readClipboard((pasted) => {
          if (view.state.readOnly) return;
          const insert = view.state.toText(pasted);
          view.dispatch({
            changes: { from: clamp(from), to: clamp(to), insert },
            selection: { anchor: clamp(from) + insert.length },
            userEvent: 'input.paste',
            scrollIntoView: true,
          });
          view.focus();
        }),
      selectAll: () => {
        view.focus();
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      },
    }),
  };
}

let installed = false;

/**
 * Gives every text field outside a terminal its menu (docs/design/terminal.md section 4.4).
 * Owners' `attachContextMenu` listeners let text field events bubble, so one listener on
 * `document` serves inline renames, filters, find bars, dialogs, and the rest.
 */
export function installTextFieldMenu(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('contextmenu', (e) => {
    const field = textFieldAdapter(e.target instanceof Element ? e.target : null);
    if (!field) return;
    const state: TextFieldMenuState = { hasSelection: field.hasSelection, readOnly: field.readOnly };
    const extras = extrasByField.get(field.element)?.() ?? [];
    const entries = textFieldMenuItems(state, field.actions(), extras);
    e.preventDefault();
    if (isKeyboardContextMenuEvent(e)) {
      openContextMenu(entries, field.anchor(), { focusFirst: true });
    } else {
      openContextMenu(entries, { x: e.clientX, y: e.clientY });
    }
  });
}
