import { invoke } from '@tauri-apps/api/core';
import { ReportGate, reportText } from './errorReportModel';

const gate = new ReportGate();

/**
 * Writes an error to the core's log (docs/design/app.md section 3.22), and to the console for a
 * page with DevTools open. Release builds have no DevTools open, so without this a front-end
 * failure leaves no trace.
 */
export function reportError(context: string, error: unknown): void {
  console.error(`${context}:`, error);
  const text = `${context}: ${reportText(error)}`;
  if (!gate.allow(text, Date.now())) return;
  invoke('frontend_error', { text }).catch(() => {});
}

/** Reports uncaught errors and unhandled rejections through `reportError`. */
export function reportUncaughtErrors(): void {
  window.addEventListener('error', (e) => reportError('uncaught error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled rejection', e.reason));
}
