import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { handleKey, type KeyContext } from './keys';
import { buildKeymap, DEFAULT_KEYBINDINGS, type Action } from './keymap';

const { keymap } = buildKeymap(DEFAULT_KEYBINDINGS);

function ev(type: string, init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: '',
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    ...init,
  } as unknown as KeyboardEvent;
}

const writeText = vi.fn();
let selection = '';
let send: Mock<(data: string) => void>;
let dispatch: Mock<(a: Action) => boolean>;
let term: {
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: Mock<() => void>;
  paste: Mock<(data: string) => void>;
};
let ctx: KeyContext;

beforeEach(() => {
  invoke.mockReset();
  writeText.mockReset();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  selection = '';
  send = vi.fn();
  dispatch = vi.fn(() => true);
  term = {
    hasSelection: () => selection !== '',
    getSelection: () => selection,
    clearSelection: vi.fn(() => {
      selection = '';
    }),
    paste: vi.fn(),
  };
  ctx = { keymap: () => keymap, term, send, dispatch };
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const ctrlC = (type: string) => ev(type, { key: 'c', code: 'KeyC', ctrlKey: true });

describe('handleKey', () => {
  it('passes an unbound key through', () => {
    const e = ev('keydown', { key: 'a', code: 'KeyA' });
    expect(handleKey(e, ctx)).toBe(true);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('sends ESC CR once on Shift+Enter and swallows keypress and keyup', () => {
    const init = { key: 'Enter', code: 'Enter', shiftKey: true };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      const e = ev(type, init);
      expect(handleKey(e, ctx)).toBe(false);
      expect(e.preventDefault).toHaveBeenCalled();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('\x1b\r');
  });

  it('copies on Ctrl+C with a selection and swallows the rest of the key press', () => {
    selection = 'hello';
    expect(handleKey(ctrlC('keydown'), ctx)).toBe(false);
    // The selection is cleared by now; later events must still follow keydown's verdict.
    expect(handleKey(ctrlC('keypress'), ctx)).toBe(false);
    expect(handleKey(ctrlC('keyup'), ctx)).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(term.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('passes Ctrl+C through without a selection', () => {
    const e = ctrlC('keydown');
    expect(handleKey(e, ctx)).toBe(true);
    expect(handleKey(ctrlC('keyup'), ctx)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('passes Ctrl+Shift+C through without a selection', () => {
    const e = ev('keydown', { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(handleKey(e, ctx)).toBe(true);
  });

  it('pastes clipboard text on Ctrl+V', async () => {
    invoke.mockResolvedValue('abc');
    const e = ev('keydown', { key: 'v', code: 'KeyV', ctrlKey: true });
    expect(handleKey(e, ctx)).toBe(false);
    await flush();
    expect(invoke).toHaveBeenCalledWith('clipboard_read_text');
    expect(term.paste).toHaveBeenCalledWith('abc');
    expect(send).not.toHaveBeenCalled();
  });

  it('sends ^V when the clipboard has no text, and swallows keypress without re-reading', async () => {
    invoke.mockResolvedValue(null);
    const init = { key: 'v', code: 'KeyV', ctrlKey: true };
    expect(handleKey(ev('keydown', init), ctx)).toBe(false);
    expect(handleKey(ev('keypress', init), ctx)).toBe(false);
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('\x16');
  });

  it('dispatches a workspace action once per keydown and swallows the rest of the key', () => {
    const init = { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true };
    expect(handleKey(ev('keydown', init), ctx)).toBe(false);
    expect(handleKey(ev('keypress', init), ctx)).toBe(false);
    expect(handleKey(ev('keyup', init), ctx)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'splitRight' });
  });

  it('dispatches cycleScrim on Ctrl+Shift+B and swallows the rest of the key', () => {
    const init = { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true };
    expect(handleKey(ev('keydown', init), ctx)).toBe(false);
    expect(handleKey(ev('keypress', init), ctx)).toBe(false);
    expect(handleKey(ev('keyup', init), ctx)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'cycleScrim' });
  });

  it('dispatches toggleDashboard on Ctrl+Shift+S and swallows the rest of the key', () => {
    const init = { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true };
    expect(handleKey(ev('keydown', init), ctx)).toBe(false);
    expect(handleKey(ev('keypress', init), ctx)).toBe(false);
    expect(handleKey(ev('keyup', init), ctx)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleDashboard' });
  });

  it.each([
    { key: 'M', code: 'KeyM', type: 'collapsePane' },
    { key: 'Z', code: 'KeyZ', type: 'togglePaneZoom' },
    { key: 'O', code: 'KeyO', type: 'openFavorite' },
    { key: 'P', code: 'KeyP', type: 'openLayout' },
    { key: 'T', code: 'KeyT', type: 'newTab' },
    { key: 'N', code: 'KeyN', type: 'newScratch' },
    { key: 'E', code: 'KeyE', type: 'openFiles' },
    { key: 'G', code: 'KeyG', type: 'openGit' },
    { key: 'H', code: 'KeyH', type: 'openSearch' },
    { key: 'W', code: 'KeyW', type: 'closeTab' },
    { key: 'F', code: 'KeyF', type: 'find' },
  ])('dispatches $type on Ctrl+Shift+$key and swallows the rest of the key', ({ key, code, type }) => {
    const init = { key, code, ctrlKey: true, shiftKey: true };
    expect(handleKey(ev('keydown', init), ctx)).toBe(false);
    expect(handleKey(ev('keypress', init), ctx)).toBe(false);
    expect(handleKey(ev('keyup', init), ctx)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type });
  });

  it.each([
    { init: { key: '=', code: 'Equal', ctrlKey: true }, action: { type: 'increaseFontSize' } },
    { init: { key: '-', code: 'Minus', ctrlKey: true }, action: { type: 'decreaseFontSize' } },
    { init: { key: '0', code: 'Digit0', ctrlKey: true }, action: { type: 'resetFontSize' } },
    { init: { key: 'Tab', code: 'Tab', ctrlKey: true }, action: { type: 'nextTab' } },
    { init: { key: '3', code: 'Digit3', ctrlKey: true, altKey: true }, action: { type: 'switchToTab', index: 3 } },
  ])('dispatches $action.type once and swallows the rest of the key', ({ init, action }) => {
    expect(handleKey(ev('keydown', init), ctx)).toBe(false);
    expect(handleKey(ev('keypress', init), ctx)).toBe(false);
    expect(handleKey(ev('keyup', init), ctx)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(action);
  });

  it('remembers an unhandled workspace dispatch so keypress and keyup match keydown', () => {
    dispatch.mockReturnValue(false);
    const init = { key: 'w', code: 'KeyW', ctrlKey: true };
    for (const type of ['keydown', 'keypress', 'keyup']) {
      expect(handleKey(ev(type, init), ctx)).toBe(true);
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
