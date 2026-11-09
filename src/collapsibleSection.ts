/**
 * Makes clicking a dashboard section's header toggle it (docs/design/dashboard.md section 4.6).
 * Clicks on a button inside the header, such as a "+", act on that button only.
 */
export function makeCollapsible(
  section: HTMLElement,
  header: HTMLElement,
  onToggle: () => void,
): void {
  header.classList.add('collapsible-head');
  header.addEventListener('click', (e) => {
    // composedPath, not target.closest: a header button that swaps its own icon on click leaves
    // the target detached by the time the click bubbles here, so closest() would miss the button.
    const fromControl = e
      .composedPath()
      .some((n) => n instanceof Element && n.matches('button, input'));
    if (fromControl) return;
    onToggle();
  });
  section.classList.add('collapsible');
}

export function setSectionCollapsed(section: HTMLElement, collapsed: boolean): void {
  section.classList.toggle('collapsed', collapsed);
}
