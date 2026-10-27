import { buildKeymap, type Keymap } from './keymap';
import type { Settings, SettingsPayload } from './settings';
import { showToast } from './toast';

/** The latest settings payload and the keymap built from it, toasting each distinct warning once. */
export class LiveSettings {
  settings!: Settings;
  keymap!: Keymap;
  private readonly shownWarnings = new Set<string>();

  constructor(payload: SettingsPayload) {
    this.update(payload);
  }

  update(payload: SettingsPayload): void {
    const { keymap, warnings } = buildKeymap(payload.settings.keybindings);
    this.settings = payload.settings;
    this.keymap = keymap;
    for (const w of [...payload.warnings, ...warnings]) {
      if (this.shownWarnings.has(w)) continue;
      this.shownWarnings.add(w);
      showToast(`Settings: ${w}`);
    }
  }
}
