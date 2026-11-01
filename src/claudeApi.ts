import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ClaudeContext } from './claudeModel';

/** Every known session's newest context; the first call also starts transcript tracking in the core. */
export function claudeContext(): Promise<ClaudeContext[]> {
  return invoke<ClaudeContext[]>('claude_context');
}

/** Stops transcript tracking and forgets every session; the next `claudeContext` starts it again. */
export function claudeContextStop(): Promise<void> {
  return invoke<void>('claude_context_stop');
}

export function onClaudeContext(cb: (ctx: ClaudeContext) => void): Promise<UnlistenFn> {
  return listen<ClaudeContext>('claude://context', (e) => cb(e.payload));
}
