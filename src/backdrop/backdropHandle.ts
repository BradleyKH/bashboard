/** What every backdrop style (lights, matrix) exposes to the app (docs/design.md section 6.2). */
export interface StyleBackdrop {
  /** Pause rendering entirely, e.g. while the window is minimized. */
  setVisible(visible: boolean): void;
  /** False freezes the backdrop on a still frame; true resumes it. */
  setAnimated(animated: boolean): void;
  dispose(): void;
}
