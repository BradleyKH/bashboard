# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Bashboard is a Windows terminal for Claude Code built on Tauri 2: Git Bash panes rendered by
xterm.js over a live colony-simulation backdrop, plus tabs, a dashboard, non-terminal pane kinds,
and the `bb` pane CLI. `docs/design.md` is the spec; code comments and most module headers cite
its sections (e.g. "docs/design.md section 4.5"), so a module's header is the fastest way to its
spec.

The other docs are user-facing, and a user-visible change updates the one that owns it:
`docs/user-guide.md` (features and their keys), `docs/settings.md` (every setting),
`docs/setup.md` (the `~/.bashrc` and PowerShell lines, Claude Code hooks), and
`docs/development.md` (machine setup, releasing, and the pre-release keyboard checklist, which
gains a line when a new chord could collide with WebView2 or xterm.js). The README is install
instructions, a doc index, and a short feature summary above them.

## Commands

```sh
pnpm tauri dev                              # run the app (Vite on port 1420 plus the Rust core)
pnpm tauri:debug                            # the same, with WebView2 remote debugging on port 9222
pnpm dev                                    # front end only, in a plain browser (see below)
pnpm test                                   # Vitest, all src/**/*.test.ts
pnpm exec vitest run src/keys.test.ts       # one test file
pnpm exec vitest run -t 'cycleScrim'        # tests matching a name
pnpm exec tsc --noEmit                      # type check
pnpm build                                  # tsc + vite build
pnpm build:bb                               # rebuild bb.exe after editing src-tauri/src/bin/bb.rs
pnpm tauri build                            # release build and installer
pnpm version:set <version>                  # set the app version in package.json, Cargo.toml, Cargo.lock
```

Rust tests run from `src-tauri/` with `cargo test` (`cargo test settings` for one module). In
Git Bash, cargo may need `export PATH="$HOME/.cargo/bin:$PATH"` first. The Rust sources are not
`cargo fmt` clean, so don't run `cargo fmt` repo-wide; format only what you touch. CI
(`.github/workflows/ci.yml`) runs the type check, Vitest, `cargo test`, and an installer build.

Debug builds keep settings and saved state in `%APPDATA%\dev.bashboard\dev`, not the installed
app's folder; the first debug run seeds `settings.json` from the installed app unless
`BASHBOARD_NO_DEV_SEED=1` is set. `BASHBOARD_KEYLOG=<file>` logs every keystroke and paste sent
to a shell, to confirm a chord reaches bash rather than being eaten by WebView2 or xterm.js.
`pnpm tauri:debug` opens WebView2's DevTools port, so a CDP client can drive the real window
beside the installed app (see "Development" in `docs/development.md`).

Releases follow "Releasing" in `docs/development.md`. The step that is easy to get wrong: release
notes come from an annotated tag made with `git tag -a v<version> --cleanup=whitespace -F notes.md`,
since the default cleanup strips markdown `#` headings as comments.

**Browser-only runs.** Under `pnpm dev` without Tauri, every `invoke` fails: settings fall back
to `DEFAULT_SETTINGS` in `src/settings.ts`, and the pane shows a "could not start the shell"
notice. That is expected; it is still useful for checking layout, scrims, and the backdrop.

## Architecture

**Rust core (`src-tauri/src`)** owns everything that touches the OS, one module per concern
(git, files, search, containers, system load, transcripts, and so on). The ones that shape the
rest: `pty.rs` runs one ConPTY per pane via `portable-pty` and streams output to the front end
over a Tauri `Channel`; `settings.rs` loads the JSONC settings file leniently (each invalid field
falls back to its default with a warning), layers user keybindings over the built-in defaults,
and watches the file, emitting `settings://changed` on save, while `settings_edit.rs` rewrites
one value in place for the Settings tab, keeping comments. `hooks.rs` is the loopback hook
receiver, also serving `POST /cli` for `bb` (`bin/bb.rs`, parsed in `cli.rs`); its per-session
status overlays the session list `roster.rs` builds. `workspace.rs` stores the front end's
JSON files verbatim without inspecting them. `lib.rs` registers commands and disables WebView2's
browser accelerator keys so Ctrl+F, Ctrl+R, and similar reach the shell.

**Front end (`src`)** is no-framework TypeScript, one class or module per file, with pure
`*Model.ts` modules (no DOM, unit-tested) beside the DOM classes that use them. Don't introduce
React. `main.ts` mounts the backdrop first (so it draws while settings load), kills ptys
orphaned by a page reload, then builds the `Workspace`, the `DashboardPanel`, the
`SetupWizard`, and the `AppDialog` (Help, Settings, Shortcuts, CLI, and About tabs, one
`<name>Tab.ts` each).
- `Workspace` owns the tabs (each with its own split tree, focus, and collapsed panes), every
  pane of every kind, and the scrim state; whatever acts on "the" tree or focus acts on the
  active tab. `layout.ts` is the pure split-tree model; `layoutView.ts` renders it as nested
  flex containers.
- Pane kinds (`paneKinds.ts`) are terminal, scratch, files, git, search, containers, and ports. Each
  implements `PaneView`; `pane.ts` is the terminal (one xterm.js instance bound to one pty) and
  the others are `<kind>Pane.ts`. `savedWorkspace.ts` is the shape of the restored workspace.
- Keys: `keys.ts` runs before xterm.js and swallows a handled key for keydown, keypress, *and*
  keyup, because xterm.js acts on the keypress that follows a keydown. `keymap.ts` parses
  chords and builds the keymap from the settings payload.
- `attention.ts` is the pure attention tracker; `paneAttention.ts` applies it to pane hosts and
  is owned by `Workspace`.
- `rendererBudget.ts` caps WebGL terminals at 8, since Chromium allows about 16 contexts per
  page and the backdrop holds one; extra panes fall back to the DOM renderer.
- `osc.ts` captures the working directory from OSC 9;9 and OSC 7, so new panes open in the
  focused pane's folder (requires the `~/.bashrc` lines in `docs/setup.md`).
- `bb` commands arrive as `cli://command` and run through `cliDispatch.ts`, which `main.ts`
  implements over `Workspace`.

**Layers.** A fixed full-window `<canvas id="backdrop">` (z0, `pointer-events: none`) sits under
`#panes`. Terminals draw with a transparent background. The scrim dims and blurs the whole
backdrop through a CSS filter on that canvas, driven by the `--backdrop-brightness` and
`--backdrop-blur` custom properties on `:root` (`src/scrim.ts`), so the gaps between panes match
what sits behind them.

**Backdrop (`src/backdrop`).** `sim/` is the colony simulation and `render/` the Three.js renderer.
`sim/` must stay DOM-free. `src/backdrop/backdrop.ts` is the only entry point the rest of the
app uses (`mountBackdrop` returns a `BackdropHandle`); `render/skyDome.ts` is the sky-dome mesh
behind the colony. The loop pauses while the window is hidden or minimized
(`src/windowVisibility.ts`), honors `backdrop.maxFps` through `framePacer.ts`, and freezes on a
still frame when `backdrop.animate` is false.

## Changes that span files

- **A settings field** lives in places that must agree: the Rust struct, `Default`, and
  `try_parse_settings` in `settings.rs`; the `Settings` interface and `DEFAULT_SETTINGS` in
  `src/settings.ts`; the schema in `docs/design.md` section 8; and, if user-facing,
  `docs/settings.md` and a field in `src/settingsModel.ts` for the Settings tab. Hot reload
  reaches the front end through `onSettingsChanged` in `main.ts` and `Workspace.applySettings`.
- **A keybinding action** needs its name in `keymap.ts` (the action type, the name list, and
  `DEFAULT_KEYBINDINGS`), the matching default in `default_keybindings()` in `settings.rs`, a
  case in `isHandled` in `keys.ts` (workspace actions go through `ctx.dispatch`), handling in
  `Workspace.dispatch`, a label and section in `src/helpModel.ts` (the Shortcuts tab's
  rows, which `keybindingEdit.ts` turns into the editor's rows and `paletteModel.ts` into the
  command palette's), a row in the design doc's section 4.5 table, and its key in
  `docs/user-guide.md`. An action that takes an argument also needs its per-argument rows
  (labels and argument values) in `keybindingEdit.ts`.
