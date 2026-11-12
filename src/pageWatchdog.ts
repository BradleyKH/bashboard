import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * Answers the core's hung-page watchdog (docs/design/app.md section 3.22). Registered first
 * thing at startup, so a page that is slow to restore still answers while it works.
 */
export function answerWatchdog(): void {
  listen('watchdog://ping', () => {
    invoke('page_pong').catch(() => {});
  }).catch(() => {
    // Plain browser: no core to answer.
  });
}
