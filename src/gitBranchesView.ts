import { attachContextMenu } from './contextMenu';
import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from './gitApi';
import { localBranchMenuItems, remoteBranchMenuItems } from './gitBranchMenus';
import { branchNameError, filterBranches, goneBranches, lockedReason, trackText, trackTitle } from './gitBranchModel';
import { relativeTime } from './gitModel';

export interface GitBranchesViewOptions {
  onSwitch: (b: GitLocalBranch) => void;
  onOpenWorktree: (path: string) => void;
  onCheckOut: (b: GitRemoteBranch) => void;
  /** Resolves true when the branch was made, so the field clears. */
  onCreate: (name: string, base: string | null) => Promise<boolean>;
  /** Resolves true when the rename went through. */
  onRename: (from: string, to: string) => Promise<boolean>;
  onDelete: (b: GitLocalBranch) => void;
  onCleanup: (branches: GitLocalBranch[]) => void;
  copyName: (name: string) => void;
  insertName: (name: string) => void;
}

/** A row's identity across renders: `local:<name>` or `remote:<name>`. */
type RowKey = string;

/** The Branches tab (docs/design.md section 4.13): local branches, then remote ones with no local copy. */
export class GitBranchesView {
  readonly el: HTMLElement;
  private readonly field: HTMLInputElement;
  private readonly baseChip: HTMLButtonElement;
  private readonly createBtn: HTMLButtonElement;
  private readonly cleanupBtn: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly rows: HTMLElement;
  private list: GitBranchList = { local: [], remote: [] };
  /** The branch "New branch from here" picked; null branches from HEAD. */
  private base: string | null = null;
  private remoteOpen = false;
  private selected: RowKey | null = null;
  /** The local branch whose name is being edited. */
  private renaming: string | null = null;

  constructor(private readonly opts: GitBranchesViewOptions) {
    this.el = document.createElement('div');
    this.el.className = 'git-branches';

    const bar = document.createElement('div');
    bar.className = 'git-branches-bar';
    this.field = document.createElement('input');
    this.field.className = 'git-branches-field';
    this.field.placeholder = 'Filter, or a new branch name';
    this.field.spellcheck = false;
    this.field.addEventListener('input', () => this.render());
    this.field.addEventListener('keydown', (e) => this.onFieldKey(e));
    this.baseChip = document.createElement('button');
    this.baseChip.type = 'button';
    this.baseChip.className = 'git-branches-base';
    this.baseChip.title = 'Branch from HEAD instead';
    this.baseChip.addEventListener('click', () => this.setBase(null));
    this.createBtn = document.createElement('button');
    this.createBtn.type = 'button';
    this.createBtn.className = 'git-section-btn';
    this.createBtn.textContent = 'New branch';
    this.createBtn.addEventListener('click', () => void this.create());
    this.cleanupBtn = document.createElement('button');
    this.cleanupBtn.type = 'button';
    this.cleanupBtn.className = 'git-section-btn';
    this.cleanupBtn.addEventListener('click', () => this.opts.onCleanup(goneBranches(this.list)));
    bar.append(this.field, this.baseChip, this.createBtn, this.cleanupBtn);

    this.error = document.createElement('pre');
    this.error.className = 'git-commit-error git-branches-error';
    this.error.hidden = true;

    this.rows = document.createElement('div');
    this.rows.className = 'git-branches-rows';
    this.rows.tabIndex = 0;
    this.rows.setAttribute('role', 'listbox');
    this.rows.addEventListener('keydown', (e) => this.onRowsKey(e));

    this.el.append(bar, this.error, this.rows);
    this.setBase(null);

    attachContextMenu(this.rows, (e, keyboard) => {
      const origin = e.target instanceof Element ? e.target.closest<HTMLElement>('.git-branch-item') : null;
      const el = origin ?? (keyboard ? this.selectedEl() : null);
      const key = el?.dataset.key;
      if (!el || !key) return null;
      const local = this.localOf(key);
      if (local) return { entries: localBranchMenuItems(local, this.menuHandlers()), target: el };
      const remote = this.remoteOf(key);
      if (remote) {
        return {
          entries: remoteBranchMenuItems(remote, {
            checkOut: (b) => this.opts.onCheckOut(b),
            copyName: this.opts.copyName,
            insertName: this.opts.insertName,
          }),
          target: el,
        };
      }
      return null;
    });
  }

  setList(list: GitBranchList): void {
    this.list = list;
    if (this.base !== null && !list.local.some((b) => b.name === this.base)) this.setBase(null);
    if (this.renaming !== null && !list.local.some((b) => b.name === this.renaming)) this.renaming = null;
    // A rename in progress keeps its field; re-rendering would drop what was typed.
    if (this.renaming === null) this.render();
    else this.updateBar();
  }

  /** git's output for a failed branch operation; null clears it. */
  showError(text: string | null): void {
    this.error.textContent = text ?? '';
    this.error.hidden = text === null;
  }

  focus(): void {
    this.field.focus();
  }

  private menuHandlers() {
    return {
      switchTo: (b: GitLocalBranch) => this.opts.onSwitch(b),
      openWorktree: (path: string) => this.opts.onOpenWorktree(path),
      newFrom: (b: GitLocalBranch) => {
        this.setBase(b.name);
        this.field.focus();
      },
      rename: (b: GitLocalBranch) => this.startRename(b.name),
      remove: (b: GitLocalBranch) => this.opts.onDelete(b),
      copyName: this.opts.copyName,
      insertName: this.opts.insertName,
    };
  }

  private setBase(base: string | null): void {
    this.base = base;
    this.baseChip.hidden = base === null;
    this.baseChip.textContent = base === null ? '' : `from ${base} ×`;
    this.updateBar();
  }

  /** The field's text when it can become a new branch, else null with the reason as the button's tooltip. */
  private newName(): string | null {
    const name = this.field.value.trim();
    const err = name === '' ? 'Type a name for the new branch' : branchNameError(name);
    const exists = this.list.local.some((b) => b.name === name);
    const reason = err ?? (exists ? `${name} already exists` : null);
    this.createBtn.disabled = reason !== null;
    this.createBtn.title = reason ?? `Create ${name} from ${this.base ?? 'HEAD'} and switch to it`;
    return reason === null ? name : null;
  }

  private updateBar(): void {
    this.newName();
    const gone = goneBranches(this.list).length;
    this.cleanupBtn.hidden = gone === 0;
    this.cleanupBtn.textContent = `Clean up ${gone} gone`;
    this.cleanupBtn.title = 'Delete local branches whose remote branch was deleted';
  }

  private async create(): Promise<void> {
    const name = this.newName();
    if (name === null) return;
    if (await this.opts.onCreate(name, this.base)) {
      this.field.value = '';
      this.setBase(null);
      this.render();
    }
  }

  private onFieldKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void this.create();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      const first = this.rows.querySelector<HTMLElement>('.git-branch-item');
      if (first?.dataset.key) {
        this.selected = first.dataset.key;
        this.paintSelection();
        this.rows.focus();
      }
    } else if (e.key === 'Escape' && (this.field.value !== '' || this.base !== null)) {
      e.preventDefault();
      e.stopPropagation();
      this.field.value = '';
      this.setBase(null);
      this.render();
    }
  }

  private visibleKeys(): RowKey[] {
    return [...this.rows.querySelectorAll<HTMLElement>('.git-branch-item')].map((el) => el.dataset.key ?? '');
  }

  private onRowsKey(e: KeyboardEvent): void {
    if (e.target !== this.rows) return;
    const keys = this.visibleKeys();
    const at = this.selected === null ? -1 : keys.indexOf(this.selected);
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      handled();
      if (e.key === 'ArrowUp' && at <= 0) {
        this.selected = null;
        this.paintSelection();
        this.field.focus();
        return;
      }
      const next = Math.min(keys.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1));
      if (next >= 0) this.selected = keys[next];
      this.paintSelection();
      return;
    }
    if (this.selected === null) return;
    const local = this.localOf(this.selected);
    const remote = this.remoteOf(this.selected);
    if (e.key === 'Enter') {
      handled();
      if (local) this.primary(local);
      else if (remote) this.opts.onCheckOut(remote);
    } else if (e.key === 'F2' && local) {
      handled();
      this.startRename(local.name);
    } else if (e.key === 'Delete' && local && lockedReason(local) === null) {
      handled();
      this.opts.onDelete(local);
    }
  }

  /** Enter or a double-click: switch, or open the worktree that has the branch. */
  private primary(b: GitLocalBranch): void {
    if (b.worktree !== null) this.opts.onOpenWorktree(b.worktree);
    else if (!b.head) this.opts.onSwitch(b);
  }

  private localOf(key: RowKey): GitLocalBranch | undefined {
    return key.startsWith('local:') ? this.list.local.find((b) => b.name === key.slice(6)) : undefined;
  }

  private remoteOf(key: RowKey): GitRemoteBranch | undefined {
    return key.startsWith('remote:') ? this.list.remote.find((b) => b.name === key.slice(7)) : undefined;
  }

  private selectedEl(): HTMLElement | null {
    for (const el of this.rows.querySelectorAll<HTMLElement>('.git-branch-item')) {
      if (el.dataset.key === this.selected) return el;
    }
    return null;
  }

  private paintSelection(): void {
    for (const el of this.rows.querySelectorAll<HTMLElement>('.git-branch-item')) {
      el.classList.toggle('selected', el.dataset.key === this.selected);
    }
    this.selectedEl()?.scrollIntoView({ block: 'nearest' });
  }

  private startRename(name: string): void {
    this.renaming = name;
    this.selected = `local:${name}`;
    this.render();
  }

  private render(): void {
    this.updateBar();
    const filtering = this.field.value.trim() !== '';
    const shown = filterBranches(this.list, this.field.value);
    const now = Date.now();
    const out: HTMLElement[] = [];

    out.push(this.sectionHead('Local', shown.local.length));
    if (shown.local.length === 0) out.push(this.empty(filtering ? 'No local branch matches' : 'No branches yet'));
    for (const b of shown.local) out.push(this.localRow(b, now));

    if (this.list.remote.length > 0) {
      // A filter searches remote branches too, so their section opens while one is typed.
      const open = this.remoteOpen || filtering;
      const head = this.sectionHead('Remote', shown.remote.length, open);
      head.addEventListener('click', () => {
        this.remoteOpen = !this.remoteOpen;
        this.render();
      });
      out.push(head);
      if (open) {
        if (shown.remote.length === 0) out.push(this.empty('No remote branch matches'));
        for (const b of shown.remote) out.push(this.remoteRow(b, now));
      }
    }
    this.rows.replaceChildren(...out);
    if (this.selected !== null && !this.visibleKeys().includes(this.selected)) this.selected = null;
    this.paintSelection();
    this.rows.querySelector<HTMLInputElement>('.git-rename-field')?.focus();
  }

  private sectionHead(title: string, count: number, open?: boolean): HTMLElement {
    const head = document.createElement('div');
    head.className = 'git-section-head';
    const t = document.createElement('span');
    t.className = 'git-section-title';
    t.textContent = open === undefined ? title : `${open ? '▾' : '▸'} ${title}`;
    const c = document.createElement('span');
    c.className = 'git-section-count';
    c.textContent = String(count);
    head.append(t, c);
    if (open !== undefined) head.classList.add('git-section-toggle');
    return head;
  }

  private empty(text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'git-empty';
    el.textContent = text;
    return el;
  }

  private rowShell(key: RowKey): HTMLElement {
    const el = document.createElement('div');
    el.className = 'git-row git-branch-item';
    el.setAttribute('role', 'option');
    el.dataset.key = key;
    el.addEventListener('click', () => {
      this.selected = key;
      this.paintSelection();
      this.rows.focus();
    });
    return el;
  }

  private textSpan(cls: string, text: string, title?: string): HTMLElement {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    if (title !== undefined) s.title = title;
    return s;
  }

  private rowButton(label: string, title: string, run: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'git-row-btn';
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      run();
    });
    return btn;
  }

  private localRow(b: GitLocalBranch, now: number): HTMLElement {
    const el = this.rowShell(`local:${b.name}`);
    if (b.head) el.classList.add('current');
    el.addEventListener('dblclick', () => this.primary(b));

    if (this.renaming === b.name) {
      el.append(this.renameField(b.name));
      return el;
    }
    el.append(this.textSpan('git-row-path git-branch-label', b.name, b.name));
    if (b.worktree !== null) el.append(this.textSpan('git-badge', 'worktree', `Checked out in ${b.worktree}`));
    const track = trackText(b);
    if (track !== '') el.append(this.textSpan(b.gone ? 'git-badge git-badge-gone' : 'git-branch-track', track, trackTitle(b)));

    const actions = document.createElement('span');
    actions.className = 'git-row-actions';
    if (b.worktree !== null) {
      actions.append(this.rowButton('Open', `Open ${b.worktree} in a Git pane`, () => this.opts.onOpenWorktree(b.worktree as string)));
    } else if (!b.head) {
      actions.append(this.rowButton('Switch', `git switch ${b.name}`, () => this.opts.onSwitch(b)));
    }
    actions.append(this.rowButton('Rename', 'Rename (F2)', () => this.startRename(b.name)));
    const locked = lockedReason(b);
    const del = this.rowButton('Delete', locked ?? 'Delete (Del)', () => this.opts.onDelete(b));
    del.disabled = locked !== null;
    actions.append(del);
    el.append(actions);

    el.append(this.textSpan('git-row-meta git-branch-meta', `${b.subject} · ${relativeTime(b.time, now)}`, b.subject));
    return el;
  }

  private remoteRow(b: GitRemoteBranch, now: number): HTMLElement {
    const el = this.rowShell(`remote:${b.name}`);
    el.addEventListener('dblclick', () => this.opts.onCheckOut(b));
    el.append(this.textSpan('git-row-path git-branch-label', b.name, b.name));
    const actions = document.createElement('span');
    actions.className = 'git-row-actions';
    actions.append(this.rowButton('Check out', `git switch --track ${b.name}`, () => this.opts.onCheckOut(b)));
    el.append(actions);
    el.append(this.textSpan('git-row-meta git-branch-meta', `${b.subject} · ${relativeTime(b.time, now)}`, b.subject));
    return el;
  }

  /** Enter renames; Escape or leaving the field cancels, so a stray click never renames. */
  private renameField(from: string): HTMLElement {
    const input = document.createElement('input');
    input.className = 'git-rename-field';
    input.value = from;
    input.spellcheck = false;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.renaming = null;
      this.render();
      this.rows.focus();
    };
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('input', () => {
      const to = input.value.trim();
      const err = to === from ? null : (branchNameError(to) ?? (this.list.local.some((b) => b.name === to) ? `${to} already exists` : null));
      input.classList.toggle('invalid', err !== null);
      input.title = err ?? '';
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const to = input.value.trim();
        if (to === from) {
          finish();
          return;
        }
        if (input.classList.contains('invalid') || to === '') return;
        done = true;
        void this.opts.onRename(from, to).then((ok) => {
          this.renaming = null;
          if (ok) this.selected = `local:${to}`;
          this.render();
          this.rows.focus();
        });
      }
    });
    input.addEventListener('blur', () => {
      if (!done) finish();
    });
    queueMicrotask(() => input.select());
    return input;
  }
}
