import type { MenuEntry } from './contextMenuModel';
import type { JobLog, Job, Run } from './forgeApi';
import { statusInfo } from './forgeModel';
import { ForgeJobsView } from './forgeJobsView';
import { ForgeRunRow } from './forgeRunRow';

export interface ForgeRunListOptions {
  loadJobs: (runId: string) => Promise<Job[]>;
  loadLog: (runId: string, jobId: string) => Promise<JobLog>;
  /** Whether the host serves job logs. */
  logs: () => boolean;
  menuItems: (run: Run) => MenuEntry[];
}

interface Slot {
  row: ForgeRunRow;
  jobs: ForgeJobsView | null;
}

/**
 * The Pipelines list (docs/design.md section 4.20). `update` is cheap to call every second: rows
 * keep their elements, so a poll or a tick that changed only times touches only those texts, and an
 * expanded run keeps its jobs view, with its open logs.
 */
export class ForgeRunList {
  readonly el: HTMLElement;
  private readonly slots = new Map<string, Slot>();
  private readonly note: HTMLElement;

  constructor(private readonly opts: ForgeRunListOptions) {
    this.el = document.createElement('div');
    this.el.className = 'forge-runs';
    this.note = document.createElement('div');
    this.note.className = 'forge-note';
  }

  /** `emptyText` is shown when `runs` is empty ("Loading…", "No runs on this branch."). */
  update(runs: readonly Run[], nowMs: number, emptyText: string): void {
    const seen = new Set<string>();
    const children: HTMLElement[] = [];
    for (const run of runs) {
      seen.add(run.id);
      let slot = this.slots.get(run.id);
      if (!slot) {
        slot = { row: new ForgeRunRow(run, { onToggle: (r) => this.toggle(r.id), menuItems: this.opts.menuItems }), jobs: null };
        this.slots.set(run.id, slot);
      } else {
        const previous = slot.row.run;
        slot.row.update(run, nowMs);
        // A new object means a poll answered (a tick passes the same ones). A moving run's jobs and
        // steps change under the open view, and a run that just finished needs a last look.
        const polled = previous !== run;
        if (slot.jobs && polled && (statusInfo(run.status).active || previous.status !== run.status)) {
          void slot.jobs.reload();
        }
      }
      children.push(slot.row.el);
    }
    for (const [id, slot] of this.slots) {
      if (seen.has(id)) continue;
      slot.jobs?.dispose();
      this.slots.delete(id);
    }

    if (children.length === 0) {
      if (this.note.textContent !== emptyText) this.note.textContent = emptyText;
      children.push(this.note);
    }
    const current = Array.from(this.el.children);
    if (current.length !== children.length || current.some((c, i) => c !== children[i])) {
      this.el.replaceChildren(...children);
    }
  }

  private toggle(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    const open = !slot.row.isExpanded;
    slot.row.setExpanded(open);
    if (open && !slot.jobs) {
      slot.jobs = new ForgeJobsView({
        loadJobs: () => this.opts.loadJobs(id),
        loadLog: (jobId) => this.opts.loadLog(id, jobId),
        logs: this.opts.logs(),
      });
      slot.row.detail.append(slot.jobs.el);
    } else if (open && slot.jobs) {
      void slot.jobs.reload();
    }
  }
}
