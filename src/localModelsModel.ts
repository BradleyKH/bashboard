import type { LoadedModel, ModelServersSnapshot, ServerInfo } from './modelServersApi';

export type ServerKind = 'ollama' | 'lmStudio';

export interface ModelRow {
  name: string;
  /** "GPU", "CPU", "62% GPU", or null when the server does not report placement. */
  placement: string | null;
  context: number | null;
  /** "4k", "128k", or '' without a context length. */
  contextLabel: string;
  /** Context is under the configured minimum. */
  lowContext: boolean;
  /** "4m", "30s", "never", or '' when there is no unload time. */
  unloadLabel: string;
}

export interface ServerRow {
  kind: ServerKind;
  label: string;
  version: string | null;
  url: string;
  models: ModelRow[];
}

/** `ollama ps` style: all in VRAM is "GPU", none is "CPU", else the GPU share. */
export function placement(size: number, sizeVram: number | null): string | null {
  if (sizeVram === null || size <= 0) return null;
  if (sizeVram <= 0) return 'CPU';
  if (sizeVram >= size) return 'GPU';
  return `${Math.round((sizeVram / size) * 100)}% GPU`;
}

export function contextLabel(tokens: number | null): string {
  if (tokens === null) return '';
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(tokens);
}

/** 0 disables the warning; an unknown context never warns. */
export function isLowContext(tokens: number | null, minContext: number): boolean {
  return minContext > 0 && tokens !== null && tokens < minContext;
}

const YEAR_SECONDS = 365 * 24 * 3600;

/**
 * Seconds until `expiresAt`, clamped at 0; null when unparseable. Go prints nanosecond
 * fractions, which Date.parse does not take everywhere, so the fraction is cut to milliseconds.
 */
export function secondsUntil(expiresAt: string | null, nowMs: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt.replace(/(\.\d{3})\d+/, '$1'));
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - nowMs) / 1000));
}

/** A keep-alive of -1 makes Ollama report a date centuries out; that reads as "never". */
export function unloadLabel(expiresAt: string | null, nowMs: number): string {
  const s = secondsUntil(expiresAt, nowMs);
  if (s === null) return '';
  if (s > YEAR_SECONDS) return 'never';
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function modelRow(m: LoadedModel, minContext: number, nowMs: number): ModelRow {
  return {
    name: m.name,
    placement: placement(m.size, m.sizeVram),
    context: m.contextLength,
    contextLabel: contextLabel(m.contextLength),
    lowContext: isLowContext(m.contextLength, minContext),
    unloadLabel: unloadLabel(m.expiresAt, nowMs),
  };
}

function serverRow(kind: ServerKind, label: string, s: ServerInfo, minContext: number, nowMs: number): ServerRow {
  return {
    kind,
    label,
    version: s.version,
    url: s.url,
    models: s.models.map((m) => modelRow(m, minContext, nowMs)),
  };
}

/** One row per answering server, Ollama first; empty means the section hides. */
export function buildServerRows(snap: ModelServersSnapshot | null, minContext: number, nowMs: number): ServerRow[] {
  if (!snap) return [];
  const rows: ServerRow[] = [];
  if (snap.ollama) rows.push(serverRow('ollama', 'Ollama', snap.ollama, minContext, nowMs));
  if (snap.lmStudio) rows.push(serverRow('lmStudio', 'LM Studio', snap.lmStudio, minContext, nowMs));
  return rows;
}

/** The loaded Ollama model a session's model id names ("gemma4:e2b"), for the card window. */
export function findLoadedOllama(snap: ModelServersSnapshot | null, model: string | null | undefined): LoadedModel | null {
  if (!snap?.ollama || !model) return null;
  const tagged = (n: string) => (n.includes(':') ? n : `${n}:latest`).toLowerCase();
  return snap.ollama.models.find((m) => tagged(m.name) === tagged(model)) ?? null;
}
