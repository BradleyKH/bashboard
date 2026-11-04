import type { ConfirmOptions } from './confirmDialog';
import { stopPort, type Listener } from './ports';
import { processLabel, stopConfirm } from './portsModel';
import type { PortsStore } from './portsStore';
import { showToast } from './toast';

/** Asks, stops the listener's process tree, and refreshes the list so the row goes at once. */
export async function stopListener(
  l: Listener,
  owner: string | null,
  confirm: (o: ConfirmOptions) => Promise<boolean>,
  store: PortsStore,
): Promise<void> {
  if (!(await confirm(stopConfirm(l, owner)))) return;
  try {
    await stopPort(l);
    showToast(`Stopped ${processLabel(l.name)} on port ${l.port}`, 2500);
  } catch (err) {
    showToast(`Could not stop ${processLabel(l.name)}: ${typeof err === 'string' ? err : String(err)}`);
  }
  await store.refresh();
}
