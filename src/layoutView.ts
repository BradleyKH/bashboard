import { DIVIDER_PX, type Layout, type Path, type Split } from './layout';

export type LayoutViewHooks = {
  onRatioChange(path: Path, ratio: number): void;
  clampRatio(path: Path, ratio: number): number;
};

/** A host with this attribute holds an iframe, which reloads whenever it leaves the document. */
export const KEEP_ALIVE_ATTR = 'data-keep-alive';

/** Chromium's state-preserving move (`moveBefore`), missing from older engines. */
const canMove = typeof Element !== 'undefined' && 'moveBefore' in Element.prototype;

/** Renders a Layout as nested flex containers around caller-owned pane hosts. */
export class LayoutView {
  /** Holds keep-alive hosts while they are off screen, so their documents stay loaded. */
  private park: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: LayoutViewHooks,
  ) {}

  render(tree: Layout, hosts: Map<string, HTMLElement>, focusedId: string): void {
    for (const [id, host] of hosts) host.classList.toggle('focused', id === focusedId);
    const live = new Set(hosts.values());
    // A plain append detaches and reattaches a node, which reloads an iframe inside it, so a
    // keep-alive host only ever moves with moveBefore and waits in the park between renders.
    const slots = new Map<HTMLElement, HTMLElement>();
    if (canMove) {
      for (const host of this.root.querySelectorAll<HTMLElement>(`[${KEEP_ALIVE_ATTR}]`)) this.keep(host);
    }
    // Hosts are re-parented, never recreated, so xterm and its canvas survive a rebuild.
    // Hosts missing from the tree are dropped with the old containers.
    this.root.replaceChildren(this.build(tree, hosts, [], slots));
    for (const [slot, host] of slots) {
      host.style.flex = slot.style.flex;
      slot.parentElement!.moveBefore(host, slot);
      slot.remove();
    }
    const only = this.root.firstElementChild as HTMLElement | null;
    if (only) only.style.flex = '1 1 0';
    for (const host of [...(this.park?.children ?? [])]) if (!live.has(host as HTMLElement)) host.remove();
  }

  /** Empties the view, parking keep-alive hosts rather than dropping them. */
  clear(): void {
    if (canMove) for (const host of this.root.querySelectorAll<HTMLElement>(`[${KEEP_ALIVE_ATTR}]`)) this.keep(host);
    this.root.replaceChildren();
  }

  /**
   * Moves a keep-alive host into the hidden park, keeping its iframe loaded while it is off
   * screen. A host that is not yet in the document is placed there too, so its page starts loading.
   */
  keep(host: HTMLElement): void {
    if (!canMove || !host.hasAttribute(KEEP_ALIVE_ATTR)) return;
    if (!this.park) {
      this.park = document.createElement('div');
      this.park.className = 'pane-park';
      this.park.hidden = true;
      document.body.append(this.park);
    }
    if (host.isConnected) this.park.moveBefore(host, null);
    else this.park.append(host);
  }

  private build(node: Layout, hosts: Map<string, HTMLElement>, path: Path, slots: Map<HTMLElement, HTMLElement>): HTMLElement {
    if (node.kind === 'pane') {
      const host = hosts.get(node.paneId);
      if (!host) throw new Error(`no host for pane ${node.paneId}`);
      if (!canMove || !host.isConnected || !host.hasAttribute(KEEP_ALIVE_ATTR)) return host;
      const slot = document.createElement('div');
      slots.set(slot, host);
      return slot;
    }
    const el = document.createElement('div');
    el.className = `split ${node.dir}`;
    const a = this.build(node.a, hosts, [...path, 'a'], slots);
    const b = this.build(node.b, hosts, [...path, 'b'], slots);
    this.setBasis(a, node.ratio);
    b.style.flex = '1 1 0';
    el.append(a, this.makeDivider(node, path, el), b);
    return el;
  }

  private setBasis(a: HTMLElement, ratio: number): void {
    a.style.flex = `0 0 calc(${ratio} * (100% - ${DIVIDER_PX}px))`;
  }

  private makeDivider(node: Split, path: Path, container: HTMLElement): HTMLElement {
    // Read at drag time: a keep-alive host replaces its slot after the divider is made.
    const a = (): HTMLElement => container.firstElementChild as HTMLElement;
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
      this.setBasis(a(), last);
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
