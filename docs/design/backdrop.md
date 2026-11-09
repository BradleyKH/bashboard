# Backdrop

The backdrop has seven styles, set by `backdrop.style` (section 8): `lights` (Swirling Lights, the
default), `galaxy` (Galaxy), `matrix` (Matrix), `wave` (Wave), `image` (Image),
`slideshow` (Slideshow), and `none`. Swirling Lights is the colony simulation drawn by Three.js. Galaxy is a fixed swirling
starfield on the same Three.js viewport and settings (6.6).
Matrix is falling glyph rain drawn with Canvas 2D. Wave is the dashboard's Wave drawn across
the window with Canvas 2D (6.7). Image and Slideshow draw local pictures with
Canvas 2D (6.5). None mounts nothing, so z0 is empty. Exactly one style is mounted at a time, and
changing the setting swaps it live.

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 6.1 Modules

The backdrop code lives in `src/backdrop/`.

- `src/backdrop/sim/` is the colony simulation, with its Vitest suite, and `src/backdrop/render/` is
  the Three.js renderer. Neither touches the DOM. `backdrop.ts` mounts the two as the Swirling
  Lights style.
- `src/backdrop/galaxy/` is the Galaxy style (6.6): pure modules for the disc's shape, the
  starfield, the color drift, and the baked textures (each unit tested), the
  Three.js layers that draw them, and `galaxyBackdrop.ts`, which mounts them.
- `src/backdrop/matrix/` is the Matrix style: `matrixModel.ts` is the pure, DOM-free rain model
  (unit tested), and `matrixBackdrop.ts` draws it on a canvas and runs its step clock.
- `src/backdrop/wave/` is the Wave style (6.7): `waveColor.ts` resolves the color
  mode (unit tested), and `waveBackdrop.ts` samples the system and draws the figure. The
  figure itself comes from the Wave's `src/waveModel.ts` and `src/waveDraw.ts`, shared with the
  dashboard.
- `src/backdrop/image/` is the Image and Slideshow styles: `imageFit.ts` (where a picture is drawn
  for each fit) and `slideshowOrder.ts` (which picture is next) are pure and unit tested, and
  `imageBackdrop.ts` loads, draws, crossfades, and times the pictures. The core's
  `backdrop_image.rs` reads and lists the files (6.5).
- `backdropHandle.ts` holds `StyleBackdrop`, the interface every style exposes. `backdropHost.ts`
  is the `BackdropHost`, which owns the canvas and the mounted style (6.2).
- The backdrop has no HUD, controls, or pointer handling; it never shows an interface or takes
  input.

## 6.2 Backdrop API

The rest of the app talks only to `BackdropHost` (`src/backdrop/backdropHost.ts`). It owns the
`#backdrop` canvas and the mounted style, and exposes `apply(settings.backdrop)`,
`setVisible(visible)`, `setAnimated(animated)`, and the requested `style`. `apply` mounts the style when it differs from the one requested before, and otherwise
only pushes the new options to the mounted style; it rejects only when the latest requested style
fails to mount, which shows a "Could not start the background animation" toast.

- **A fresh canvas per style.** Switching styles disposes the mounted one and replaces the canvas
  element with a clone of the original, taken before any style touched it. A canvas that has held
  a WebGL context cannot give a 2D one, and Matrix sets a mirror transform (6.4) on its canvas,
  which Swirling Lights must not inherit.
- **Lazy loading.** Each style is loaded with a dynamic import when it is first mounted, so
  Three.js is parsed only when Swirling Lights or Galaxy is shown, and the simulation only for
  Swirling Lights; Matrix, Wave, and None never
  load them. A mount that finishes after a later switch discards its result.
- **When it mounts.** Loading settings starts before the rest of startup, and the backdrop mounts
  as soon as they arrive, overlapping the font and stale-terminal work that follows. The saved
  style is therefore the first one shown, never a different one that is swapped out. If settings
  fail to load, the defaults apply, which is Swirling Lights.

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
  /** `backdrop.maxFps`; 0 is uncapped. */
  setMaxFps(maxFps: number): void;
  /** `backdrop.capacity`, `mutationRate`, and `zoom`. */
  setOptions(options: BackdropOptions): void;
}

export function mountBackdrop(canvas: HTMLCanvasElement): BackdropHandle;

// Galaxy, src/backdrop/galaxy/galaxyBackdrop.ts; the same handle (6.6)
export function mountGalaxy(canvas: HTMLCanvasElement): BackdropHandle;

// Matrix, src/backdrop/matrix/matrixBackdrop.ts
export interface MatrixBackdrop extends StyleBackdrop {
  /** `backdrop.matrix.color`, `zoom`, `speed`, and `density`. */
  setOptions(options: MatrixOptions): void;
}

export function mountMatrix(canvas: HTMLCanvasElement, options: MatrixOptions): MatrixBackdrop;

// Wave, src/backdrop/wave/waveBackdrop.ts
export interface WaveBackdrop extends StyleBackdrop {
  /** `backdrop.wave` with its color resolved, plus `backdrop.maxFps`. */
  setOptions(options: WaveOptions): void;
}

export function mountWave(canvas: HTMLCanvasElement, options: WaveOptions): WaveBackdrop;

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
in the dialog) and mutation rate (0 to 4, default 0.2; "Color drift"). Zoom (0.5 to 3, default
2) divides the camera's home distance, so the colony fills more of the window, and the camera
glides to a changed value.

The Settings tab groups the backdrop's settings, and the scrim, under "Background
Animation"; the UI calls the backdrop the background animation. It opens with a Background select
(None, Swirling Lights, Galaxy, Matrix, Wave, Image, Slideshow) and shows only the fields that apply to the
chosen style. The
scrim's controls are labeled "Brightness" (shown as 1 minus `scrim.opacity`, so the far left is
fully dimmed) and "Blur".

| Style | Always shown | Also shown while `backdrop.animate` is on |
| --- | --- | --- |
| None | Background | (nothing) |
| Swirling Lights | Background, Animate, Brightness, Blur, Zoom | Frame rate cap, Density, Color drift |
| Galaxy | Background, Animate, Brightness, Blur, Zoom | Frame rate cap, Density, Color drift |
| Matrix | Background, Animate, Brightness, Blur, Color, Zoom, Density | Speed |
| Wave | Background, Animate, Brightness, Blur, Color, Size, Line width, Echoes | Frame rate cap, Speed |
| Image | Background, Image, Fit, Brightness, Blur | (the same) |
| Slideshow | Background, Folder, Fit, Change every, Crossfade, Shuffle, Include subfolders, Brightness, Blur | (the same) |

While `backdrop.animate` is off, the fields a still frame can't show are hidden. Zoom, Brightness,
and Blur still change the frozen view, and so do Matrix's Color and Density, which redraw the still
frame, and Wave's Color, Size, Line width, and Echoes. Matrix has its own Zoom
(`backdrop.matrix.zoom`), separate from the `backdrop.zoom` that Swirling Lights and Galaxy share.

## 6.3 Colony upkeep

Swirling Lights' colony tends itself so the window never sits empty for long
(`src/backdrop/sim/simulation.ts`):

- **Sparse floor.** While the living count is below 15 percent of capacity, a founder spore is
  planted near the colony's center every 120 generations until it recovers, so a thinned colony
  regrows rather than waiting out a full extinction.
- **Extinction.** 6 generations after the colony dies out entirely, a new epoch begins from a
  single founding spore at the center.

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

**Galaxy**

- It shares Swirling Lights' viewport, bloom, frame pacing, `maxFps`, and handling of
  `backdrop.animate`, and opens straight at its configured zoom. It has no pre-warm, since
  nothing in it grows.
- The CPU does almost nothing per frame: the stars' positions are static attributes, and the
  vertex shader applies the turn and the color drift from a handful of uniforms. The
  gas plate and the sky are textures baked once at mount, so their per-pixel noise is never run on
  the GPU.

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
  clock, Wave, and System section (4.6) pause on the same signal, and Matrix and Wave stop
  their loops on it too (Wave its sampling as well).
- Ctrl+Shift+A pauses or resumes the mounted style and saves `backdrop.animate`; under None it
  does nothing and saves nothing.
- None mounts nothing: no renderer, no frame loop, and no Three.js load.

## 6.5 Image and Slideshow

Image draws one picture (`backdrop.image.file`); Slideshow draws the pictures in a folder
(`backdrop.image.folder`) in turn. Both draw into the `#backdrop` canvas with Canvas 2D, so the
scrim's brightness and blur reach them through the canvas's CSS filter like every other style.
Neither animates, so they ignore `backdrop.animate`, the Settings tab hides Animate for them, and
Ctrl+Shift+A does nothing while either is shown.

- **Loading through the core.** The CSP allows images only from the app, `blob:` URLs, and
  inline `data:` URLs (`img-src 'self' blob: data:`), so the webview never loads a path. `backdrop_image_read` returns the file's bytes as a raw IPC response
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

## 6.6 Galaxy

Galaxy draws a swirling galaxy behind the panes with Three.js, on Swirling Lights' viewport and
settings. Unlike Swirling Lights it runs no simulation: the stars are a fixed field that turns as
one, so nothing is born or dies and the population never changes.

- **The disc.** Stars fill the whole disc around a small, pale bulge (`galaxyShape.ts`),
  crowding into short streaks that wind with the spiral, so the disc reads as one swirl. Three
  broad arms are only suggested: a loose scatter of stars about each spine, and a slightly fuller
  swirl near them. The streaks are nine thin spiral strands whose phase is wiggled by noise, which
  breaks them into fragments; built on a sine rather than a noise threshold, every ring of the
  disc averages the same density.
- **Even light.** The backdrop sits behind text, so the disc's light is even from the core to
  the rim rather than peaking at the center: stars are placed uniformly by area, the bulge is a
  small share of them and only a little brighter than the disc, the gas has a faint haze under
  the whole disc instead of a core glow, and only the outer quarter of the radius fades. A panel
  over the core therefore reads like one over the rim at the same Brightness, and since the light
  per unit of screen does not depend on distance, Zoom changes how close the swirl looks rather
  than how bright it is. The whole disc
  turns rigidly, about one turn every nine minutes, with the swirl trailing; turning by radius
  would wind it tighter over a long session. The bulge adds a slow swirl of its own on top. A
  camera 45 degrees off overhead looks at the center, swaying a few degrees over five minutes, and
  holds still while the OS asks for reduced motion.
- **Stars.** `capacity` sets the count, 8 stars per unit, at most 40,000 (`galaxyStars.ts`). Each
  star is seeded from its own index, so a new Density adds or removes stars without moving the
  rest. Colors come from Swirling Lights' palette: most disc stars take the founders' blue-green
  hues with the larva and adult tints, a few bright giants carry the bloom pink, the bulge is the
  pale spore tint, and an older, dimmer share of the disc the elder violet. Each star's
  brightness falls about as fast as the count rises (`starGain`), so Density changes how fine the
  field is, not how bright: the summed light stays near steady, leaning slightly toward denser
  fields since the bloom favors a few bright stars over many dim ones. Stars smaller than a pixel are
  held at 1.5 px and dimmed by the area they lost, so they do not shimmer.
- **Gas, dust, and sky.** At mount, the gas plate (glowing gas following the swirl and, more
  faintly, the arms, over a haze that reaches a little past the rim; thin dust lanes along the
  swirl; and pink star-forming clumps in the densest streaks) is baked into a 512 by 512 texture, and the far sky
  (a faint band of distant light with violet wisps) into a 512 by 256 equirectangular one
  (`galaxyBake.ts`). Stars in a dust lane are dimmed by the same dust field. 2,500 faint distant
  stars sit on the sky, which follows the camera so it stays at infinity.
- **Color drift.** `mutationRate` wanders the hues of the stars and the gas across the disc
  through a slowly moving field (`galaxyDrift.ts`). Its reach grows with the square root of the
  rate, to half the wheel either way at 4, and so does its speed; 0 holds the colors still. A
  change eases in rather than snapping.

## 6.7 Wave

Wave draws the dashboard's Wave (4.6) across the whole window: the same Lissajous figure
turning in 3D, on the same ladder of figures, driven the same way by CPU (the weave), memory (the
detune sweep's pace), and network traffic (the spin). `waveModel.ts` holds the figure and its
motion (`stepWave`) and `waveDraw.ts` strokes it, so the two cannot drift apart; only the look and
the sizing differ.

- **Sampling.** It samples `system_sample` every 2 s while it is shown and `backdrop.animate` is
  on, easing toward each reading over about 1 s, and stops while the window is hidden. Frozen, it
  samples once so the still figure shows the current load; with reduced motion requested it keeps
  sampling and holds a still figure redrawn on each reading, as the dashboard Wave does. Without
  the core (a browser-only run) it idles at rest as a figure eight.
- **Drawing.** A Canvas 2D canvas at the device pixel ratio, sized to the window and redrawn
  on resize, with a transparent background so the body's color shows behind the line. Each line
  has 1200 points, enough to stay smooth at full-window size. The main line is stroked a segment
  at a time, brighter and thicker on its near side, from `lineWidth` down to about a third of it,
  with butt caps so the translucent segments do not overlap into beads at each joint. Echoes are
  copies further back in the spin by 0.12 radians each, at half the line width, the nearest at 22
  percent opacity and each one behind it fainter by an equal step.
- **Fit.** The figure fills `size` of the window's half-width and half-height, so it stretches to
  the window's shape as the dashboard Wave does to its strip. `size` runs 0.3 to 2, and above 1
  the figure spills past the edges and is cropped. The fit follows the Wave's rule before `size`
  scales it: it shrinks at once when a line would cross the box's edge and regrows over a few
  seconds. A new `size` or `lineWidth` refits at once.
- **Color.** `accent` strokes the accent at full brightness with its saturation raised, as the
  Matrix's accent mode does (`accentRain`); `white` strokes `#e6e6e6`; `spectrum` runs the hue
  once around the wheel along the line and turns the wheel a full turn every 30 s at speed 1.
  Echoes in the spectrum are stroked in 24-point pieces, each in its own hue.
- **Pace.** `speed` scales the spin, the tilt, the detune sweep, and the spectrum's turn
  together, but not the easing, so a slow figure still follows load promptly. The default of 0.5
  halves the Wave's pace, since the same angular speed covers far more of the screen at full size.
- **Frame rate.** It renders at up to `backdrop.maxFps` through the shared `FramePacer`, and each
  frame's step is clamped to 250 ms so a throttled window does not jump the figure.
