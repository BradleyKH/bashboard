import { invoke } from '@tauri-apps/api/core';
import { showToast } from './toast';

/** An editor the core detected (docs/design/files.md section 3.12). */
export interface Editor {
  id: string;
  name: string;
}

export function listEditors(): Promise<Editor[]> {
  return invoke<Editor[]>('editors');
}

/** What the core returns for a terminal editor (Vim, Neovim): a program to run in a new pane. */
interface TerminalLaunch {
  argv: string[];
  cwd: string;
}

type TerminalEditorHost = (argv: string[], cwd: string) => void;

let terminalEditorHost: TerminalEditorHost | null = null;

/**
 * Sets what opens a terminal editor's pane. The callers of `openInEditor` are spread across the
 * panes and have no workspace of their own, so `main.ts` registers it once.
 */
export function setTerminalEditorHost(host: TerminalEditorHost): void {
  terminalEditorHost = host;
}

/**
 * Opens a file or folder in the preferred editor, toasting when it falls back or fails. A terminal
 * editor opens in a new pane beside the focused one.
 */
export async function openInEditor(path: string, line?: number): Promise<void> {
  try {
    const r = await invoke<{ fallback: boolean; terminal?: TerminalLaunch }>('open_in_editor', {
      path,
      line: line ?? null,
    });
    if (r.terminal) terminalEditorHost?.(r.terminal.argv, r.terminal.cwd);
    if (r.fallback) showToast('The preferred editor was not found; opened in the default app.');
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}

/** Whether the file can open in its default app: it exists and would not run as a program. */
export function canOpenWithDefaultApp(path: string): Promise<boolean> {
  return invoke<boolean>('can_open_with_default_app', { path }).catch(() => false);
}

/** Opens a file in the app Windows associates with it, toasting on failure. */
export async function openWithDefaultApp(path: string): Promise<void> {
  try {
    await invoke('open_with_default_app', { path });
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  }
}
