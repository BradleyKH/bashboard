import './appDialog.css';
import './sessionsDialog.css';
import { agentName } from './agentNames';
import type { AgentId } from './agentTable';
import { attachContextMenu, retargetContextMenu } from './contextMenu';
import { displayPath } from './displayPath';
import { loadingNote } from './loadingNote';
import { listSessionHistory, onSessionHistoryChanged, type PastSession } from './sessionHistoryApi';
import { sessionRow, sessionRowMenu } from './sessionHistoryRow';
import {
  groupByAge,
  inScope,
  matchesQuery,
  mergeLive,
  modelOptions,
  resumePlan,
  scopeForOrigin,
  scopeName,
  type HistoryRow,
  type Scope,
  type SessionsOrigin,
} from './sessionHistoryModel';
import type { Session } from './sessions';
import { showToast } from './toast';

/** What the dialog needs from the app; pty ids are the roster's, and the caller maps them to panes. */
export interface SessionsDialogCallbacks {
  /** Brings the pane running pty `ptyId` forward. */
  focusPty(ptyId: number): void;
  /** Runs `command` in the terminal on `ptyId`: the caller types it and presses Enter. */
  runInTerminal(ptyId: number, command: string): void;
  /** Opens a new terminal in `cwd` and runs `command` there. */
  openTerminalWithCommand(cwd: string, command: string): void;
  /** The roster's current sessions, marking which history rows are running. */
  liveSessions(): Session[];
}

const PAGE_STEP = 8;
const rowKey = (r: Pick<PastSession, 'agent' | 'sessionId'>) => `${r.agent}:${r.sessionId}`;

/**
 * Lists past and live coding agent sessions and resumes one (docs/design/sessions.md section 4.32).
 */
export class SessionsDialog {
  private backdrop: HTMLElement | null = null;
  private box!: HTMLElement;
  private input!: HTMLInputElement;
  private scopeBox!: HTMLInputElement;
  private scopeText!: HTMLElement;
  private scopeLabel!: HTMLElement;
  private chips!: HTMLElement;
  private modelSelect!: HTMLSelectElement;
  private list!: HTMLElement;

  private origin: SessionsOrigin | null = null;
  /** Null until the first load finishes. */
  private past: PastSession[] | null = null;
  private error: string | null = null;
  private scope: Scope | null = null;
  private activeAgents = new Set<AgentId>();
  /** The model filter; null shows every model. */
  private activeModel: string | null = null;
  private shown: HistoryRow[] = [];
  private rowEls: HTMLElement[] = [];
  private selected = 0;
  private selectedKey: string | null = null;
  private returnFocus: HTMLElement | null = null;
  private unlisten: (() => void) | null = null;
  /** Bumped by every open and close, so a load or subscription that outlives its dialog is dropped. */
  private token = 0;
  private detachMenu: (() => void) | null = null;

  constructor(private readonly callbacks: SessionsDialogCallbacks) {}

  isOpen(): boolean {
    return this.backdrop !== null;
  }

  /**
   * `origin` is the terminal the dialog was opened from, or null when there is none; it sets the
   * scope checkbox (checked, for a terminal's folder) and where a resume types.
   */
  open(origin: SessionsOrigin | null): void {
    if (this.backdrop) this.close(false);
    this.origin = origin;
    this.past = null;
    this.error = null;
    this.activeAgents.clear();
    this.activeModel = null;
    this.selected = 0;
    this.selectedKey = null;
    const active = document.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.build();
    this.render(true);
    this.input.focus();

    const token = ++this.token;
    onSessionHistoryChanged((list) => {
      if (token !== this.token) return;
      this.past = list;
      this.error = null;
      this.render(false);
    }).then(
      (un) => {
        if (token === this.token) this.unlisten = un;
        else un();
      },
      () => {},
    );
    listSessionHistory().then(
      (list) => {
        // A change event that landed first is newer than this answer.
        if (token !== this.token || this.past !== null) return;
        this.past = list;
        this.render(false);
      },
      (err: unknown) => {
        if (token !== this.token || this.past !== null) return;
        this.past = [];
        this.error = String(err);
        this.render(false);
      },
    );
  }

  /** Closes without touching focus; the caller of a resume focuses its own target. */
  close(restoreFocus = false): void {
    if (!this.backdrop) return;
    this.token++;
    this.unlisten?.();
    this.unlisten = null;
    this.detachMenu?.();
    this.detachMenu = null;
    this.backdrop.remove();
    this.backdrop = null;
    const back = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && back?.isConnected) back.focus();
  }

  private dismiss(): void {
    this.close(true);
  }

  private build(): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'app-dialog-backdrop';
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) {
        e.preventDefault();
        this.dismiss();
      }
    });

    const box = document.createElement('div');
    box.className = 'app-dialog sessions-dialog';
    box.tabIndex = -1;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Sessions');
    box.addEventListener('keydown', (e) => this.onKey(e));

    const header = document.createElement('div');
    header.className = 'app-dialog-header';
    const heading = document.createElement('div');
    heading.className = 'sessions-heading';
    heading.textContent = 'Sessions';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'app-dialog-close';
    close.textContent = '×';
    close.title = 'Close (Escape)';
    close.addEventListener('click', () => this.dismiss());
    header.append(heading, close);

    const body = document.createElement('div');
    body.className = 'app-dialog-tab-panel sessions-body';

    const controls = document.createElement('div');
    controls.className = 'sessions-controls';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'picker-input sessions-search';
    this.input.placeholder = 'Search title, prompts, or folder';
    this.input.setAttribute('aria-label', 'Search sessions');
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.addEventListener('input', () => {
      this.selectedKey = null;
      this.render(true);
    });

    this.scopeLabel = document.createElement('label');
    this.scopeLabel.className = 'sessions-scope';
    this.scopeBox = document.createElement('input');
    this.scopeBox.type = 'checkbox';
    this.scopeBox.checked = this.origin !== null;
    this.scopeBox.disabled = this.origin === null;
    this.scopeBox.addEventListener('change', () => {
      this.selectedKey = null;
      this.render(true);
    });
    this.scopeText = document.createElement('span');
    this.scopeLabel.append(this.scopeBox, this.scopeText);

    this.chips = document.createElement('div');
    this.chips.className = 'sessions-chips';

    this.modelSelect = document.createElement('select');
    this.modelSelect.className = 'sessions-model';
    this.modelSelect.setAttribute('aria-label', 'Filter by model');
    this.modelSelect.title = 'Filter by model';
    this.modelSelect.addEventListener('change', () => {
      this.activeModel = this.modelSelect.value || null;
      this.selectedKey = null;
      this.render(true);
    });
    controls.append(this.input, this.scopeLabel, this.chips, this.modelSelect);

    this.list = document.createElement('div');
    this.list.className = 'sessions-list';
    this.list.setAttribute('role', 'listbox');
    this.list.addEventListener('click', (e) => {
      const row = this.rowAt(e.target);
      if (row) this.resume(row);
    });
    // Rows are not focusable; keep focus in the search field so typing keeps filtering.
    this.list.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('.sessions-row')) e.preventDefault();
    });
    this.detachMenu = attachContextMenu(this.list, (e) => {
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>('.sessions-row') : null;
      const row = this.rowAt(e.target);
      if (!el || !row) return null;
      this.select(Number(el.dataset.index), false);
      return { entries: sessionRowMenu(row, resumePlan(row, this.origin) ? () => this.resume(row) : null), target: el };
    });

    body.append(controls, this.list);
    box.append(header, body);
    backdrop.append(box);
    document.body.append(backdrop);
    this.backdrop = backdrop;
    this.box = box;
  }

  private rowAt(target: EventTarget | null): HistoryRow | null {
    const el = target instanceof Element ? target.closest<HTMLElement>('.sessions-row') : null;
    return el ? (this.shown[Number(el.dataset.index)] ?? null) : null;
  }

  /** Rebuilds the list from the current data and filters; `top` also scrolls it back to the start. */
  private render(top: boolean): void {
    if (!this.backdrop) return;
    const now = Date.now();
    const rows = mergeLive(this.past ?? [], this.callbacks.liveSessions());
    this.scope = this.origin ? scopeForOrigin(this.origin, rows) : null;
    this.renderScopeLabel();
    this.renderChips(rows);
    this.renderModels(rows);

    const scoped = this.scopeBox.checked && this.scope !== null;
    const query = this.input.value;
    const filtered = rows.filter(
      (r) =>
        (!scoped || inScope(r, this.scope as Scope)) &&
        (this.activeAgents.size === 0 || this.activeAgents.has(r.agent)) &&
        (this.activeModel === null || r.model === this.activeModel) &&
        matchesQuery(r, query),
    );
    // A badge only tells rows apart when more than one agent has sessions, the same rule as the chips.
    const showBadges = new Set(rows.map((r) => r.agent)).size > 1;
    const groups = groupByAge(filtered, now);
    this.shown = groups.flatMap((g) => g.sessions);

    const at = this.selectedKey === null ? -1 : this.shown.findIndex((r) => rowKey(r) === this.selectedKey);
    this.selected = at === -1 ? 0 : at;
    this.selectedKey = this.shown[this.selected] ? rowKey(this.shown[this.selected]) : null;

    this.rowEls = [];
    const children: Node[] = [];
    if (this.shown.length === 0) {
      children.push(this.emptyNote(rows.length, scoped, query));
    } else {
      let index = 0;
      for (const g of groups) {
        const section = document.createElement('section');
        section.className = 'sessions-group';
        const head = document.createElement('h3');
        head.className = 'sessions-group-head';
        head.textContent = g.label;
        const count = document.createElement('span');
        count.className = 'sessions-group-count';
        count.textContent = String(g.sessions.length);
        head.append(count);
        section.append(head);
        for (const r of g.sessions) {
          const el = sessionRow(r, index, index === this.selected, now, resumePlan(r, this.origin) !== null, showBadges);
          this.rowEls.push(el);
          section.append(el);
          index++;
        }
        children.push(section);
      }
    }
    this.list.replaceChildren(...children);
    if (top) this.list.scrollTop = 0;
    // The open row menu's target was just replaced; hand its outline and refocus to the new row.
    retargetContextMenu((old) => {
      const i = this.shown.findIndex((r) => rowKey(r) === old.dataset.key);
      return i === -1 ? null : this.rowEls[i];
    });
  }

  private renderScopeLabel(): void {
    const named = this.scope !== null && this.scope.repoRoot !== null;
    this.scopeText.textContent = named ? `Only ${scopeName(this.scope as Scope)}` : 'Only this folder';
    this.scopeLabel.classList.toggle('disabled', this.scopeBox.disabled);
    this.scopeLabel.title = this.scope
      ? displayPath(this.scope.repoRoot ?? this.scope.folder)
      : 'Open Sessions from a terminal to limit the list to its folder';
  }

  private renderChips(rows: HistoryRow[]): void {
    const agents = [...new Set(rows.map((r) => r.agent))].sort();
    for (const a of this.activeAgents) if (!agents.includes(a)) this.activeAgents.delete(a);
    this.chips.hidden = agents.length < 2;
    const buttons = agents.map((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sessions-chip';
      b.textContent = agentName(a);
      b.setAttribute('aria-pressed', String(this.activeAgents.has(a)));
      b.addEventListener('click', () => {
        if (!this.activeAgents.delete(a)) this.activeAgents.add(a);
        this.selectedKey = null;
        this.render(true);
      });
      return b;
    });
    // A click replaces the buttons, so the focused chip is found again by its place.
    const focused = [...this.chips.children].findIndex((c) => c === document.activeElement);
    this.chips.replaceChildren(...buttons);
    if (focused !== -1) buttons[focused]?.focus();
  }

  /** Shown only when sessions span more than one model; a vanished choice resets to all models. */
  private renderModels(rows: HistoryRow[]): void {
    const models = modelOptions(rows);
    if (this.activeModel !== null && !models.includes(this.activeModel)) this.activeModel = null;
    this.modelSelect.hidden = models.length < 2;
    const all = new Option('All models', '');
    this.modelSelect.replaceChildren(all, ...models.map((m) => new Option(m, m)));
    this.modelSelect.value = this.activeModel ?? '';
  }

  private emptyNote(total: number, scoped: boolean, query: string): HTMLElement {
    if (this.past === null) return loadingNote('Loading sessions', { className: 'sessions-note' });
    const note = document.createElement('div');
    note.className = 'sessions-note';
    if (total === 0) {
      note.textContent = this.error ? `Could not load sessions: ${this.error}` : 'No sessions found yet.';
      return note;
    }
    const where = scoped && this.scope ? ` in ${this.scopeText.textContent?.replace(/^Only /, '')}` : '';
    note.textContent = `${query.trim() ? 'No sessions match your search' : 'No sessions'}${where}.`;
    if (scoped) note.textContent += ` Uncheck "${this.scopeText.textContent}" to see every folder.`;
    return note;
  }

  private select(index: number, scroll: boolean): void {
    if (this.shown.length === 0) return;
    const next = Math.max(0, Math.min(this.shown.length - 1, index));
    this.rowEls[this.selected]?.classList.remove('selected');
    this.rowEls[this.selected]?.setAttribute('aria-selected', 'false');
    this.selected = next;
    this.selectedKey = rowKey(this.shown[next]);
    const el = this.rowEls[next];
    el.classList.add('selected');
    el.setAttribute('aria-selected', 'true');
    if (scroll) el.scrollIntoView({ block: 'nearest' });
  }

  private resume(row: HistoryRow): void {
    const plan = resumePlan(row, this.origin);
    if (!plan) return;
    this.close(false);
    switch (plan.kind) {
      case 'focus':
        this.callbacks.focusPty(plan.paneId);
        break;
      case 'typeHere':
        this.callbacks.runInTerminal(plan.paneId, plan.command);
        break;
      case 'newPane':
        if (plan.fellBack) {
          const claude = row.agent === 'claude' ? ' Claude Code may not find the session from there.' : '';
          showToast(`${displayPath(row.cwd)} no longer exists, so the session opens in ${displayPath(plan.cwd)}.${claude}`);
        }
        this.callbacks.openTerminalWithCommand(plan.cwd, plan.command);
        break;
    }
  }

  private onKey(e: KeyboardEvent): void {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.dismiss();
      return;
    }
    if (e.key === 'Tab') {
      this.trapTab(e);
      return;
    }
    const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE_STEP, PageUp: -PAGE_STEP }[e.key];
    // Arrows on the model select change its choice, not the row selection.
    if (step !== undefined && e.target !== this.modelSelect && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      this.select(this.selected + step, true);
      return;
    }
    // Enter on the checkbox or a chip is theirs.
    if (e.key === 'Enter' && (e.target === this.input || e.target === this.box)) {
      e.preventDefault();
      const row = this.shown[this.selected];
      if (row) this.resume(row);
    }
  }

  /** The box's fields and buttons are the only Tab stops; focus never reaches the page behind it. */
  private trapTab(e: KeyboardEvent): void {
    e.preventDefault();
    const stops = [...this.box.querySelectorAll<HTMLElement>('input, button, select')].filter(
      (el) => !(el as HTMLInputElement).disabled && el.offsetParent !== null,
    );
    if (stops.length === 0) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = at === -1 ? 0 : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
    stops[next].focus();
  }
}
