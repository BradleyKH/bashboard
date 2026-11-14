// The tab switch transition (docs/design/workspace.md section 4.30). The outgoing tab's hosts
// leave the DOM the moment the switch renders, so they recede as ghosts: deep clones with their
// canvases copied, or a WebGL terminal's rows redrawn, in the #drift layer under #panes. The incoming hosts animate in place with
// transforms only, which never change their layout size, so no terminal refits mid-animation.
import { transitionMs, transitionPlan } from './tabTransitionModel';

/** A clone of an outgoing host, with the scroll offsets it must take once attached. */
/** An outgoing host, its window rect, and a WebGL terminal's rows drawn into a 2D canvas. */
export interface GhostSource {
  host: HTMLElement;
  rect: DOMRect;
  snapshot: HTMLCanvasElement | null;
}

export interface Ghost {
  el: HTMLElement;
  scrolls: Array<[index: number, top: number, left: number]>;
}

export class TabTransition {
  private readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  private ghosts: HTMLElement[] = [];
  private animations: Animation[] = [];
  private settleTimer: number | undefined;
  private settle: (() => void) | null = null;

  constructor(private readonly layer: HTMLElement) {}

  /**
   * Clones the outgoing hosts at their window rects; call before the switch renders. Ends any
   * transition still running first, so a pane captured mid-rise is captured at rest.
   */
  capture(sources: Iterable<GhostSource>): Ghost[] {
    this.finish();
    const ghosts: Ghost[] = [];
    for (const source of sources) {
      if (source.rect.width === 0 || source.rect.height === 0) continue;
      ghosts.push(ghostOf(source));
    }
    return ghosts;
  }

  /**
   * Plays the captured ghosts out and the incoming hosts in; `onSettled` runs once every pane is
   * at rest, or right away when the next transition cuts this one short.
   */
  play(ghosts: Ghost[], incoming: HTMLElement[], onSettled: () => void): void {
    const plan = transitionPlan(this.reducedMotion.matches);
    for (const ghost of ghosts) {
      this.layer.append(ghost.el);
      applyScrolls(ghost);
      this.ghosts.push(ghost.el);
      this.animations.push(ghost.el.animate(plan.outgoing.keyframes, plan.outgoing.options));
    }
    for (const host of incoming) this.animations.push(host.animate(plan.incoming.keyframes, plan.incoming.options));
    this.settle = onSettled;
    this.settleTimer = window.setTimeout(() => this.finish(), transitionMs(plan));
  }

  /** Drops the ghosts and puts every incoming host at rest. */
  finish(): void {
    window.clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    for (const a of this.animations) a.cancel();
    for (const g of this.ghosts) g.remove();
    this.animations = [];
    this.ghosts = [];
    const settle = this.settle;
    this.settle = null;
    settle?.();
  }
}

function ghostOf({ host, rect, snapshot }: GhostSource): Ghost {
  const el = host.cloneNode(true) as HTMLElement;
  el.inert = true;
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('tab-ghost');
  Object.assign(el.style, {
    position: 'absolute',
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    flex: 'none',
    margin: '0',
  });
  for (const node of el.querySelectorAll('[id]')) node.removeAttribute('id');
  // A cloned iframe would load its page again; the ghost is gone before it could show anything.
  // The empty div takes the iframe's place, so element indices still match the source's.
  for (const frame of el.querySelectorAll('iframe')) frame.replaceWith(document.createElement('div'));
  copyCanvases(host, el);
  if (snapshot) placeSnapshot(el, snapshot);
  return { el, scrolls: readScrolls(host) };
}

/** A cloned canvas comes out blank, so each is redrawn from its source. */
function copyCanvases(source: HTMLElement, ghost: HTMLElement): void {
  const from = source.querySelectorAll('canvas');
  const to = ghost.querySelectorAll('canvas');
  for (let i = 0; i < from.length && i < to.length; i++) {
    const src = from[i];
    if (src.width === 0 || src.height === 0) continue;
    try {
      to[i].width = src.width;
      to[i].height = src.height;
      to[i].getContext('2d')?.drawImage(src, 0, 0);
    } catch {
      // A canvas that cannot be read stays blank in the ghost.
    }
  }
}

/** A WebGL terminal's canvases stand in for its rows, so the snapshot replaces them. */
function placeSnapshot(ghost: HTMLElement, snapshot: HTMLCanvasElement): void {
  const screen = ghost.querySelector<HTMLElement>('.xterm-screen');
  if (!screen) return;
  for (const canvas of screen.querySelectorAll('canvas')) canvas.remove();
  Object.assign(snapshot.style, { position: 'absolute', left: '0', top: '0' });
  screen.append(snapshot);
}

/** Scroll offsets do not clone, and the source reads 0 once the switch detaches it, so they are read now. */
function readScrolls(source: HTMLElement): Ghost['scrolls'] {
  const out: Ghost['scrolls'] = [];
  source.querySelectorAll('*').forEach((node, i) => {
    if (node.scrollTop !== 0 || node.scrollLeft !== 0) out.push([i, node.scrollTop, node.scrollLeft]);
  });
  return out;
}

/** Scroll offsets only apply to an attached element. */
function applyScrolls(ghost: Ghost): void {
  if (ghost.scrolls.length === 0) return;
  const nodes = ghost.el.querySelectorAll('*');
  for (const [i, top, left] of ghost.scrolls) {
    const node = nodes[i];
    if (!node) continue;
    node.scrollTop = top;
    node.scrollLeft = left;
  }
}
