// Chromium allows about 16 live WebGL contexts per page. The backdrop holds one,
// so panes stop taking WebGL slots at 8 to leave headroom; extra panes use the DOM renderer.
export const DEFAULT_WEBGL_LIMIT = 8;

export class RendererBudget {
  readonly #limit: number;
  #inUse = 0;

  constructor(limit = DEFAULT_WEBGL_LIMIT) {
    this.#limit = limit;
  }

  get inUse(): number {
    return this.#inUse;
  }

  tryAcquire(): boolean {
    if (this.#inUse >= this.#limit) return false;
    this.#inUse += 1;
    return true;
  }

  release(): void {
    if (this.#inUse > 0) this.#inUse -= 1;
  }
}

export const webglBudget = new RendererBudget();
