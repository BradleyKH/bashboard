import { cloudChips, compileProductionPattern, type AwsContext, type CloudChip } from './cloudContextModel';
import { DEFAULT_SETTINGS, type Settings } from './settings';

/**
 * The `cloud` settings behind the cloud-context chips (docs/design/terminal.md section 4.25).
 * The AWS context is per pane and comes from each terminal's OSC 7502 report, so callers pass it
 * to `chipsFor`.
 */
export class CloudContextStore {
  private badge = DEFAULT_SETTINGS.cloud.badge;
  private patternSource = DEFAULT_SETTINGS.cloud.productionPattern;
  private pattern: RegExp | null = compileProductionPattern(this.patternSource);
  private readonly subscribers = new Set<() => void>();

  /** Does not call back immediately. Fires when the settings change. */
  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  chipsFor(aws: AwsContext | null): CloudChip[] {
    return cloudChips(aws, this.pattern, this.badge);
  }

  applySettings(settings: Pick<Settings, 'cloud'>): void {
    const { badge, productionPattern } = settings.cloud;
    if (badge === this.badge && productionPattern === this.patternSource) return;
    this.badge = badge;
    this.patternSource = productionPattern;
    this.pattern = compileProductionPattern(productionPattern);
    for (const cb of [...this.subscribers]) cb();
  }
}

export const cloudContextStore = new CloudContextStore();
