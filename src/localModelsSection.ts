import './localModelsSection.css';
import type { ModelServersSnapshot } from './modelServersApi';
import { buildServerRows, type ModelRow, type ServerRow } from './localModelsModel';

function span(className: string, text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function serverHeader(s: ServerRow): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row local-server-row';
  el.title = s.url;
  const dot = document.createElement('span');
  dot.className = 'status-dot local-server-dot';
  el.append(dot, span('local-server-name', s.label));
  if (s.version) el.append(span('local-server-version', s.version));
  return el;
}

function modelRow(m: ModelRow, minContext: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'favorite-row local-model-row';
  el.append(span('local-model-name', m.name));
  if (m.placement) el.append(span('local-model-meta', m.placement));
  if (m.contextLabel) {
    const ctx = span('local-model-meta local-model-context', m.contextLabel);
    if (m.lowContext) {
      ctx.classList.add('low');
      ctx.title =
        `Context is under ${minContext} tokens. Agents and coding tools need at least that much; ` +
        'raise it with the OLLAMA_CONTEXT_LENGTH environment variable and restart Ollama.';
    } else {
      ctx.title = 'Context length';
    }
    el.append(ctx);
  }
  if (m.unloadLabel) {
    const unload = span('local-model-meta', m.unloadLabel);
    unload.title = m.unloadLabel === 'never' ? 'Stays loaded' : 'Time until the model unloads';
    el.append(unload);
  }
  return el;
}

/** The dashboard's Local models section: answering Ollama and LM Studio servers and what they have loaded. */
export class LocalModelsSection {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;

  constructor() {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section local-models-section';
    this.el.hidden = true;

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Local models';
    h.title = 'Preview: models loaded in Ollama and LM Studio';
    this.head.append(h);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  /** Hides itself while no server answers. */
  update(snap: ModelServersSnapshot | null, minContext: number): void {
    const servers = buildServerRows(snap, minContext, Date.now());
    this.el.hidden = servers.length === 0;
    this.list.replaceChildren(
      ...servers.flatMap((s) => {
        const rows = [serverHeader(s), ...s.models.map((m) => modelRow(m, minContext))];
        if (s.models.length === 0) {
          const none = document.createElement('div');
          none.className = 'dashboard-empty';
          none.textContent = 'No model loaded';
          rows.push(none);
        }
        return rows;
      }),
    );
  }
}
