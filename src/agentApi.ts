import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AgentContext } from './agentModel';
import type { AgentId } from './savedWorkspace';

/** The agents whose home folder exists on this machine, i.e. that have run here. */
export function agentsDetected(): Promise<AgentId[]> {
  return invoke<AgentId[]>('agents_detected');
}

/** Every known session's newest context; the first call also starts transcript tracking in the core. */
export function agentContext(): Promise<AgentContext[]> {
  return invoke<AgentContext[]>('agent_context');
}

/** Stops transcript tracking and forgets every session; the next `agentContext` starts it again. */
export function agentContextStop(): Promise<void> {
  return invoke<void>('agent_context_stop');
}

export function onAgentContext(cb: (ctx: AgentContext) => void): Promise<UnlistenFn> {
  return listen<AgentContext>('agent://context', (e) => cb(e.payload));
}
