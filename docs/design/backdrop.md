# Backdrop

The backdrop has five styles, set by `backdrop.style` (section 8): `lights` (Swirling Lights, the
default), `matrix` (Matrix), `image` (Image), `slideshow` (Slideshow), and `none`. Swirling Lights
is the colony simulation drawn by Three.js, and the one that shows sessions as organisms (6.3).
Matrix is falling glyph rain drawn with Canvas 2D. Image and Slideshow draw local pictures with
Canvas 2D (6.5). None mounts nothing, so z0 is empty. Exactly one style is mounted at a time, and
changing the setting swaps it live.

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 6.1 Modules

The backdrop code lives in `src/backdrop/`.

- `src/backdrop/sim/` is the colony simulation, with its Vitest suite, and `src/backdrop/render/` is
  the Three.js renderer. Neither touches the DOM. `backdrop.ts` mounts the two as the Swirling
  Lights style.
- `src/backdrop/matrix/` is the Matrix style: `matrixModel.ts` is the pure, DOM-free rain model
  (unit tested), and `matrixBackdrop.ts` draws it on a canvas and runs its step clock.
- `src/backdrop/image/` is the Image and Slideshow styles: `imageFit.ts` (where a picture is drawn
  for each fit) and `slideshowOrder.ts` (which picture is next) are pure and unit tested, and
  `imageBackdrop.ts` loads, draws, crossfades, and times the pictures. The core's
  `backdrop_image.rs` reads and lists the files (6.5).
- `backdropHandle.ts` holds `StyleBackdrop`, the interface every style exposes. `backdropHost.ts`
  is the `BackdropHost`, which owns the canvas and the mounted style, and `colonyRelay.ts` is the
  `ColonyRelay` that carries sessions across style switches (6.2).
- The backdrop has no HUD, controls, or pointer handling; it never shows an interface or takes
  input.

## 6.2 Backdrop API

The rest of the app talks only to `BackdropHost` (`src/backdrop/backdropHost.ts`). It owns the
`#backdrop` canvas and the mounted style, and exposes `apply(settings.backdrop)`,
`setVisible(visible)`, `setAnimated(animated)`, the requested `style`, and a `colony` for
`ColonySync`. `apply` mounts the style when it differs from the one requested before, and otherwise
only pushes the new options to the mounted style; it rejects only when the latest requested style
fails to mount, which shows a "Could not start the background animation" toast.

- **A fresh canvas per style.** Switching styles disposes the mounted one and replaces the canvas
  element with a clone of the original, taken before any style touched it. A canvas that has held
  a WebGL context cannot give a 2D one, and Matrix sets a mirror transform (6.4) on its canvas,
  which Swirling Lights must not inherit.
- **Lazy loading.** Each style is loaded with a dynamic import when it is first mounted, so
  Three.js and the simulation are parsed only when Swirling Lights is shown; Matrix and None never
  load them. A mount that finishes after a later switch discards its result.
- **When it mounts.** Loading settings starts before the rest of startup, and the backdrop mounts
  as soon as they arrive, overlapping the font and stale-terminal work that follows. The saved
  style is therefore the first one shown, never a different one that is swapped out. If settings
  fail to load, the defaults apply, which is Swirling Lights.
- **The colony relay.** `ColonySync` reports session changes only as they happen, so a colony
  mounted after sessions exist would never hear of them. The `ColonyRelay` is the colony the
  app holds: it records each live session's hue and latest mood, forwards to the Swirling Lights
  colony while one is mounted, and replays every recorded session into a newly mounted colony.
  Switching away and back therefore returns each session's lineage, as a fresh founder (the
  organisms themselves are not preserved). While Matrix or None is mounted, the relay keeps
  recording and forwards nothing.

Every style implements this interface, and each adds its own options:

```ts
export interface StyleBackdrop {
  /** Pause rendering entirely, e.g. while the window is minimized. */
  setVisible(visible: boolean): void;
  /** False freezes the backdrop on a still frame (`backdrop.animate`). */
  setAnimated(animated: boolean): void;
  dispose(): void;
}

// Swirling Lights, src/backdrop/backdrop.ts
export interface BackdropHandle extends StyleBackdrop {
  colony: SessionColony;
  /** `backdrop.maxFps`; 0 is uncapped. */
  setMaxFps(maxFps: number): void;
  /** `backdrop.capacity`, `mutationRate`, `zoom`, and `waitingPulse`. */
  setOptions(options: BackdropOptions): void;
}

export interface SessionColony {
  /** Founds a lineage for a session, or returns the existing one. */
  ensure(sessionId: string, hue: number): void;
  setMood(sessionId: string, mood: 'busy' | 'idle' | 'waiting'): void;
  /** Lets the lineage die out naturally instead of vanishing. */
  release(sessionId: string): void;
}

export function mountBackdrop(canvas: HTMLCanvasElement): BackdropHandle;

// Matrix, src/backdrop/matrix/matrixBackdrop.ts
export interface MatrixBackdrop extends StyleBackdrop {
  /** `backdrop.matrix.color`, `zoom`, `speed`, and `density`. */
  setOptions(options: MatrixOptions): void;
}

export function mountMatrix(canvas: HTMLCanvasElement, options: MatrixOptions): MatrixBackdrop;

// Image and Slideshow, src/backdrop/image/imageBackdrop.ts
export interface ImageBackdrop extends StyleBackdrop {
  /** `backdrop.image`, plus which of the two styles is mounted. setAnimated does nothing. */
  setOptions(options: ImageOptions): void;
}

export function mountImage(canvas: HTMLCanvasElement, options: ImageOptions, onError: (message: string) => void): ImageBackdrop;
```

Swirling Lights' simulation runs at a fixed 12 generations per second, and the camera orbits
slowly, holding still while the OS asks for reduced motion. Its simulation and camera controls are
settings (section 8), all hot-reloaded: population capacity (300 to 5000, default 1000; "Density"
in the dialog) and mutation rate (0 to 4, default 0.2; "Color drift"). Two more: zoom
(0.5 to 3, default 2) divides the camera's home distance, so the colony fills more of the window,
and the camera glides to a changed value; `waitingPulse` (default off) turns on the waiting
pulse below.

The Settings tab groups the backdrop's settings, and the scrim, under "Background
Animation"; the UI calls the backdrop the background animation. It opens with a Background select
(None, Swirling Lights, Matrix, Image, Slideshow) and shows only the fields that apply to the
chosen style. The
scrim's controls are labeled "Brightness" (shown as 1 minus `scrim.opacity`, so the far left is
fully dimmed) and "Blur".

| Style | Always shown | Also shown while `backdrop.animate` is on |
| --- | --- | --- |
| None | Background | (nothing) |
| Swirling Lights | Background, Animate, Brightness, Blur, Zoom | Frame rate cap, Density, Color drift, Pulse waiting sessions |
| Matrix | Background, Animate, Brightness, Blur, Color, Zoom, Density | Speed |
| Image | Background, Image, Fit, Brightness, Blur | (the same) |
| Slideshow | Background, Folder, Fit, Change every, Crossfade, Shuffle, Include subfolders, Brightness, Blur | (the same) |

While `backdrop.animate` is off, the fields a still frame can't show are hidden. Zoom, Brightness,
and Blur still change the frozen view, and so do Matrix's Color and Density, which redraw the still
frame. Matrix has its own Zoom
(`backdrop.matrix.zoom`), separate from Swirling Lights' (`backdrop.zoom`).

## 6.3 Sessions as organisms

These apply to the Swirling Lights style; Matrix and None show no lineages.

The background colony keeps living as it does today. Each live session additionally owns a
lineage:

| Session state | In the simulation |
| --- | --- |
| Appears | A founder spore drifts in near the colony's center |
| `busy` | Lineage fertility raised; it blooms and spreads |
| `idle` | Fertility lowered; it thins toward a few drifting adults |
| `waiting` | Render-level brightness pulse on all its organisms while `backdrop.waitingPulse` is on (no sim change) |
| Ends | Lineage released; its organisms age out normally |

A terminal's `done` status (4.8) is not a session state; its lineage behaves as `idle`.

- **Hue** is a stable FNV-1a hash of the session name, or of its lowercased cwd when unnamed, so
  a session keeps its color across restarts. The lineage keeps its founder's hue, and children
  inherit it unmutated, so every organism in the lineage matches the session's swatch in the
  dashboard panel.
- **Persistence.** A session lineage is protected from blights and is re-founded if its last
  organism dies while the session lives.
- **Background floor.** Since session lineages keep the colony from ever emptying, the
  background (non-session) colony is tended on its own: when its living count falls below 15
  percent of capacity, a founder spore is planted near the colony's center every 120 generations
  until it recovers, and 6 generations after it dies out entirely.
- **Changes to the copied code:** per-lineage fertility multipliers, blight immunity, and the
  background floor in
  `src/backdrop/sim/simulation.ts`, a per-lineage pulse attribute in the organism shader, and the
  `SessionColony` bookkeeping. All of it stays render-free in `src/backdrop/sim` except the pulse.

## 6.4 Performance

**Swirling Lights**

- It renders at up to `backdrop.maxFps` (section 8), 20 by default, or at the display's full
  frame rate when it is 0.
  The frame loop still runs on `requestAnimationFrame` and skips any frame that arrives sooner
  than `1 / maxFps` after the last rendered one. The simulation advances by elapsed time, so a
  cap lowers smoothness, not speed. The setting hot-reloads.
- `maxFps` is 0 (uncapped) or 20 to 240. The loop clamps each frame's delta to 1/20 s, so a cap
  below 20 would slow the simulation itself.
- `backdrop.animate: false` stops the frame loop and leaves the backdrop on a still frame, redrawn only
  when the window resizes. Either way, the backdrop pre-warms at mount, simulating up to 16
  seconds headless before its first frame, so it opens at the configured zoom on a grown colony,
  not the lone founding spore. The pre-warm stops after 500 ms of wall-clock time, so a large
  `capacity` opens on a younger colony rather than delaying the first paint. It hot-reloads; turning it back on
  resumes from the still.
- The renderer is created with `preserveDrawingBuffer: false` and alpha disabled; the
  terminals composite over it through normal CSS stacking, with no readback. Disposing it forces
  its WebGL context to be lost, since Chromium caps live contexts and would otherwise keep the
  context until garbage collection.

**Matrix**

- It is a Canvas 2D renderer, `src/backdrop/matrix/matrixBackdrop.ts`, over the pure model in
  `matrixModel.ts`. The model is a grid of cells sized from the canvas and the cell size, with
  one falling drop per column. Each step moves every drop down one row and returns the glyphs to
  draw: the drop's new head cell, and the previous head cell again as ordinary trail so the bright
  head does not leave a white streak. A column whose drop has fallen off the bottom sits idle,
  and each step an idle column starts a new drop at the top with a fixed chance (3 percent times
  `backdrop.matrix.density`, 0.25 to 4, default 3). Columns start independently, which keeps them
  out of lockstep, and the window opens with every column idle, so the rain arrives rather than
  appearing all at once.
- Glyphs are half-width katakana, the digits, and a few symbols, drawn in the `MS Gothic` or
  `Yu Gothic` font that ships with Windows 10 and 11, with `monospace` as the fallback. No font is
  bundled. Drawing waits for the font to load, so the first frames do not cache fallback glyphs.
- The film's glyphs are mirrored. The renderer sets `transform: scaleX(-1)` on its canvas, which
  the compositor applies for free; drops are column-symmetric, so only the glyph shapes change.
- A cell is 20 px times `backdrop.matrix.zoom`, and the canvas is drawn at the device pixel ratio
  and rebuilt when the window resizes.
- The step rate is `backdrop.matrix.speed` (5 to 30, default 10 steps per second); `maxFps` does
  not apply. Steps are scheduled by elapsed time on `requestAnimationFrame`, at most four per
  frame, so a stall never bursts. The setting hot-reloads.
- Each step paints black over the whole canvas at 8 percent alpha, which fades trails. Alpha
  blending alone stalls once 8-bit rounding stops lowering a channel, leaving a faint permanent
  residue, so every fourth step also applies a color-burn fill with a near-white source that
  subtracts a few levels and clamps at zero. Trails therefore fade to true black. Heads are drawn
  in the chosen color mixed 90 percent toward white.
- `backdrop.animate: false`, or the OS asking for reduced motion, stops the loop on a still frame.
  The frame is built by stepping the rain on a cleared canvas for a screen's worth of rows plus
  two mean idle gaps (at most 400 steps), so the frozen view looks like a running one rather than
  an empty screen. A change to the zoom or the window size rebuilds it, and so does a change of
  color or density.

**All styles**

- `setVisible(false)` on minimize, and when the window is fully covered (Tauri window events
  plus the page's `visibilitychange`), so it costs nothing while out of sight. The dashboard
  clock, Wave, and System section (4.6) pause on the same signal, and Matrix stops its loop on it too.
- Ctrl+Shift+A pauses or resumes the mounted style and saves `backdrop.animate`; under None it
  does nothing and saves nothing.
- None mounts nothing: no renderer, no frame loop, and no Three.js load.

## 6.5 Image and Slideshow

Image draws one picture (`backdrop.image.file`); Slideshow draws the pictures in a folder
(`backdrop.image.folder`) in turn. Both draw into the `#backdrop` canvas with Canvas 2D, so the
scrim's brightness and blur reach them through the canvas's CSS filter like every other style.
Neither animates, so they ignore `backdrop.animate`, the Settings tab hides Animate for them, and
Ctrl+Shift+A does nothing while either is shown.

- **Loading through the core.** The CSP allows images only from the app (`img-src 'self'`), so the
  webview never loads a path. `backdrop_image_read` returns the file's bytes as a raw IPC response
  and the front end decodes them with `createImageBitmap`, which the CSP does not govern.
  `backdrop_image_list` lists a folder, optionally with its subfolders, sorted case-insensitively.
  Both expand `%VARS%`, serve only image extensions (png, jpg, jpeg, webp, avif, bmp, gif), and
  refuse files over 100 MB; a listing stops at 20,000 files and 16 folders deep, and never follows
  a linked folder. `backdrop_image_pick` opens the native file or folder picker for the Settings
  tab's Browse buttons.
- **Fit.** `fill`, `fit`, `stretch`, `center`, and `tile` match the Windows wallpaper modes (Span
  has no meaning inside one window). Center and tile draw at one picture pixel per device pixel.
  The canvas is cleared to the body's background color first, so bars and uncovered space match
  the gaps between panes.
- **Decoding size.** A picture larger than the screen is shrunk once, at decode, to just cover the
  screen (fill, fit, and stretch never need more), so an 8K photo does not stay in memory at full
  size. Center and tile keep every pixel. Changing the fit decodes the current picture again.
- **Slideshow timing.** Each change lists the folder again, so added and removed pictures are
  picked up without a watcher. In order, the next picture is the first whose path sorts after the
  current one, wrapping; shuffled, it is a random picture not yet shown this round, never the
  current one twice in a row. The incoming picture crossfades in over `crossfadeSeconds` (0 to 10,
  default 5), eased in and out; 0, or reduced motion, swaps it instantly. The timer stops while the window is hidden and resumes with the time it had
  left. A picture that fails to load is reported and skipped, up to 10 in a row; an error repeated
  at the next interval is not reported twice.
- **Errors.** An empty path is the unset state and draws only the background color. Anything that
  cannot be shown raises a "Could not show the background image" toast through the `onError`
  callback the `BackdropHost` passes in, since a picture can fail long after the style mounted.
