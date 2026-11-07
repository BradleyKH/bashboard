import { invoke } from '@tauri-apps/api/core';
import type { SystemSample, TopProcesses } from './systemModel';

/** One machine-load sample; disks are read only when asked for. */
export function systemSample(includeDisks: boolean): Promise<SystemSample> {
  return invoke<SystemSample>('system_sample', { includeDisks });
}

/** The busiest programs by CPU and by memory, each process name summed into one group. */
export function systemTopProcesses(limit: number): Promise<TopProcesses> {
  return invoke<TopProcesses>('system_top_processes', { limit });
}
