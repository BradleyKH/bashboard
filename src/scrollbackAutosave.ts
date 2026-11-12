// Periodic scrollback saving between closes (docs/design/workspace.md section 4.9).

/** How often terminals with new output have their scrollback saved. */
export const SCROLLBACK_AUTOSAVE_MS = 60_000;

/** Resolves when the page is idle, or after `timeoutMs` if it never is. */
export function whenIdle(timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: timeoutMs });
    else setTimeout(resolve, 0);
  });
}

/**
 * Runs `save` every `intervalMs` while `enabled()` holds, never two passes at once. `save` gets
 * `whenIdle` to await before each terminal, so serializing scrollback never competes with typing
 * or rendering. Returns a function that stops it.
 */
export function startScrollbackAutosave(
  enabled: () => boolean,
  save: (idle: () => Promise<void>) => Promise<void>,
  intervalMs = SCROLLBACK_AUTOSAVE_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running || !enabled()) return;
    running = true;
    save(whenIdle)
      .catch((e: unknown) => console.warn('periodic scrollback save failed:', e))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
