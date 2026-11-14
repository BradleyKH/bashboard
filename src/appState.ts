// The startup-loaded values that main.ts and its controllers share. Hot reloads and file watchers
// replace fields in place, so every holder of this object reads the current value.
import type { Favorite } from './favorites';
import type { GlobalPinsFile } from './globalPins';
import type { NamedLayout } from './layouts';
import type { ShellProfile } from './profiles';
import type { ReposFile } from './repos';
import type { Session } from './sessions';
import type { Settings, SettingsPayload } from './settings';

export interface AppState {
  /** Read by onAttention, so peekOnWaiting hot-reloads. */
  settings: Settings;
  /** Kept current on hot reload so the settings dialog opens with fresh warnings. */
  payload: SettingsPayload;
  /** Re-read on settings hot reload, since shell.path and shell.args shape the Git Bash profile. */
  profiles: ShellProfile[];
  sessions: Session[];
  favorites: Favorite[];
  layouts: NamedLayout[];
  repos: ReposFile;
  globalPins: GlobalPinsFile;
  /** Set once hiding the dashboard with × has shown its notice; restored from the saved workspace. */
  hideNoticeShown: boolean;
  /** Set once the first-run tour finished or was skipped; restored from the saved workspace. */
  tourDone: boolean;
}
