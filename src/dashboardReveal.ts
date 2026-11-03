import './dashboardReveal.css';
import { revealTitle } from './dashboardRevealModel';

/**
 * The handle on the window edge that brings back a hidden dashboard (docs/design.md section
 * 4.6), so a mouse user who hid it with × is never stuck without the shortcut. CSS shows it only
 * while the panel is neither open nor peeking. `getKeys` is read on hover so a rebinding shows.
 */
export function dashboardRevealHandle(onClick: () => void, getKeys: () => string | undefined): HTMLButtonElement {
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'dashboard-reveal';
  handle.setAttribute('aria-label', 'Show the dashboard');
  handle.addEventListener('pointerenter', () => {
    handle.title = revealTitle(getKeys());
  });
  // Keeps focus in the terminal; the click still fires.
  handle.addEventListener('mousedown', (e) => e.preventDefault());
  handle.addEventListener('click', onClick);
  return handle;
}
