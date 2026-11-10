import { agentsDetected } from './agentApi';
import { gitInstallStatus, type GitInstallStatus } from './gitInstall';
import { hookInstallPreview, type HookInstallPreview } from './hookInstall';
import type { AgentId } from './savedWorkspace';
import { profileName, type ShellProfile } from './profiles';
import { isIntegrationShell, shellIntegrationInstall, shellIntegrationPreview } from './shellIntegration';
import { gitRow, hooksRow, shellRow, type StatusFix, type StatusRow } from './setupStatusModel';
import { supports } from './platform';

export interface SetupStatusCallbacks {
  getProfiles(): ShellProfile[];
  /** The profile id new panes start with. */
  getDefaultProfile(): string;
  /** Installs Git for Windows; resolves once the shell profiles are refreshed. */
  installGit(): Promise<void>;
  openGitDownload(): void;
  /** Shows the hook install preview; resolves to whether the hooks were installed. */
  installHooks(agent: AgentId): Promise<boolean>;
  /** Run setup was clicked; the dialog closes first. */
  onRunSetup(): void;
}

const LEVEL_MARKS = { ok: '✓', missing: '!', info: '•' } as const;

/** The Help tab's setup status: one live check per piece of setup, each with its fix. */
export class SetupStatus {
  readonly element: HTMLElement;
  private readonly rows: HTMLElement;
  private readonly error: HTMLElement;
  /** Bumped per refresh, so a slow answer from an earlier one is dropped. */
  private generation = 0;
  private busy = false;

  constructor(private readonly callbacks: SetupStatusCallbacks) {
    this.element = document.createElement('section');
    this.element.className = 'setup-status';
    const h = document.createElement('h3');
    h.textContent = 'Setup';
    this.rows = document.createElement('div');
    this.rows.className = 'setup-status-rows';
    this.error = document.createElement('div');
    this.error.className = 'setup-status-error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'app-dialog-button';
    run.textContent = 'Run setup';
    run.title = 'Walk through every setup step again';
    run.addEventListener('click', () => this.callbacks.onRunSetup());
    this.element.append(h, this.rows, this.error, run);
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    if (this.rows.childElementCount === 0) this.rows.append(note('Checking…'));
    const profiles = this.callbacks.getProfiles();
    const preferred = this.callbacks.getDefaultProfile();
    const shells = profiles
      .flatMap((p) => (isIntegrationShell(p.id) ? [p.id] : []))
      .sort((a, b) => Number(b === preferred) - Number(a === preferred));
    const [git, hooks, shellPreviews] = await Promise.all([
      gitInstallStatus().catch((): GitInstallStatus | null => null),
      this.hookPreviews(),
      Promise.all(shells.map((shell) => shellIntegrationPreview(shell).catch((e: unknown) => String(e)))),
    ]);
    if (generation !== this.generation) return;
    const rows: StatusRow[] = [
      ...(supports('gitInstall') ? [gitRow(git)] : []),
      ...shells.map((shell, i) => shellRow(shell, profileName(shell, profiles), shellPreviews[i], shell === preferred)),
      ...hooks.map(([agent, preview]) => hooksRow(agent, preview)),
    ];
    this.rows.replaceChildren(...rows.map((r) => this.rowElement(r)));
  }

  /** Claude Code is always listed; the other agents appear once they have run here. */
  private async hookPreviews(): Promise<[AgentId, HookInstallPreview | null][]> {
    const detected = await agentsDetected().catch((): AgentId[] => []);
    const agents: AgentId[] = ['claude', ...detected.filter((a) => a !== 'claude')];
    return Promise.all(
      agents.map(async (a): Promise<[AgentId, HookInstallPreview | null]> => [
        a,
        await hookInstallPreview(a).catch((): HookInstallPreview | null => null),
      ]),
    );
  }

  private rowElement(row: StatusRow): HTMLElement {
    const el = document.createElement('div');
    el.className = `setup-status-row setup-status-${row.level}`;
    const mark = document.createElement('span');
    mark.className = 'setup-status-mark';
    mark.textContent = LEVEL_MARKS[row.level];
    mark.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'setup-status-text';
    const label = document.createElement('div');
    label.className = 'setup-status-label';
    label.textContent = row.label;
    text.append(label, note(row.text));
    el.append(mark, text);
    const fix = row.fix;
    if (fix) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'app-dialog-button';
      button.textContent = fix.label;
      button.disabled = this.busy;
      button.addEventListener('click', () => void this.runFix(fix, button));
      el.append(button);
    }
    return el;
  }

  private async runFix(fix: StatusFix, button: HTMLButtonElement): Promise<void> {
    if (this.busy) return;
    if (fix.kind === 'gitDownload') {
      this.callbacks.openGitDownload();
      return;
    }
    this.busy = true;
    this.error.hidden = true;
    for (const b of this.rows.querySelectorAll('button')) b.disabled = true;
    if (fix.kind === 'gitInstall') button.textContent = 'Installing…';
    try {
      if (fix.kind === 'gitInstall') await this.callbacks.installGit();
      else if (fix.kind === 'shell') await shellIntegrationInstall(fix.shell);
      else await this.callbacks.installHooks(fix.agent);
    } catch (err) {
      this.error.textContent = err instanceof Error ? err.message : String(err);
      this.error.hidden = false;
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }
}

function note(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'app-dialog-note';
  el.textContent = text;
  return el;
}
