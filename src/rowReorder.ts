/**
 * Reorders by dragging the handle; the pointer's position among the parent's children matching
 * `rowSelector` picks the slot.
 */
export function attachReorder(
  handle: HTMLElement,
  row: HTMLElement,
  index: number,
  rowSelector: string,
  onReorder: (from: number, to: number) => void,
): void {
  const clear = (): void => {
    for (const el of row.parentElement?.querySelectorAll('.drop-before, .drop-after') ?? []) {
      el.classList.remove('drop-before', 'drop-after');
    }
  };
  const slotAt = (y: number): { rows: HTMLElement[]; pos: number } => {
    const rows = [...(row.parentElement?.querySelectorAll<HTMLElement>(rowSelector) ?? [])];
    let pos = 0;
    for (const r of rows) {
      const rect = r.getBoundingClientRect();
      if (y > rect.top + rect.height / 2) pos++;
    }
    return { rows, pos };
  };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    handle.setPointerCapture(e.pointerId);
    row.classList.add('reordering');

    const move = (ev: PointerEvent): void => {
      clear();
      const { rows, pos } = slotAt(ev.clientY);
      if (rows.length === 0) return;
      if (pos < rows.length) rows[pos].classList.add('drop-before');
      else rows[rows.length - 1].classList.add('drop-after');
    };
    const end = (ev: PointerEvent | null): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      row.classList.remove('reordering');
      clear();
      if (!ev) return;
      const { pos } = slotAt(ev.clientY);
      const to = pos > index ? pos - 1 : pos;
      if (to !== index) onReorder(index, to);
    };
    const cancel = (): void => end(null);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
  });
  // The handle sits in the row, whose click would open it.
  handle.addEventListener('click', (e) => e.stopPropagation());
}
