/** Mirrors whether Ctrl is held as a `ctrl-held` class on the root element, for CSS. */
export function trackCtrlHeld(): void {
  const root = document.documentElement;
  const set = (held: boolean): void => {
    root.classList.toggle('ctrl-held', held);
  };
  // Capture phase, so key handlers that swallow events cannot hide the change.
  window.addEventListener('keydown', (e) => set(e.ctrlKey), true);
  window.addEventListener('keyup', (e) => set(e.ctrlKey), true);
  // Catches Ctrl pressed while another window had focus.
  window.addEventListener('mousemove', (e) => set(e.ctrlKey), true);
  window.addEventListener('blur', () => set(false));
}
