// The agent line on a Panes card (docs/design/dashboard.md section 4.6): token text and model
// display names. Pure, no DOM.
import { agentName } from './agentNames';
import type { AgentId } from './savedWorkspace';

/** The newest model and context of one session's transcript; mirrors `AgentContext` in the core. */
export interface AgentContext {
  sessionId: string;
  model: string | null;
  contextTokens: number | null;
  /** The model's context window, when the transcript reports one. */
  contextWindow: number | null;
}

// Truncating rather than rounding keeps a count just under a boundary from printing as the next
// tier's value ("10.0k", "1000k").
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k`;
  return `${Math.floor(n / 100_000) / 10}M`;
}

const FAMILIES: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

const FAMILY_FIRST = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const VERSION_FIRST = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku|fable)(?:-\d{8})?$/;

/** "claude-opus-5-5" and "claude-3-5-sonnet-20241022" to "Opus 5.5" and "Sonnet 3.5"; anything else unchanged. */
export function modelDisplayName(id: string): string {
  const bare = id.endsWith('[1m]') ? id.slice(0, -4) : id;
  let family: string;
  let major: string;
  let minor: string | undefined;
  const a = FAMILY_FIRST.exec(bare);
  const b = a ? null : VERSION_FIRST.exec(bare);
  if (a) [, family, major, minor] = a;
  else if (b) [, major, minor, family] = b;
  else return id;
  return `${FAMILIES[family]} ${minor === undefined ? major : `${major}.${minor}`}`;
}

/**
 * "Opus 5.5 · 112k tokens" for Claude; other agents lead with their name ("Codex · gpt-5.5 · 112k / 272k
 * tokens"). Null when neither a model nor a count is known. `windowOverride` supplies a window the context
 * lacks, such as a local server's loaded context length.
 */
export function agentLine(agent: AgentId, ctx: AgentContext | undefined, windowOverride?: number | null): string | null {
  if (!ctx) return null;
  const parts: string[] = [];
  if (ctx.model !== null) parts.push(modelDisplayName(ctx.model));
  if (ctx.contextTokens !== null) {
    const window = ctx.contextWindow ?? windowOverride ?? null;
    const count = window !== null ? `${formatTokens(ctx.contextTokens)} / ${formatTokens(window)}` : formatTokens(ctx.contextTokens);
    parts.push(`${count} tokens`);
  }
  if (parts.length === 0) return null;
  if (agent !== 'claude') parts.unshift(agentName(agent));
  return parts.join(' · ');
}
