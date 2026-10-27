import type { CellSize } from './layout';
import type { PaneKind } from './paneKinds';
import type { Settings } from './settings';

/** What the workspace holds for every pane, whatever its kind (docs/design.md section 4.11). */
export interface PaneView {
  readonly kind: PaneKind;
  readonly paneId: string;
  /** A terminal's working directory; null for kinds with no folder. */
  readonly folder: string | null;
  focus(): void;
  setExpanded(expanded: boolean): void;
  cellSize(): CellSize;
  applySettings(settings: Settings): void;
  dispose(): void;
}
