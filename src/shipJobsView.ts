import { asForgeError, type Job, type JobLog, type Run, type Step } from './forgeApi';
import { cleanLog, duration, splitLogAtLine, statusInfo } from './shipModel';

export interface ShipJobsViewOptions {
  loadJobs: () => Promise<Job[]>;
  loadLog: (jobId: string) => Promise<JobLog>;
  /** Whether the host serves job logs; when false jobs show their steps only. */
  logs: boolean;
}

interface JobState {
  open: boolean;
  /** Kept across reloads so an open log keeps its scroll position. */
  logEl: HTMLElement;
  loaded: boolean;
  loading: boolean;
  /** Scrolls the loaded log into place; held back when the log loaded while hidden. */
  settle: (() => void) | null;
}

/** Lines of context kept above the first error when a log opens on it. */
const CONTEXT_LINES = 2;

/** A job timed like a run, since `duration` reads a run's start, finish, and status. */
function runLike(job: Job): Run {
  return {
    id: job.id,
    number: null,
    name: job.name,
    title: job.name,
    branch: null,
    sha: null,
    event: null,
    status: job.status,
    rawStatus: '',
    actor: null,
    createdAt: job.startedAt ?? '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    webUrl: '',
  };
}

function statusIcon(status: Job['status']): HTMLElement {
  const info = statusInfo(status);
  const icon = document.createElement('span');
  icon.className = `ship-status ship-status--${info.modifier}`;
  icon.title = info.label;
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

/**
 * The jobs of one run, each with its steps and an on-demand log (docs/design/ship.md section 4.20).
 */
export class ShipJobsView {
  readonly el: HTMLElement;
  private jobs: Job[] = [];
  private loadedOnce = false;
  private error: string | null = null;
  private seq = 0;
  private disposed = false;
  private readonly states = new Map<string, JobState>();

  constructor(private readonly opts: ShipJobsViewOptions) {
    this.el = document.createElement('div');
    this.el.className = 'ship-jobs';
    this.render();
    void this.reload();
  }

  /** Fetches the jobs again, keeping what is shown until the answer arrives. */
  async reload(): Promise<void> {
    const seq = ++this.seq;
    try {
      const jobs = await this.opts.loadJobs();
      if (this.disposed || seq !== this.seq) return;
      this.jobs = jobs;
      this.error = null;
    } catch (e) {
      if (this.disposed || seq !== this.seq) return;
      this.error = asForgeError(e).message;
    }
    this.loadedOnce = true;
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    this.el.remove();
  }

  private render(): void {
    const children: HTMLElement[] = [];
    if (this.error !== null) children.push(this.note(this.error, 'ship-jobs-error'));
    if (!this.loadedOnce) {
      children.push(this.note('Loading jobs…'));
    } else if (this.jobs.length === 0 && this.error === null) {
      children.push(this.note('No jobs reported.'));
    }
    for (const job of this.jobs) children.push(this.renderJob(job));
    this.el.replaceChildren(...children);
  }

  private note(text: string, extra = ''): HTMLElement {
    const el = document.createElement('div');
    el.className = `ship-note ${extra}`.trim();
    el.textContent = text;
    return el;
  }

  private stateFor(jobId: string): JobState {
    let state = this.states.get(jobId);
    if (!state) {
      const logEl = document.createElement('div');
      logEl.className = 'ship-log-wrap';
      state = { open: false, logEl, loaded: false, loading: false, settle: null };
      this.states.set(jobId, state);
    }
    return state;
  }

  private renderJob(job: Job): HTMLElement {
    const state = this.stateFor(job.id);
    const el = document.createElement('div');
    el.className = 'ship-job';

    const head = document.createElement('div');
    head.className = 'ship-job-head';
    const name = document.createElement('span');
    name.className = 'ship-job-name';
    name.textContent = job.name;
    const took = document.createElement('span');
    took.className = 'ship-job-took';
    took.textContent = duration(runLike(job), Date.now());
    head.append(statusIcon(job.status), name, took);
    el.append(head);

    if (job.steps.length > 0) {
      const steps = document.createElement('ol');
      steps.className = 'ship-steps';
      for (const step of job.steps) steps.append(this.renderStep(step));
      el.append(steps);
    }

    if (this.opts.logs) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ship-log-toggle';
      toggle.textContent = state.open ? 'Hide log' : 'Show log';
      toggle.addEventListener('click', () => {
        state.open = !state.open;
        toggle.textContent = state.open ? 'Hide log' : 'Show log';
        state.logEl.hidden = !state.open;
        if (state.open && !state.loaded) void this.loadLog(job.id, state);
        // A hidden element cannot be scrolled, so a log that loaded while hidden settles now.
        if (state.open && state.settle) {
          state.settle();
          state.settle = null;
        }
      });
      state.logEl.hidden = !state.open;
      el.append(toggle, state.logEl);
    }
    return el;
  }

  private renderStep(step: Step): HTMLElement {
    const li = document.createElement('li');
    li.className = 'ship-step';
    const info = statusInfo(step.status);
    li.classList.toggle('failed', step.status === 'failure');
    const icon = document.createElement('span');
    icon.className = `ship-status ship-status--${info.modifier}`;
    icon.title = info.label;
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'ship-step-name';
    text.textContent = step.name;
    li.append(icon, text);
    if (step.status === 'failure') {
      const mark = document.createElement('span');
      mark.className = 'ship-step-mark';
      mark.textContent = 'failed';
      li.append(mark);
    }
    return li;
  }

  private async loadLog(jobId: string, state: JobState): Promise<void> {
    if (state.loading) return;
    state.loading = true;
    state.logEl.replaceChildren(this.note('Loading log…'));
    try {
      const log = await this.opts.loadLog(jobId);
      if (this.disposed) return;
      const text = cleanLog(log.text);
      const split = log.firstError === undefined ? null : splitLogAtLine(text, log.firstError);
      const pre = document.createElement('pre');
      pre.className = 'ship-log';
      const mark = document.createElement('span');
      if (split) {
        mark.className = 'ship-log-error';
        mark.textContent = split.line;
        pre.append(split.before, mark, split.after);
      } else {
        pre.textContent = text;
      }
      const toEnd = () => {
        pre.scrollTop = pre.scrollHeight;
      };
      const parts: HTMLElement[] = [];
      if (log.truncated || split) {
        const bar = document.createElement('div');
        bar.className = 'ship-log-bar';
        if (log.truncated) bar.append(this.note('Showing the last 1 MiB of the log.', 'ship-log-trunc'));
        if (split) {
          const jump = document.createElement('button');
          jump.type = 'button';
          jump.className = 'ship-log-jump';
          jump.textContent = 'Jump to end';
          jump.addEventListener('click', toEnd);
          bar.append(jump);
        }
        parts.push(bar);
      }
      parts.push(pre);
      state.logEl.replaceChildren(...parts);
      state.loaded = true;
      // A failure is where the log should open: on the first error when the core found one, else at the end.
      // Measured from the marked line rather than its index, since the padding and any line a fallback
      // font makes taller would otherwise shift it. `.ship-log` is positioned, so offsetTop is from its top.
      const settle = () => {
        if (split) {
          const lineHeight = Number.parseFloat(getComputedStyle(pre).lineHeight) || 15;
          const halfLeading = Math.max(0, (lineHeight - mark.offsetHeight) / 2);
          pre.scrollTop = Math.max(0, Math.floor(mark.offsetTop - halfLeading - CONTEXT_LINES * lineHeight));
        } else {
          toEnd();
        }
      };
      if (state.logEl.hidden) state.settle = settle;
      else settle();
    } catch (e) {
      if (this.disposed) return;
      state.logEl.replaceChildren(this.note(asForgeError(e).message, 'ship-jobs-error'));
    } finally {
      state.loading = false;
    }
  }
}
