import { pickAgentPane, type AgentTerminal } from './fixWithAgentModel';
import { onHookEvent } from './sessions';

/** What Fix with agent needs of the workspace. */
export interface FixAgentHost {
  agentTerminals(): AgentTerminal[];
  /** Makes the pane's tab active and the source of the next split. */
  anchorOn(paneId: string): void;
  revealPane(paneId: string): void;
  openTerminalWithCommand(cwd: string, command: string): string | undefined;
  pasteIntoTerminal(paneId: string, text: string): void;
  terminalForPty(ptyId: number): string | null;
}

/** Pastes anyway when the new agent never reports in (hooks not installed, or a slow start). */
const FALLBACK_MS = 20_000;
/**
 * The first hook event can come before the agent's input box is up and has asked for bracketed
 * paste; a plain paste would send each newline as Enter and submit the prompt line by line.
 */
const SETTLE_MS = 1000;

/**
 * Pastes `prompt`, without Enter, into the repo's ready agent terminal, else into a new
 * `claude` split in `root` once that agent reports its first hook event (or after the fallback).
 * Resolves once the prompt is pasted.
 */
export async function deliverFixPrompt(host: FixAgentHost, root: string, prompt: string, fromPaneId?: string): Promise<void> {
  const ready = pickAgentPane(host.agentTerminals(), root);
  if (ready !== null) {
    host.revealPane(ready);
    host.pasteIntoTerminal(ready, prompt);
    return;
  }

  let paneId: string | undefined;
  let settle: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    settle = resolve;
  });
  // Subscribed before the pane opens, so a fast first event cannot slip past.
  const unlisten = await onHookEvent((ev) => {
    if (paneId === undefined || ev.paneId === null) return;
    if (host.terminalForPty(ev.paneId) === paneId) settle();
  }).catch(() => null);

  if (fromPaneId !== undefined) host.anchorOn(fromPaneId);
  paneId = host.openTerminalWithCommand(root, 'claude');
  if (paneId === undefined) {
    unlisten?.();
    throw new Error('No room to open an agent terminal');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const fallback = new Promise<'fallback'>((resolve) => {
    timer = setTimeout(() => resolve('fallback'), FALLBACK_MS);
  });
  const how = await Promise.race([started.then(() => 'hook' as const), fallback]);
  clearTimeout(timer);
  unlisten?.();
  if (how === 'hook') await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  host.pasteIntoTerminal(paneId, prompt);
}
