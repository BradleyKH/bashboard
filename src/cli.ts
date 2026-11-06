import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/**
 * A resolved `bb` request; mirrors `CliAction` in the Rust core (docs/design/app.md section 3.13).
 */
export type CliAction =
  | { kind: 'open'; path: string; isDir: boolean; root: string }
  | { kind: 'edit'; path: string; line?: number | null }
  | { kind: 'git'; root: string }
  | { kind: 'search'; root: string; query?: string | null }
  | { kind: 'scratch'; text: string }
  | { kind: 'term'; cwd: string; command?: string | null }
  | { kind: 'ship'; root?: string | null }
  | { kind: 'ports' }
  | { kind: 'containers' };

/** Payload of `cli://command`; `ptyId` is the core's pty id, not a `p<n>` pane id. */
export interface CliCommand {
  ptyId: number;
  collapsed: boolean;
  /** Opens the pane alone in a new tab instead of as a split of the calling pane. */
  tab: boolean;
  action: CliAction;
}

export function onCliCommand(cb: (cmd: CliCommand) => void): Promise<UnlistenFn> {
  return listen<CliCommand>('cli://command', (e) => cb(e.payload));
}
