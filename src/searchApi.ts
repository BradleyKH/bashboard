import { Channel, invoke } from '@tauri-apps/api/core';
import type { SearchOptions } from './searchOptions';

export type { SearchOptions } from './searchOptions';

/** One matching line; `line` is 1-based and `ranges` are [start, end) offsets into `text` in UTF-16 code units. */
export interface LineMatch {
  line: number;
  text: string;
  ranges: [number, number][];
}

export type SearchBatch =
  /** Always the first batch, exactly once (possibly with no paths). */
  | { type: 'names'; paths: string[] }
  /** One per file with line matches, in walk order. */
  | { type: 'file'; path: string; matches: LineMatch[] }
  /** Always the last batch of a search that was not cancelled. */
  | { type: 'done'; files: number; matches: number; truncated: boolean };

/** Paths in batches are relative to `root` with forward slashes. Resolves to the search id. */
export function startSearch(
  root: string,
  query: string,
  options: SearchOptions,
  onBatch: (batch: SearchBatch) => void,
): Promise<number> {
  const channel = new Channel<SearchBatch>();
  channel.onmessage = onBatch;
  return invoke<number>('search_start', { root, query, options, onBatch: channel });
}

/** Idempotent; succeeds for unknown or finished ids. */
export function cancelSearch(id: number): Promise<void> {
  return invoke('search_cancel', { id });
}
