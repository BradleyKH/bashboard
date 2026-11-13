import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  cloudChips,
  compileProductionPattern,
  type AwsContext,
  type AzureContext,
  type CloudChip,
} from './cloudContextModel';
import { DEFAULT_SETTINGS, type Settings } from './settings';

/**
 * The machine-wide half of the cloud-context chips (docs/design/terminal.md section 4.25): the
 * Azure default subscription and the `cloud` settings. AWS is per pane and comes from each
 * terminal's OSC 7502 report, so callers pass it to `chipsFor`. Changes arrive as events from
 * the core; nothing polls.
 */
export class CloudContextStore {
  private azure: AzureContext | null = null;
  private badge = DEFAULT_SETTINGS.cloud.badge;
  private patternSource = DEFAULT_SETTINGS.cloud.productionPattern;
  private pattern: RegExp | null = compileProductionPattern(this.patternSource);
  private readonly subscribers = new Set<() => void>();
  private started = false;

  /** Does not call back immediately. Fires when the Azure context or the settings change. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  chipsFor(aws: AwsContext | null): CloudChip[] {
    return cloudChips(aws, this.azure, this.pattern, this.badge);
  }

  applySettings(settings: Pick<Settings, 'cloud'>): void {
    const { badge, productionPattern } = settings.cloud;
    if (badge === this.badge && productionPattern === this.patternSource) return;
    this.badge = badge;
    this.patternSource = productionPattern;
    this.pattern = compileProductionPattern(productionPattern);
    this.emit();
  }

  /** Fetches the current context and listens for changes; later calls do nothing. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Both reject (or throw) without a Tauri runtime, as under `pnpm dev`: Azure stays null.
    try {
      void listen<AzureContext | null>('cloud://azure', (e) => this.setAzure(e.payload)).catch(() => {});
      void invoke<AzureContext | null>('azure_context').then(
        (ctx) => this.setAzure(ctx),
        () => {},
      );
    } catch {
      // No Tauri runtime.
    }
  }

  private setAzure(next: AzureContext | null): void {
    const prev = this.azure;
    if (prev === next) return;
    if (prev && next && prev.name === next.name && prev.id === next.id && prev.user === next.user) return;
    this.azure = next ?? null;
    this.emit();
  }

  private emit(): void {
    for (const cb of [...this.subscribers]) cb();
  }
}

export const cloudContextStore = new CloudContextStore();
