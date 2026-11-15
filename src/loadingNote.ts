/**
 * A spinner and a line of text for a view waiting on its first data. `delayed` holds it back
 * briefly (styles.css), so a load that finishes quickly never flashes it.
 */
export function loadingNote(text: string, opts: { delayed?: boolean; className?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'loading-note';
  if (opts.delayed) el.classList.add('loading-note--delayed');
  if (opts.className) el.classList.add(opts.className);
  el.setAttribute('role', 'status');
  const spinner = document.createElement('span');
  spinner.className = 'loading-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  el.append(spinner, text);
  return el;
}
