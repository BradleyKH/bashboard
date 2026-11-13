import './commandPinDialog.css';
import './worktreeDialogs.css';
import { AGENT_IDS, agentName, type AgentId } from './agentTable';
import { worktreeCreate, worktreePlan, type WorktreeCreated, type WorktreePlan } from './worktreeApi';
import { newDialogStatus, type NewDialogState } from './worktreeFlowModel';

export interface WorktreeNewOptions {
  /** The focused pane's folder; null when no pane has one. */
  folder: string | null;
  isGit: boolean;
}

export interface WorktreeNewResult {
  created: WorktreeCreated;
  agent: AgentId | null;
  prompt: string | null;
}

/** How long typing settles before the plan is asked for. */
const PLAN_DEBOUNCE_MS = 250;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The palette's New worktree prompt (docs/design/git.md section 4.27): a branch name with the
 * plan it resolves to, and an optional agent and prompt for the new pane. Creates the worktree
 * itself, so errors stay inline; resolves the result, or null on Escape, Cancel, or an outside
 * click.
 */
export class WorktreeNewDialog {
  private backdrop: HTMLElement | null = null;
  private settle: ((result: WorktreeNewResult | null) => void) | null = null;
  private restoreFocus: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  open(options: WorktreeNewOptions): Promise<WorktreeNewResult | null> {
    this.finish(null);
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise((resolve) => {
      this.settle = resolve;
      const state: NewDialogState = {
        folder: options.folder,
        isGit: options.isGit,
        branch: '',
        plan: null,
        planError: null,
        planning: false,
        creating: false,
        createError: null,
      };
      // Each plan request's number; a reply for older text is dropped.
      let seq = 0;

      const backdrop = document.createElement('div');
      backdrop.className = 'hook-dialog-backdrop';
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop && !state.creating) {
          e.preventDefault();
          this.finish(null);
        }
      });

      const box = document.createElement('form');
      box.className = 'hook-dialog worktree-dialog';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      const title = document.createElement('h2');
      title.textContent = 'New worktree';

      const branchRow = document.createElement('label');
      branchRow.className = 'command-pin-field';
      const branchText = document.createElement('span');
      branchText.textContent = 'Branch';
      const branch = document.createElement('input');
      branch.type = 'text';
      branch.spellcheck = false;
      branch.placeholder = 'feature/my-change';
      branchRow.append(branchText, branch);

      const planEl = document.createElement('p');
      planEl.className = 'hook-dialog-line worktree-new-plan';

      const agentRow = document.createElement('label');
      agentRow.className = 'command-pin-field worktree-new-field';
      const agentText = document.createElement('span');
      agentText.textContent = 'Agent';
      const agent = document.createElement('select');
      const none = document.createElement('option');
      none.value = '';
      none.textContent = 'None';
      agent.append(none);
      for (const id of AGENT_IDS) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = agentName(id);
        agent.append(opt);
      }
      agentRow.append(agentText, agent);

      const promptRow = document.createElement('label');
      promptRow.className = 'command-pin-field';
      const promptText = document.createElement('span');
      promptText.textContent = 'Prompt';
      const prompt = document.createElement('input');
      prompt.type = 'text';
      prompt.placeholder = 'Optional; the agent’s first message';
      promptRow.append(promptText, prompt);

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => this.finish(null));

      const create = document.createElement('button');
      create.type = 'submit';
      create.className = 'hook-dialog-install';
      create.textContent = 'Create';

      const buttons = document.createElement('div');
      buttons.className = 'hook-dialog-buttons';
      buttons.append(cancel, create);

      const render = (): void => {
        const status = newDialogStatus(state);
        planEl.textContent = status.text;
        planEl.title = status.text;
        planEl.classList.toggle('hook-dialog-error', status.error);
        create.disabled = !status.canCreate;
        create.textContent = state.creating ? 'Creating...' : 'Create';
        const usable = state.folder !== null && state.isGit && !state.creating;
        branch.disabled = !usable;
        agent.disabled = !usable;
        prompt.disabled = !usable || agent.value === '';
        cancel.disabled = state.creating;
      };

      const requestPlan = (): void => {
        const text = branch.value.trim();
        const n = ++seq;
        if (text === '' || state.folder === null || !state.isGit) {
          state.planning = false;
          state.plan = null;
          state.planError = null;
          render();
          return;
        }
        worktreePlan(state.folder, text).then(
          (plan: WorktreePlan) => {
            if (n !== seq || !this.backdrop) return;
            state.planning = false;
            state.plan = plan;
            state.planError = null;
            render();
          },
          (e: unknown) => {
            if (n !== seq || !this.backdrop) return;
            state.planning = false;
            state.plan = null;
            state.planError = errorText(e);
            render();
          },
        );
      };

      branch.addEventListener('input', () => {
        state.branch = branch.value;
        state.createError = null;
        state.planning = branch.value.trim() !== '';
        // A plan for older text must not enable Create for this text.
        state.plan = null;
        state.planError = null;
        seq++;
        render();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          requestPlan();
        }, PLAN_DEBOUNCE_MS);
      });
      agent.addEventListener('change', render);

      box.addEventListener('keydown', (e) => {
        // Keep keys away from the workspace keymap and xterm.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          if (!state.creating) this.finish(null);
        }
      });
      box.addEventListener('submit', (e) => {
        e.preventDefault();
        if (create.disabled || state.folder === null) return;
        const chosen = agent.value === '' ? null : (agent.value as AgentId);
        const promptValue = chosen && prompt.value.trim() !== '' ? prompt.value.trim() : null;
        state.creating = true;
        state.createError = null;
        render();
        worktreeCreate(state.folder, branch.value.trim()).then(
          (created) => {
            state.creating = false;
            this.finish({ created, agent: chosen, prompt: promptValue });
          },
          (err: unknown) => {
            state.creating = false;
            state.createError = errorText(err);
            if (this.backdrop) {
              render();
              branch.focus();
            }
          },
        );
      });

      box.append(title, branchRow, planEl, agentRow, promptRow, buttons);
      backdrop.append(box);
      document.body.append(backdrop);
      this.backdrop = backdrop;
      render();
      if (state.folder === null || !state.isGit) cancel.focus();
      else branch.focus();
    });
  }

  private finish(result: WorktreeNewResult | null): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.backdrop) return;
    this.backdrop.remove();
    this.backdrop = null;
    const settle = this.settle;
    this.settle = null;
    // The new pane takes focus on success, so the old focus is only restored on a cancel.
    if (result === null) this.restoreFocus?.focus();
    this.restoreFocus = null;
    settle?.(result);
  }
}
