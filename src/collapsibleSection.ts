/**
 * Makes clicking a dashboard section's header toggle it (docs/design.md section 4.6). Clicks on a
 * button inside the header, such as a "+", act on that button only.
 */
export function makeCollapsible(
  section: HTMLElement,
  header: HTMLElement,
  onToggle: () => void,
): void {
  header.classList.add('collapsible-head');
  header.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, input')) return;
    onToggle();
  });
  section.classList.add('collapsible');
}

export function setSectionCollapsed(section: HTMLElement, collapsed: boolean): void {
  section.classList.toggle('collapsed', collapsed);
}
