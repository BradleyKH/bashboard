import { invoke } from '@tauri-apps/api/core';
import type { Terminal } from '@xterm/xterm';
import { lookup, type Action, type Keymap } from './keymap';

export interface KeyContext {
  keymap: () => Keymap;
  term: Pick<Terminal, 'hasSelection' | 'getSelection' | 'clearSelection' | 'paste'>;
  send(data: string): void;
  /** Runs a workspace action (split, close, focus, resize); returns whether it was handled. */
  dispatch(action: Action): boolean;
}

// Whether keydown's dispatch handled a workspace key, by physical key. keypress and keyup
// must reach the same verdict without dispatching again.
const dispatched = new Map<string, boolean>();

/**
 * Keymap-driven key handling (docs/design.md section 4.5). Returns true when xterm.js
 * should process the key, matching attachCustomKeyEventHandler.
 */
export function handleKey(e: KeyboardEvent, ctx: KeyContext): boolean {
  const action = lookup(ctx.keymap(), e);
  if (!action || !isHandled(e, action, ctx)) return true;
  // xterm.js also acts on the keypress that follows a keydown, so a handled key must be
  // swallowed for every event type or Ctrl+V still reaches the shell as a literal ^V.
  e.preventDefault();
  return false;
}

function isHandled(e: KeyboardEvent, action: Action, ctx: KeyContext): boolean {
  const down = e.type === 'keydown';
  switch (action.type) {
    case 'copy': {
      // Copying clears the selection on keydown, so keypress and keyup follow the keydown verdict.
      if (!down) return verdictForRest(e, false);
      const handled = ctx.term.hasSelection();
      if (handled) {
        void navigator.clipboard.writeText(ctx.term.getSelection());
        ctx.term.clearSelection();
      }
      dispatched.set(e.code, handled);
      return handled;
    }
    case 'paste':
      if (down) paste(ctx);
      return true;
    case 'sendInput':
      if (down) ctx.send(action.input);
      return true;
    case 'splitRight':
    case 'splitDown':
    case 'splitAuto':
    case 'closePane':
    case 'moveFocus':
    case 'resizePane':
    case 'cycleScrim':
    case 'toggleBackdrop':
    case 'toggleDashboard':
    case 'focusDashboard':
    case 'collapsePane':
    case 'togglePaneZoom':
    case 'openFavorite':
    case 'openLayout':
    case 'splitWithProfile':
    case 'showHelp':
    case 'openSettings':
    case 'toggleFullscreen':
    case 'newTab':
    case 'newScratch':
    case 'openFiles':
    case 'openGit':
    case 'openSearch':
    case 'closeTab':
    case 'nextTab':
    case 'prevTab':
    case 'switchToTab':
    case 'switchToLastTab':
    case 'increaseFontSize':
    case 'decreaseFontSize':
    case 'resetFontSize':
    case 'find': {
      if (down) {
        const handled = ctx.dispatch(action);
        dispatched.set(e.code, handled);
        return handled;
      }
      return verdictForRest(e, true);
    }
    default:
      return false;
  }
}

function verdictForRest(e: KeyboardEvent, fallback: boolean): boolean {
  const handled = dispatched.get(e.code) ?? fallback;
  if (e.type === 'keyup') dispatched.delete(e.code);
  return handled;
}

/**
 * Pastes clipboard text (bracketed when the app asked for it). With no text on the clipboard,
 * passes ^V through so Claude Code can read an image from the clipboard itself.
 */
function paste(ctx: KeyContext): void {
  void invoke<string | null>('clipboard_read_text').then((text) => {
    if (text) ctx.term.paste(text);
    else ctx.send('\x16');
  });
}
