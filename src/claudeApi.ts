import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ClaudeContext, ProcFigures } from './claudeModel';

/** Every known session's newest context; the first call also starts transcript tracking in the core. */
export function claudeContext(): Promise<ClaudeContext[]> {
  return invoke<ClaudeContext[]>('claude_context');
}

/** Memory and CPU summed over each root pid's process tree. */
export function claudeProcesses(pids: number[]): Promise<ProcFigures[]> {
  return invoke<ProcFigures[]>('claude_processes', { pids });
}

export function onClaudeContext(cb: (ctx: ClaudeContext) => void): Promise<UnlistenFn> {
  return listen<ClaudeContext>('claude://context', (e) => cb(e.payload));
}
