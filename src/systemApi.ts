import { invoke } from '@tauri-apps/api/core';
import type { SystemSample } from './systemModel';

/** One machine-load sample; disks are read only when asked for. */
export function systemSample(includeDisks: boolean): Promise<SystemSample> {
  return invoke<SystemSample>('system_sample', { includeDisks });
}
