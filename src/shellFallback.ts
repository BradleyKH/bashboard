import { profileName } from './profiles';
import { showToast } from './toast';

const announced = new Set<string>();

/** Toasts the first time in a session that a pane asked for a shell that is not installed. */
export function noteShellFallback(wanted: string, started: string, toast: (message: string) => void = showToast): void {
  if (announced.has(wanted)) return;
  announced.add(wanted);
  toast(`${profileName(wanted)} is not installed; using ${profileName(started)} instead`);
}

export function resetShellFallbackForTests(): void {
  announced.clear();
}
