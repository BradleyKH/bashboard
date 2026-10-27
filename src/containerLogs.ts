import { startLogs, stopLogs, type Container } from './containers';
import { toFontFamily } from './pane';

/**
 * Bounds memory and the cost of rewriting the panel's text on each frame of a chatty container;
 * the stream starts with the last 500 lines, so this keeps well past that.
 */
const MAX_LINES = 5000;

/** CSI and OSC sequences and two-byte escapes; logs from a TTY container carry color codes. */
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Within this many pixels of the bottom counts as at the end. */
const END_SLACK = 4;

function cleanLine(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r$/, '');
}

export interface ContainerLogsOptions {
  /** The panel closed (Close button, or `close()`), so the pane can drop its highlight. */
  onClose: () => void;
}

/** The logs panel beside the Containers list (docs/design.md section 4.16). */
export class ContainerLogs {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly endBtn: HTMLButtonElement;
  private readonly body: HTMLElement;
  private readonly text: HTMLElement;
  private lines: string[] = [];
  private partial = '';
  private decoder = new TextDecoder();
  private following = true;
  private renderQueued = false;
  /** Bumped per stream, so bytes or a stream id arriving for an older one are dropped. */
  private gen = 0;
  private streamId: number | null = null;
  private current: Container | null = null;

  constructor(private readonly opts: ContainerLogsOptions) {
    this.el = document.createElement('div');
    this.el.className = 'ctr-logs';
    this.el.hidden = true;

    const head = document.createElement('div');
    head.className = 'ctr-logs-head';
    this.title = document.createElement('span');
    this.title.className = 'ctr-logs-title';
    this.endBtn = document.createElement('button');
    this.endBtn.type = 'button';
    this.endBtn.className = 'ctr-btn';
    this.endBtn.textContent = 'Follow';
    this.endBtn.title = 'Scroll to the end and follow new output';
    this.endBtn.hidden = true;
    this.endBtn.addEventListener('click', () => this.scrollToEnd());
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ctr-btn';
    close.textContent = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, this.endBtn, close);

    this.body = document.createElement('div');
    this.body.className = 'ctr-logs-body';
    this.text = document.createElement('pre');
    this.text.className = 'ctr-logs-text';
    this.body.append(this.text);
    this.body.addEventListener('scroll', () => this.onScroll());

    this.el.append(head, this.body);
  }

  /** `engine:id` of the container being followed, or null while closed. */
  get key(): string | null {
    return this.current ? `${this.current.engine}:${this.current.id}` : null;
  }

  /** Follows a container's logs, replacing whatever was shown. */
  open(c: Container): void {
    this.stopStream();
    this.current = c;
    this.lines = [];
    this.partial = '';
    this.decoder = new TextDecoder();
    this.following = true;
    this.title.textContent = `Logs: ${c.name}`;
    this.title.title = `${c.name} (${c.image})`;
    this.el.hidden = false;
    this.render();

    const gen = this.gen;
    startLogs(c.engine, c.id, (bytes) => {
      if (gen === this.gen) this.append(bytes);
    }).then(
      (id) => {
        if (gen === this.gen) this.streamId = id;
        else void stopLogs(id).catch(() => {});
      },
      (err: unknown) => {
        if (gen !== this.gen) return;
        this.lines.push(`Could not follow the logs: ${typeof err === 'string' ? err : String(err)}`);
        this.render();
      },
    );
  }

  /** Stops the stream and hides the panel. */
  close(): void {
    if (this.current === null) return;
    this.stopStream();
    this.current = null;
    this.lines = [];
    this.partial = '';
    this.text.textContent = '';
    this.el.hidden = true;
    this.opts.onClose();
  }

  setFont(family: string, size: number): void {
    this.text.style.fontFamily = toFontFamily(family);
    this.text.style.fontSize = `${size}px`;
  }

  dispose(): void {
    this.stopStream();
    this.current = null;
    this.el.remove();
  }

  private stopStream(): void {
    this.gen++;
    if (this.streamId !== null) void stopLogs(this.streamId).catch(() => {});
    this.streamId = null;
  }

  private append(bytes: Uint8Array): void {
    const chunk = this.partial + this.decoder.decode(bytes, { stream: true });
    const parts = chunk.split('\n');
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.lines.push(cleanLine(p));
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.queueRender();
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const tail = this.partial === '' ? [] : [cleanLine(this.partial)];
    this.text.textContent = [...this.lines, ...tail].join('\n');
    if (this.following) this.body.scrollTop = this.body.scrollHeight;
    this.endBtn.hidden = this.following;
  }

  private onScroll(): void {
    const b = this.body;
    const atEnd = b.scrollTop + b.clientHeight >= b.scrollHeight - END_SLACK;
    if (atEnd !== this.following) {
      this.following = atEnd;
      this.endBtn.hidden = atEnd;
    }
  }

  private scrollToEnd(): void {
    this.following = true;
    this.body.scrollTop = this.body.scrollHeight;
    this.endBtn.hidden = true;
  }
}
