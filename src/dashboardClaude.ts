import './dashboardClaude.css';
import { claudeContext, claudeProcesses, onClaudeContext } from './claudeApi';
import {
  claudeRows,
  nextLargeSessions,
  type ClaudeContext,
  type ClaudeRow,
  type ProcFigures,
} from './claudeModel';
import type { TerminalCard } from './dashboardModel';
import { PollTimer, shouldPoll, type PollGate } from './pollTimer';
import type { Session } from './sessions';

const POLL_MS = 2000;

/** The dashboard's Claude section: one row per pane-bound Claude session (docs/design.md section 4.6). */
export class DashboardClaude {
  readonly el: HTMLElement;
  readonly head: HTMLElement;
  private readonly list: HTMLElement;
  private readonly timer = new PollTimer(POLL_MS, () => void this.pollProcesses());
  private gate: PollGate = { enabled: false, expanded: false, onScreen: false, windowShown: true };
  private cards: readonly TerminalCard[] = [];
  private sessions: readonly Session[] = [];
  private readonly contexts = new Map<string, ClaudeContext>();
  private procs = new Map<number, ProcFigures>();
  private large: ReadonlySet<string> = new Set();
  private subscribed = false;
  private dirty = true;

  constructor(private readonly onFocus: (paneId: string) => void) {
    this.el = document.createElement('section');
    this.el.className = 'dashboard-section claude-section';

    this.head = document.createElement('div');
    this.head.className = 'dashboard-section-head';
    const h = document.createElement('h2');
    h.textContent = 'Claude';
    this.head.append(h);

    this.list = document.createElement('div');
    this.list.className = 'dashboard-list';
    this.el.append(this.head, this.list);
  }

  update(cards: readonly TerminalCard[], sessions: readonly Session[]): void {
    this.cards = cards;
    this.sessions = sessions;
    this.dirty = true;
    this.renderIfVisible();
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  setGate(partial: Partial<PollGate>): void {
    this.gate = { ...this.gate, ...partial };
    if (shouldPoll(this.gate) && !this.subscribed) this.subscribe();
    this.timer.setGate(partial);
    this.renderIfVisible();
  }

  private subscribe(): void {
    this.subscribed = true;
    void onClaudeContext((ctx) => this.merge(ctx)).catch(() => {});
    // An event can land before the snapshot resolves; the snapshot must not overwrite it.
    void claudeContext()
      .then((all) => {
        for (const ctx of all) if (!this.contexts.has(ctx.sessionId)) this.contexts.set(ctx.sessionId, ctx);
        this.dirty = true;
        this.renderIfVisible();
      })
      .catch(() => {});
  }

  private merge(ctx: ClaudeContext): void {
    this.contexts.set(ctx.sessionId, ctx);
    this.dirty = true;
    this.renderIfVisible();
  }

  private rows(): ClaudeRow[] {
    return claudeRows(this.cards, this.sessions, this.contexts, this.procs, this.large);
  }

  private async pollProcesses(): Promise<void> {
    const rowSessions = new Set(this.rows().map((r) => r.sessionId));
    const pids = [...new Set(this.sessions.filter((s) => rowSessions.has(s.sessionId)).map((s) => s.pid))];
    if (pids.length === 0) return;
    try {
      const figs = await claudeProcesses(pids);
      this.procs = new Map(figs.map((f) => [f.pid, f]));
    } catch {
      this.procs = new Map();
    }
    this.dirty = true;
    this.renderIfVisible();
  }

  // Contexts and cards keep changing while the panel is closed; drawing them then is wasted work.
  private renderIfVisible(): void {
    if (!this.dirty || !this.gate.enabled || !this.gate.onScreen) return;
    this.dirty = false;
    let rows = this.rows();
    const grown = nextLargeSessions(this.large, rows);
    if (grown !== this.large) {
      // A session that just crossed 200k measures against 1M from here on, this frame included.
      this.large = grown;
      rows = this.rows();
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dashboard-empty';
      empty.textContent = 'No Claude sessions in panes';
      this.list.replaceChildren(empty);
      return;
    }
    this.list.replaceChildren(...rows.map((r) => this.renderRow(r)));
  }

  private renderRow(row: ClaudeRow): HTMLElement {
    const el = document.createElement('div');
    el.className = 'claude-row';
    el.dataset.claudePaneId = row.paneId;
    el.title = 'Focus this pane';
    el.addEventListener('click', () => this.onFocus(row.paneId));

    const dot = document.createElement('span');
    dot.className = `status-dot ${row.status}`;
    dot.title = row.status;

    const title = document.createElement('span');
    title.className = 'claude-title';
    title.textContent = row.title;
    title.title = row.title;

    const model = document.createElement('span');
    model.className = 'claude-model';
    model.textContent = row.model ?? '';

    const context = document.createElement('span');
    context.className = 'claude-context';
    const tokens = document.createElement('span');
    tokens.className = 'claude-tokens';
    tokens.textContent = row.tokensText;
    const bar = document.createElement('span');
    bar.className = `claude-bar ${row.band}`;
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(row.fraction * 100)}%`;
    bar.append(fill);
    context.append(tokens, bar);

    const proc = document.createElement('span');
    proc.className = 'claude-process';
    proc.textContent = row.processText ?? '';

    el.append(dot, title, model, context, proc);
    return el;
  }
}
