import { DIVIDER_PX, type Layout, type Path, type Split } from './layout';

export type LayoutViewHooks = {
  onRatioChange(path: Path, ratio: number): void;
  clampRatio(path: Path, ratio: number): number;
};

/** Renders a Layout as nested flex containers around caller-owned pane hosts. */
export class LayoutView {
  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: LayoutViewHooks,
  ) {}

  render(tree: Layout, hosts: Map<string, HTMLElement>, focusedId: string): void {
    for (const [id, host] of hosts) host.classList.toggle('focused', id === focusedId);
    // Hosts are re-parented, never recreated, so xterm and its canvas survive a rebuild.
    // Hosts missing from the tree are dropped with the old containers.
    this.root.replaceChildren(this.build(tree, hosts, []));
    const only = this.root.firstElementChild as HTMLElement | null;
    if (only) only.style.flex = '1 1 0';
  }

  private build(node: Layout, hosts: Map<string, HTMLElement>, path: Path): HTMLElement {
    if (node.kind === 'pane') {
      const host = hosts.get(node.paneId);
      if (!host) throw new Error(`no host for pane ${node.paneId}`);
      return host;
    }
    const el = document.createElement('div');
    el.className = `split ${node.dir}`;
    const a = this.build(node.a, hosts, [...path, 'a']);
    const b = this.build(node.b, hosts, [...path, 'b']);
    this.setBasis(a, node.ratio);
    b.style.flex = '1 1 0';
    el.append(a, this.makeDivider(node, path, el, a), b);
    return el;
  }

  private setBasis(a: HTMLElement, ratio: number): void {
    a.style.flex = `0 0 calc(${ratio} * (100% - ${DIVIDER_PX}px))`;
  }

  private makeDivider(node: Split, path: Path, container: HTMLElement, a: HTMLElement): HTMLElement {
    const div = document.createElement('div');
    div.className = `divider ${node.dir}`;
    const horizontal = node.dir === 'row';
    let last = node.ratio;
    let dragging = false;

    const ratioAt = (e: PointerEvent): number => {
      const rect = container.getBoundingClientRect();
      const avail = (horizontal ? rect.width : rect.height) - DIVIDER_PX;
      if (avail <= 0) return last;
      const pos = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
      return this.hooks.clampRatio(path, (pos - DIVIDER_PX / 2) / avail);
    };

    div.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      div.setPointerCapture(e.pointerId);
      div.classList.add('dragging');
      document.body.classList.add('resizing', node.dir);
      e.preventDefault();
    });
    div.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      last = ratioAt(e);
      this.setBasis(a, last);
    });
    const end = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      div.releasePointerCapture(e.pointerId);
      div.classList.remove('dragging');
      document.body.classList.remove('resizing', 'row', 'column');
      this.hooks.onRatioChange(path, last);
    };
    div.addEventListener('pointerup', end);
    div.addEventListener('pointercancel', end);
    return div;
  }
}
