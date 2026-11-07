import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { actionFromEntry, type Action, type KeybindingEntry } from './keymap';

/** Payload of `browser://chord`: an app binding pressed while a Local Browser page had focus. */
interface BrowserChord {
  paneId: string;
  binding: KeybindingEntry;
}

/**
 * Runs app keybindings pressed inside a Local Browser page. Keys typed into the frame never
 * reach `keys.ts`, so the core catches bound chords before the page sees them
 * (docs/design/browser.md section 4.21).
 */
export function onBrowserChord(run: (action: Action) => boolean): Promise<UnlistenFn> {
  return listen<BrowserChord>('browser://chord', ({ payload }) => {
    const action = actionFromEntry(payload.binding);
    if (action) run(action);
  });
}
