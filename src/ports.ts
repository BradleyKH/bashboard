import { invoke } from '@tauri-apps/api/core';

/** One listening TCP port and the process behind it (docs/design.md section 4.19). */
export interface Listener {
  port: number;
  /** Local addresses for this port, IPv4 first. */
  addresses: string[];
  pid: number;
  /** Seconds since the epoch; with `pid`, it names the process across pid reuse. */
  startedAt: number;
  name: string;
  /** The full command line, or '' when Windows would not share it. */
  command: string;
  cwd: string | null;
  /** The core's pty id of the pane that started it, when it traces to one. */
  ptyId: number | null;
  /** A live ancestor is a shell or Claude Code. */
  fromShell: boolean;
  /** A Windows service or the kernel. */
  system: boolean;
  /** Bashboard itself. */
  own: boolean;
}

export function listPorts(): Promise<Listener[]> {
  return invoke<Listener[]>('ports_list');
}

/** Ends the process and its children; fails when it has exited or its pid now names another process. */
export function stopPort(l: Listener): Promise<void> {
  return invoke('ports_stop', { pid: l.pid, startedAt: l.startedAt });
}
