import './branchMenu.css';
import type { GitBranchList, GitLocalBranch, GitRemoteBranch } from './gitApi';
import { switcherEntries, switcherStart, type SwitcherEntry } from './gitBranchModel';

export interface BranchSwitcherHandlers {
  onLocal: (b: GitLocalBranch) => void;
  onRemote: (b: GitRemoteBranch) => void;
  onCreate: (name: string) => void;
}

let closeOpen: (() => void) | null = null;

function entryLabel(e: SwitcherEntry): string {
  if (e.kind === 'create') return `Create branch ${e.name}`;
  return e.branch.name;
}

function entryNote(e: SwitcherEntry): string {
  if (e.kind === 'create') return 'from HEAD';
  if (e.kind === 'remote') return 'remote';
  if (e.branch.head) return 'current';
  if (e.branch.worktree !== null) return 'worktree';
  return '';
}

/**
 * The branch name's quick switcher (docs/design/git.md section 4.13): a filter field over the
 * branches, ending in a Create row when the text is a new valid name.
 */
export function openBranchSwitcher(anchor: HTMLElement, list: GitBranchList, h: BranchSwitcherHandlers): void {
  const toggledOff = anchor.classList.contains('open') && closeOpen !== null;
  closeOpen?.();
  if (toggledOff) return;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const menu = document.createElement('div');
  menu.className = 'branch-menu git-switcher';
  menu.setAttribute('role', 'dialog');
  const field = document.createElement('input');
  field.className = 'git-switcher-field';
  field.placeholder = 'Switch to, or new branch name';
  field.spellcheck = false;
  const rows = document.createElement('div');
  rows.className = 'git-switcher-rows';
  rows.setAttribute('role', 'listbox');
  menu.append(field, rows);

  let entries: SwitcherEntry[] = [];
  let at = -1;

  const close = (): void => {
    if (closeOpen !== close) return;
    closeOpen = null;
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('blur', close);
    menu.remove();
    anchor.classList.remove('open');
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  const onOutside = (e: MouseEvent): void => {
    const target = e.target as Node;
    if (!menu.contains(target) && !anchor.contains(target)) close();
  };
  const pick = (e: SwitcherEntry | undefined): void => {
    if (!e) return;
    close();
    if (e.kind === 'create') h.onCreate(e.name);
    else if (e.kind === 'remote') h.onRemote(e.branch);
    else if (!e.branch.head) h.onLocal(e.branch);
  };
  const paint = (): void => {
    rows.querySelectorAll('.git-switcher-row').forEach((el, i) => el.classList.toggle('active', i === at));
    rows.querySelector('.git-switcher-row.active')?.scrollIntoView({ block: 'nearest' });
  };
  const render = (): void => {
    entries = switcherEntries(list, field.value);
    at = switcherStart(entries);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'git-empty';
      empty.textContent = field.value.trim() === '' ? 'No branches' : 'No match, and not a valid branch name';
      rows.replaceChildren(empty);
      return;
    }
    rows.replaceChildren(
      ...entries.map((e, i) => {
        const row = document.createElement('div');
        row.className = 'git-switcher-row';
        row.setAttribute('role', 'option');
        if (e.kind === 'create') row.classList.add('create');
        if (e.kind === 'local' && e.branch.head) row.classList.add('current');
        const label = document.createElement('span');
        label.className = 'branch-menu-label';
        label.textContent = entryLabel(e);
        const note = document.createElement('span');
        note.className = 'git-switcher-note';
        note.textContent = entryNote(e);
        if (e.kind === 'local' && e.branch.worktree !== null) note.title = e.branch.worktree;
        row.append(label, note);
        row.addEventListener('mousemove', () => {
          if (at !== i) {
            at = i;
            paint();
          }
        });
        row.addEventListener('click', () => pick(e));
        return row;
      }),
    );
    paint();
  };

  field.addEventListener('input', render);
  menu.addEventListener('keydown', (e) => {
    // Keep keys away from the workspace keymap and xterm.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (entries.length === 0) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      at = at < 0 ? 0 : (at + delta + entries.length) % entries.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(entries[at]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  });
  menu.addEventListener('keypress', (e) => e.stopPropagation());
  menu.addEventListener('keyup', (e) => e.stopPropagation());
  // A press on a row keeps focus in the field.
  rows.addEventListener('mousedown', (e) => e.preventDefault());

  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('blur', close);
  closeOpen = close;

  document.body.append(menu);
  anchor.classList.add('open');
  render();
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - menu.offsetWidth))}px`;
  const top = rect.bottom + 2;
  menu.style.top = `${top}px`;
  menu.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
  field.focus();
}
