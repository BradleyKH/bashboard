import type { ConfirmOptions } from './confirmDialog';
import {
  gitCheckoutRemote,
  gitCreateBranch,
  gitDeleteBranch,
  gitRenameBranch,
  gitRestoreBranch,
  gitSwitch,
  type GitLocalBranch,
} from './gitApi';
import { cleanupGoneConfirm, deleteUnmergedConfirm } from './paneConfirm';
import { showToast } from './toast';

export interface GitBranchActionsOptions {
  root: () => string;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** git's output for a failure, shown where the user acted; null clears it. */
  showError: (text: string | null) => void;
  refresh: () => void;
}

const RESTORE_MS = 12_000;

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The Git pane's branch operations and their confirms and toasts (docs/design/git.md section 4.13).
 */
export class GitBranchActions {
  private busy = false;

  constructor(private readonly opts: GitBranchActionsOptions) {}

  switchTo(name: string): Promise<boolean> {
    return this.run(() => gitSwitch(this.opts.root(), name));
  }

  checkOut(remoteName: string): Promise<boolean> {
    return this.run(() => gitCheckoutRemote(this.opts.root(), remoteName));
  }

  /** New branches are always switched to; "from here" sets `base`. */
  create(name: string, base: string | null): Promise<boolean> {
    return this.run(() => gitCreateBranch(this.opts.root(), name, base, true));
  }

  rename(from: string, to: string): Promise<boolean> {
    return this.run(async () => {
      const cleared = await gitRenameBranch(this.opts.root(), from, to);
      // git keeps the old upstream, so a plain push would refuse the mismatched name.
      if (cleared) showToast(`Renamed ${from} to ${to}. Its upstream was cleared, so Push reads Publish.`);
    });
  }

  async remove(b: GitLocalBranch): Promise<void> {
    const root = this.opts.root();
    await this.run(async () => {
      let outcome = await gitDeleteBranch(root, b.name, false);
      if (!outcome.deleted) {
        const ok = await this.opts.confirm(deleteUnmergedConfirm(b.name, outcome.unmerged ?? 0));
        if (!ok) return;
        outcome = await gitDeleteBranch(root, b.name, true);
      }
      const { hash } = outcome;
      showToast(`Deleted ${b.name}`, RESTORE_MS, {
        label: 'Restore',
        run: () => void this.restore(root, [{ name: b.name, hash }]),
      });
    });
  }

  async cleanup(branches: readonly GitLocalBranch[]): Promise<void> {
    if (branches.length === 0) return;
    const ok = await this.opts.confirm(cleanupGoneConfirm(branches.map((b) => b.name)));
    if (!ok) return;
    const root = this.opts.root();
    await this.run(async () => {
      const deleted: Array<{ name: string; hash: string }> = [];
      const failed: string[] = [];
      for (const b of branches) {
        try {
          const { hash } = await gitDeleteBranch(root, b.name, true);
          deleted.push({ name: b.name, hash });
        } catch (e) {
          failed.push(`${b.name}: ${errorText(e)}`);
        }
      }
      if (deleted.length > 0) {
        const n = deleted.length;
        showToast(`Deleted ${n} ${n === 1 ? 'branch' : 'branches'}`, RESTORE_MS, {
          label: 'Restore',
          run: () => void this.restore(root, deleted),
        });
      }
      if (failed.length > 0) throw failed.join('\n');
    });
  }

  private async restore(root: string, branches: ReadonlyArray<{ name: string; hash: string }>): Promise<void> {
    const failed: string[] = [];
    for (const b of branches) {
      try {
        await gitRestoreBranch(root, b.name, b.hash);
      } catch (e) {
        failed.push(`${b.name}: ${errorText(e)}`);
      }
    }
    if (failed.length > 0) showToast(`Could not restore ${failed.join('; ')}`);
    this.opts.refresh();
  }

  /** One operation at a time; a failure shows git's output and resolves false. */
  private async run(work: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await work();
      this.opts.showError(null);
      return true;
    } catch (e) {
      this.opts.showError(errorText(e));
      return false;
    } finally {
      this.busy = false;
      this.opts.refresh();
    }
  }
}
