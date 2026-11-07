import type { ResponseBody } from './browserApi';
import { base64Size, formatDuration, prettyBody, urlPath } from './browserPaneModel';
import { NetworkLog, typeGroup, type BrowserEvent, type NetworkRow, type NetworkTypeGroup } from './devtoolsModel';
import { formatSize } from './formatSize';

const TYPE_CHIPS: ReadonlyArray<[NetworkTypeGroup | null, string]> = [
  [null, 'All'],
  ['fetch', 'Fetch/XHR'],
  ['doc', 'Doc'],
  ['js', 'JS'],
  ['css', 'CSS'],
  ['img', 'Img'],
  ['other', 'Other'],
];

/** Bodies past this many characters are cut in the detail view, so a large bundle cannot stall the pane. */
const BODY_SHOW_CAP = 200_000;

export interface BrowserNetworkPanelOptions {
  fetchBody: (requestId: string) => Promise<ResponseBody>;
}

/** The DevTools drawer's Network tab: the framed page's requests, with headers and bodies on demand. */
export class BrowserNetworkPanel {
  readonly element: HTMLElement;
  private readonly log = new NetworkLog();
  private readonly opts: BrowserNetworkPanelOptions;
  private readonly filterInput: HTMLInputElement;
  private readonly chips = new Map<NetworkTypeGroup | null, HTMLButtonElement>();
  private readonly table: HTMLElement;
  private readonly detail: HTMLElement;
  private type: NetworkTypeGroup | null = null;
  private selected: string | null = null;
  private visible = false;
  private dirty = true;
  private frame = 0;
  /** Bumped per detail render, so a body that arrives after the selection moved is dropped. */
  private detailToken = 0;

  constructor(opts: BrowserNetworkPanelOptions) {
    this.opts = opts;
    this.element = document.createElement('div');
    this.element.className = 'lb-panel lb-network';

    const bar = document.createElement('div');
    bar.className = 'lb-panel-bar';
    for (const [group, label] of TYPE_CHIPS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lb-chip';
      chip.classList.toggle('active', group === null);
      chip.textContent = label;
      chip.addEventListener('click', () => this.setType(group));
      this.chips.set(group, chip);
      bar.append(chip);
    }
    this.filterInput = document.createElement('input');
    this.filterInput.type = 'search';
    this.filterInput.className = 'lb-filter';
    this.filterInput.placeholder = 'Filter by URL, method, or status';
    this.filterInput.spellcheck = false;
    this.filterInput.addEventListener('input', () => this.invalidate());
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'lb-btn';
    clear.textContent = 'Clear';
    clear.title = 'Clear the request list';
    clear.addEventListener('click', () => this.clear());
    bar.append(this.filterInput, clear);

    const body = document.createElement('div');
    body.className = 'lb-network-body';
    this.table = document.createElement('div');
    this.table.className = 'lb-net-table';
    this.detail = document.createElement('div');
    this.detail.className = 'lb-net-detail';
    this.detail.hidden = true;
    body.append(this.table, this.detail);
    this.element.append(bar, body);
  }

  add(ev: BrowserEvent): void {
    if (ev.kind !== 'request' && ev.kind !== 'response' && ev.kind !== 'finished' && ev.kind !== 'failed') return;
    this.log.apply(ev);
    this.invalidate();
  }

  clear(): void {
    this.log.clear();
    this.select(null);
    this.invalidate();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) this.schedule();
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.detailToken++;
  }

  private setType(group: NetworkTypeGroup | null): void {
    this.type = group;
    for (const [g, chip] of this.chips) chip.classList.toggle('active', g === group);
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (!this.visible || !this.dirty || this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.paint();
    });
  }

  private paint(): void {
    this.dirty = false;
    const rows = this.log.filter({ text: this.filterInput.value, types: this.type === null ? undefined : [this.type] });
    const atBottom = this.table.scrollHeight - this.table.scrollTop - this.table.clientHeight < 8;
    const head = document.createElement('div');
    head.className = 'lb-net-head';
    for (const label of ['Method', 'Status', 'Path', 'Type', 'Size', 'Time']) head.append(this.cell('lb-net-cell', label));
    if (rows.length === 0) {
      const note = document.createElement('div');
      note.className = 'lb-empty';
      note.textContent = this.log.size === 0 ? 'No requests yet. Requests appear as the page makes them.' : 'No requests match.';
      this.table.replaceChildren(head, note);
    } else {
      this.table.replaceChildren(head, ...rows.map((r) => this.row(r)));
    }
    if (atBottom) this.table.scrollTop = this.table.scrollHeight;
    if (this.selected !== null && !this.log.get(this.selected)) this.select(null);
  }

  private row(r: NetworkRow): HTMLElement {
    const el = document.createElement('div');
    el.className = 'lb-net-row';
    el.classList.toggle('selected', r.requestId === this.selected);
    el.classList.toggle('failed', r.failed || (r.status !== null && r.status >= 400));
    const status = r.failed ? (r.canceled ? '(canceled)' : '(failed)') : r.status === null ? '(pending)' : String(r.status);
    const path = this.cell('lb-net-cell lb-net-path', urlPath(r.url));
    path.title = r.url;
    el.append(
      this.cell('lb-net-cell', r.method),
      this.cell('lb-net-cell', status),
      path,
      this.cell('lb-net-cell', typeLabel(r.type)),
      this.cell('lb-net-cell lb-net-num', r.size === null ? '' : formatSize(r.size)),
      this.cell('lb-net-cell lb-net-num', formatDuration(r.duration)),
    );
    if (r.failed && r.errorText) el.title = r.errorText;
    el.addEventListener('click', () => {
      for (const s of this.table.querySelectorAll('.lb-net-row.selected')) s.classList.remove('selected');
      el.classList.add('selected');
      this.select(r.requestId);
    });
    return el;
  }

  private select(requestId: string | null): void {
    this.selected = requestId;
    const token = ++this.detailToken;
    const r = requestId === null ? undefined : this.log.get(requestId);
    if (!r) {
      this.detail.hidden = true;
      this.detail.replaceChildren();
      return;
    }
    this.detail.hidden = false;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'lb-btn lb-net-close';
    close.textContent = 'Close';
    close.title = 'Close the details';
    close.addEventListener('click', () => {
      this.table.querySelector('.lb-net-row.selected')?.classList.remove('selected');
      this.select(null);
    });

    const general: Record<string, string> = {
      URL: r.url,
      Method: r.method,
      Status: r.failed ? r.errorText || 'Failed' : r.status === null ? 'Pending' : `${r.status} ${r.statusText}`.trim(),
      Type: typeLabel(r.type),
    };
    if (r.mimeType) general['MIME type'] = r.mimeType;

    const bodyBox = document.createElement('pre');
    bodyBox.className = 'lb-net-body-text';
    bodyBox.textContent = r.status === null || r.failed ? 'No response body.' : 'Loading the body...';

    this.detail.replaceChildren(
      close,
      this.section('General', this.pairs(general)),
      this.section('Response headers', this.pairs(r.responseHeaders)),
      this.section('Response body', bodyBox),
    );
    if (r.status === null || r.failed) return;
    this.opts
      .fetchBody(r.requestId)
      .then((b) => {
        if (token !== this.detailToken) return;
        if (b.base64) {
          bodyBox.textContent = `Binary body, ${formatSize(base64Size(b.body))}. Not shown.`;
          return;
        }
        const shown = prettyBody(b.body, r.mimeType);
        bodyBox.textContent =
          shown.length > BODY_SHOW_CAP ? `${shown.slice(0, BODY_SHOW_CAP)}\n\n(${formatSize(shown.length)} in all, cut here.)` : shown || '(empty)';
      })
      .catch((err: unknown) => {
        if (token !== this.detailToken) return;
        bodyBox.textContent = `The body is not available: ${String(err)}`;
      });
  }

  private section(title: string, content: HTMLElement): HTMLElement {
    const el = document.createElement('section');
    el.className = 'lb-net-section';
    const h = document.createElement('h4');
    h.textContent = title;
    el.append(h, content);
    return el;
  }

  private pairs(values: Record<string, string>): HTMLElement {
    const list = document.createElement('dl');
    list.className = 'lb-net-pairs';
    const keys = Object.keys(values);
    if (keys.length === 0) {
      const none = document.createElement('div');
      none.className = 'lb-empty';
      none.textContent = 'None.';
      return none;
    }
    for (const k of keys) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = values[k];
      list.append(dt, dd);
    }
    return list;
  }

  private cell(className: string, text: string): HTMLElement {
    const el = document.createElement('span');
    el.className = className;
    el.textContent = text;
    return el;
  }
}

function typeLabel(resourceType: string): string {
  const g = typeGroup(resourceType);
  if (g === 'fetch') return resourceType.toLowerCase() === 'xhr' ? 'xhr' : 'fetch';
  if (g === 'other') return resourceType.toLowerCase() || 'other';
  return g;
}
