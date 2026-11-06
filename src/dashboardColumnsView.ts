import {
  columnCount,
  DEFAULT_RIGHT_ELEMENTS,
  dropInOneColumn,
  placeInColumns,
  slotElements,
  type ColumnPlacement,
  type DashboardColumn,
} from './dashboardColumns';
import { attachDropDrag, elementTargets, type DropTarget, type DropZone, type ElementDrop } from './dashboardElementDrag';
import { DEFAULT_ELEMENT_ORDER, DEFAULT_TOP_ELEMENTS, type DashboardElement } from './dashboardSections';
import './dashboardColumns.css';

interface ColumnEls {
  el: HTMLElement;
  topSlot: HTMLElement;
  list: HTMLElement;
}

export interface DashboardColumnsOptions {
  /** Pins: always last in one column's top slot. */
  pins: HTMLElement;
  pinsHead: HTMLElement;
  /** Sits at the bottom of the left column. */
  footer: HTMLElement;
  /** Whether an element's setting has it in the panel. */
  shown: (id: DashboardElement) => boolean;
  /** Runs a relayout that may move the focused row, keeping keyboard focus on it. */
  keepFocus: (relayout: () => void) => void;
  /** The user moved an element or Pins, or the first split placed them; save the placement. */
  onChange: () => void;
}

function same(els: HTMLElement[], parent: HTMLElement): boolean {
  return els.length === parent.children.length && els.every((el, i) => el === parent.children[i]);
}

/**
 * The panel's area below the top bar: one or two scrolling columns, each with a top slot, Pins
 * in one of them, and a lower list (docs/design/dashboard.md section 4.6). The panel's width picks
 * the column count; one column shows both columns' slots stacked.
 */
export class DashboardColumnsView {
  readonly el: HTMLElement;
  private readonly cols: Record<DashboardColumn, ColumnEls>;
  private readonly elements = new Map<DashboardElement, HTMLElement>();
  private count: 1 | 2 = 1;
  private order: DashboardElement[] = [...DEFAULT_ELEMENT_ORDER];
  private top: DashboardElement[] = [...DEFAULT_TOP_ELEMENTS];
  /** Null until the panel first shows two columns; until then every element is in the left. */
  private right: DashboardElement[] | null = null;
  private pinsColumn: DashboardColumn = 'left';

  constructor(
    panel: HTMLElement,
    private readonly opts: DashboardColumnsOptions,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'dashboard-columns';
    this.cols = { left: this.column('left'), right: this.column('right') };
    this.cols.right.el.hidden = true;
    this.el.append(this.cols.left.el, this.cols.right.el);
    attachDropDrag(
      opts.pinsHead,
      this.el,
      () => (this.count === 2 ? { dragged: opts.pins, targets: () => this.pinsTargets() } : null),
      (column) => {
        if (column === this.pinsColumn) return;
        this.pinsColumn = column;
        this.layout();
        this.opts.onChange();
      },
    );
    // The panel's rendered width, however it was set: a drag, a saved width, or a window resize.
    new ResizeObserver(() => {
      const width = panel.getBoundingClientRect().width;
      if (width === 0) return;
      const next = columnCount(width, this.count);
      if (next === this.count) return;
      this.count = next;
      if (next === 2 && this.right === null) {
        this.right = [...DEFAULT_RIGHT_ELEMENTS];
        this.opts.onChange();
      }
      this.layout();
    }).observe(panel);
  }

  private column(column: DashboardColumn): ColumnEls {
    const el = document.createElement('div');
    el.className = 'dashboard-column';
    el.dataset.column = column;
    const topSlot = document.createElement('div');
    topSlot.className = 'dashboard-top-slot';
    topSlot.hidden = true;
    const list = document.createElement('div');
    list.className = 'dashboard-elements';
    el.append(topSlot, list);
    return { el, topSlot, list };
  }

  /** `handle` drags the element, a section's header or the whole clock, into any slot. */
  add(id: DashboardElement, el: HTMLElement, handle: HTMLElement): void {
    el.dataset.element = id;
    this.elements.set(id, el);
    attachDropDrag(
      handle,
      this.el,
      () => ({ dragged: el, targets: () => elementTargets(this.zones()) }),
      (drop) => this.drop(id, drop),
    );
  }

  private zones(): DropZone[] {
    const zone = (column: DashboardColumn, z: 'top' | 'list'): DropZone => {
      const c = this.cols[column];
      return { zone: z, column, el: z === 'top' ? c.topSlot : c.list, columnEl: c.el };
    };
    if (this.count === 1) return [zone('left', 'top'), zone('left', 'list')];
    return [zone('left', 'top'), zone('left', 'list'), zone('right', 'top'), zone('right', 'list')];
  }

  private pinsTargets(): DropTarget<DashboardColumn>[] {
    return (['left', 'right'] as const).map((column) => {
      const c = this.cols[column];
      const rect = c.el.getBoundingClientRect();
      const y = c.topSlot.getClientRects().length > 0 ? c.topSlot.getBoundingClientRect().bottom : rect.top;
      return { value: column, y, left: rect.left, right: rect.right };
    });
  }

  private placement(): ColumnPlacement {
    return { order: this.order, top: this.top, right: this.right ?? [] };
  }

  private drop(id: DashboardElement, { zone, column, before }: ElementDrop): void {
    const p = this.placement();
    const next =
      this.count === 2
        ? placeInColumns(p, id, zone, column, before)
        : dropInOneColumn(p, this.shownIn(zone), id, zone, before);
    const eq = (a: DashboardElement[], b: DashboardElement[]): boolean =>
      a.length === b.length && a.every((e, i) => e === b[i]);
    if (eq(next.order, p.order) && eq(next.top, p.top) && eq(next.right, p.right)) return;
    this.order = next.order;
    this.top = next.top;
    if (this.right !== null) this.right = next.right;
    this.layout();
    this.opts.onChange();
  }

  /** A slot's shown elements in one-column display order: the left column's, then the right's. */
  private shownIn(zone: 'top' | 'list'): DashboardElement[] {
    const p = this.placement();
    return [...slotElements(p, 'left', zone), ...slotElements(p, 'right', zone)].filter((id) => this.opts.shown(id));
  }

  /**
   * Puts the shown elements in their slots in order and detaches the rest; a disabled element
   * keeps its place, slot, and column, so turning it back on returns it there.
   */
  layout(): void {
    const els = (ids: DashboardElement[]): HTMLElement[] =>
      ids.filter((id) => this.opts.shown(id)).map((id) => this.elements.get(id)!);
    const p = this.placement();
    const two = this.count === 2;
    const content: Record<DashboardColumn, { top: HTMLElement[]; list: HTMLElement[] }> = two
      ? {
          left: { top: els(slotElements(p, 'left', 'top')), list: els(slotElements(p, 'left', 'list')) },
          right: { top: els(slotElements(p, 'right', 'top')), list: els(slotElements(p, 'right', 'list')) },
        }
      : {
          left: {
            top: els([...slotElements(p, 'left', 'top'), ...slotElements(p, 'right', 'top')]),
            list: els([...slotElements(p, 'left', 'list'), ...slotElements(p, 'right', 'list')]),
          },
          right: { top: [], list: [] },
        };
    const pinsIn = this.cols[two ? this.pinsColumn : 'left'];
    const unchanged =
      (['left', 'right'] as const).every(
        (c) => same(content[c].top, this.cols[c].topSlot) && same(content[c].list, this.cols[c].list),
      ) &&
      this.opts.pins.previousElementSibling === pinsIn.topSlot &&
      this.cols.right.el.hidden === !two &&
      this.opts.footer.parentElement === this.cols.left.el;
    if (unchanged) return;
    this.opts.keepFocus(() => {
      for (const c of ['left', 'right'] as const) {
        const { topSlot, list } = this.cols[c];
        topSlot.replaceChildren(...content[c].top);
        topSlot.hidden = content[c].top.length === 0;
        list.replaceChildren(...content[c].list);
      }
      pinsIn.topSlot.after(this.opts.pins);
      this.cols.left.el.append(this.opts.footer);
      this.cols.right.el.hidden = !two;
    });
  }

  /** Applies a saved placement without firing `onChange`. */
  setPlacement(saved: {
    order?: DashboardElement[];
    top?: DashboardElement[];
    right?: DashboardElement[];
    pinsColumn?: DashboardColumn;
  }): void {
    if (saved.order) this.order = [...saved.order];
    if (saved.top) this.top = [...saved.top];
    if (saved.right) this.right = [...saved.right];
    if (saved.pinsColumn) this.pinsColumn = saved.pinsColumn;
    this.layout();
  }

  sectionOrder(): DashboardElement[] {
    return [...this.order];
  }

  topElements(): DashboardElement[] {
    return [...this.top];
  }

  /** Null until the first split. */
  rightElements(): DashboardElement[] | null {
    return this.right === null ? null : [...this.right];
  }

  pinsColumnName(): DashboardColumn {
    return this.pinsColumn;
  }
}
