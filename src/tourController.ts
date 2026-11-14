// The first-run tour (docs/design/app.md section 4.29): steps through TOUR_STEPS as the user does
// each one, then offers to close the panes it had them open.
import type { AppState } from './appState';
import { tourParagraph } from './helpTour';
import { TourCard } from './tourCard';
import { advance, panesToClose, TOUR_STEPS, type TourSignal } from './tourModel';
import type { Workspace } from './workspace';

export interface TourControllerDeps {
  state: AppState;
  workspace: () => Workspace;
  /** Saves `state.tourDone` with the rest of the workspace. */
  save: () => void;
}

/** How long a finished step shows its check mark before the next one. */
const DONE_MS = 700;

export class TourController {
  private readonly card: TourCard;
  /** Null while no tour runs. */
  private index: number | null = null;
  private known = new Set<string>();
  private readonly created = new Set<string>();
  private doneTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: TourControllerDeps) {
    this.card = new TourCard({
      onNext: () => this.goTo((this.index ?? 0) + 1),
      onSkip: () => this.end(),
      onFinish: (closePanes) => this.finish(closePanes),
    });
    deps.workspace().onChange(() => this.panesChanged());
  }

  /** After the first run's setup closes: starts once, unless a past tour finished or was skipped. */
  offer(): void {
    if (!this.deps.state.tourDone) this.start();
  }

  start(): void {
    this.known = new Set(this.paneIds());
    this.created.clear();
    this.goTo(0);
  }

  signal(signal: TourSignal): void {
    if (this.index === null || this.doneTimer !== null) return;
    const next = advance(this.index, signal);
    if (next === this.index) return;
    this.render(true);
    this.doneTimer = setTimeout(() => {
      this.doneTimer = null;
      this.goTo(next);
    }, DONE_MS);
  }

  private goTo(index: number): void {
    this.clearTimer();
    this.index = index;
    if (index >= TOUR_STEPS.length) this.card.showFinish(this.closable().length);
    else this.render(false);
  }

  private render(done: boolean): void {
    const step = TOUR_STEPS[this.index ?? 0];
    this.card.showStep({
      index: this.index ?? 0,
      count: TOUR_STEPS.length,
      title: step.title,
      parts: tourParagraph(step.text, this.deps.state.settings.keybindings),
      done,
    });
  }

  private panesChanged(): void {
    if (this.index === null) return;
    for (const p of this.deps.workspace().panes()) {
      if (this.known.has(p.paneId)) continue;
      this.known.add(p.paneId);
      this.created.add(p.paneId);
      this.signal({ type: 'paneOpened', kind: p.kind });
    }
    // The finish card's count follows panes closed while it shows.
    if (this.index >= TOUR_STEPS.length) this.card.showFinish(this.closable().length);
  }

  private paneIds(): string[] {
    return this.deps.workspace().panes().map((p) => p.paneId);
  }

  private closable(): string[] {
    return panesToClose(this.paneIds(), this.created);
  }

  private finish(closePanes: boolean): void {
    const ids = closePanes ? this.closable() : [];
    this.end();
    for (const id of ids) void this.deps.workspace().requestClosePane(id);
  }

  private end(): void {
    this.clearTimer();
    this.index = null;
    this.card.hide();
    if (!this.deps.state.tourDone) {
      this.deps.state.tourDone = true;
      this.deps.save();
    }
  }

  private clearTimer(): void {
    if (this.doneTimer !== null) clearTimeout(this.doneTimer);
    this.doneTimer = null;
  }
}
