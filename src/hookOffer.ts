// Agent hook installs: the dashboard's offer for each detected agent whose hooks are missing, and
// the install preview dialog that the offer, the Help tab, and the setup wizard open.
import { agentsDetected } from './agentApi';
import { agentName } from './agentNames';
import type { DashboardPanel } from './dashboardPanel';
import { hookInstall, hookInstallPreview, type HookInstallPreview } from './hookInstall';
import { HookInstallDialog } from './hookInstallDialog';
import type { AgentId } from './savedWorkspace';
import { agentHooksFrom } from './setupModel';
import { showToast } from './toast';

export interface HookOfferDeps {
  panel: DashboardPanel;
  focusTerminal: () => void;
}

export class HookOffer {
  private readonly dialog: HookInstallDialog;

  constructor(private readonly deps: HookOfferDeps) {
    this.dialog = new HookInstallDialog({
      onConfirm: async (agent) => {
        await hookInstall(agent);
        void this.refresh();
        const name = agentName(agent);
        showToast(
          agent === 'codex'
            ? 'Codex hooks installed. Codex will ask you to trust them on its next start.'
            : `${name} hooks installed. ${name} sessions started from now on report waiting.`,
        );
      },
      onClose: deps.focusTerminal,
    });
  }

  /** The hook preview of every agent that has run here; one that cannot be read is left out. */
  async detectedPreviews(): Promise<HookInstallPreview[]> {
    const agents = await agentsDetected();
    const previews = await Promise.all(agents.map((a) => hookInstallPreview(a).catch(() => null)));
    return previews.filter((p): p is HookInstallPreview => p !== null);
  }

  /** Offers an install button for each detected agent whose hooks are missing. */
  refresh(): Promise<void> {
    return this.detectedPreviews()
      .then((previews) =>
        this.deps.panel.setMissingHooks(
          agentHooksFrom(previews)
            .filter((a) => !a.installed)
            .map(({ agent, update }) => ({ agent, update: update ?? false })),
        ),
      )
      .catch((e) => console.warn('hook install state unavailable:', e));
  }

  /** The dashboard's install button: the preview, or a note when the hooks are already in. */
  offer(agent: AgentId): void {
    hookInstallPreview(agent)
      .then((preview) => {
        if (preview.alreadyInstalled) showToast(`${agentName(agent)} hooks are already installed.`);
        else this.dialog.open(preview);
      })
      .catch((err: unknown) => showToast(`Could not prepare the hook install: ${String(err)}`));
  }

  /** Shows the hook install preview unless the hooks are in; resolves to whether they are installed. */
  readonly install = (agent: AgentId): Promise<boolean> =>
    hookInstallPreview(agent).then(
      (preview) =>
        new Promise<boolean>((resolve) => {
          if (preview.alreadyInstalled) {
            void this.refresh();
            resolve(true);
          } else {
            this.dialog.open(preview, resolve);
          }
        }),
      (err: unknown) => {
        showToast(`Could not prepare the hook install: ${String(err)}`);
        return false;
      },
    );
}
