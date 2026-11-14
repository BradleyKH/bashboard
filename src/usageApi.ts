import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { UsageWindowReport } from './usageModel';

/** Every known limit window, ordered by agent and then label. */
export function usageSnapshot(): Promise<UsageWindowReport[]> {
  return invoke<UsageWindowReport[]>('usage_snapshot');
}

/** Fires with the whole snapshot whenever a report changed any window. */
export function onUsageChanged(cb: (windows: UsageWindowReport[]) => void): Promise<UnlistenFn> {
  return listen<UsageWindowReport[]>('usage://changed', (e) => cb(e.payload));
}
