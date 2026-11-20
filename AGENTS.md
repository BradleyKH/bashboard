# AGENTS.md

This file provides guidance to coding agents working in this repository.

Bashboard is a terminal for Claude Code and other coding agents, built on Tauri 2 for Windows,
with macOS and Linux builds: shell panes (Git Bash by default on Windows) rendered by xterm.js
over an animated backdrop, plus tabs, a dashboard, non-terminal pane kinds, and the `bb` pane
CLI. `docs/design/` is the spec, one file per feature area. Its section numbers are ids shared
across those files, and `docs/design/README.md` indexes each to its file.
Code comments and most module headers cite a section with its file (e.g.
"docs/design/keys.md section 4.5"), so a module's header is the fastest way to its spec. A new
section takes the next unused number in its layer (3.x for the Rust core, 4.x for the front
end), goes in the file for its feature, and gets a row in the index.

The other docs are user-facing, and a user-visible change updates the one that owns it:
`docs/user-guide.md` (features and their keys), `docs/settings.md` (every setting),
`docs/setup.md` (shell integration lines, coding agent hooks, code host sign-in), and
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
(`.github/workflows/ci.yml`) runs the type check, Vitest, `cargo test`, and an installer build
on Windows; the same checks plus a universal `.app` build on macOS; and the same checks plus the
`.deb`, `.rpm`, AppImage, and Arch package builds on Linux.

Debug builds keep settings and saved state in a `dev` subfolder of the app's config folder
(`%APPDATA%\dev.bashboard\dev` on Windows), not the installed app's folder; the first debug run
seeds `settings.json` from the installed app unless `BASHBOARD_NO_DEV_SEED=1` is set.
`BASHBOARD_KEYLOG=<file>` logs every keystroke and paste sent to a shell, to confirm a chord
reaches bash rather than being eaten by WebView2 or xterm.js.
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
rest: `pty.rs` runs one pty per pane via `portable-pty` (ConPTY on Windows) and streams output
to the front end over a Tauri `Channel`, keeping a tail of each (`pty_tail.rs`) so a page that
replaces a crashed or reloaded one reattaches to running shells (`crash_recovery.rs` rebuilds a
dead WebView); `settings/` loads the JSONC settings file leniently (`parse.rs`: each invalid
field falls back to its default with a warning), layers user keybindings over the built-in
defaults (`keybindings.rs`), and watches the file (`watch.rs`), emitting `settings://changed` on
save, while `settings_edit.rs` rewrites
one value in place for the Settings tab, keeping comments. `hooks.rs` is the loopback hook
receiver, also serving `POST /cli` for `bb` (`bin/bb.rs`, parsed in `cli.rs`); its per-session
status overlays the session list `roster.rs` builds. `workspace.rs` stores the front end's
JSON files verbatim without inspecting them. `forge/` is the Ship pane's backend (CI runs and
pull requests, one provider per code host), and `browser.rs` drives Local Browser frames over the
WebView2 DevTools Protocol. `platform.rs` holds the OS basics; modules that differ by OS have
`_linux` or `_mac` siblings (`toast_mac.rs`, `media_linux.rs`). `lib.rs` registers commands and
disables WebView2's browser accelerator keys so Ctrl+F, Ctrl+R, and similar reach the shell.

**Front end (`src`)** is no-framework TypeScript, one class or module per file, with pure
`*Model.ts` modules (no DOM, unit-tested) beside the DOM classes that use them. Don't introduce
React. `main.ts` mounts the backdrop first (so it draws while settings load), lists the ptys
that outlived the last page (the restore reattaches its own and kills the rest), then builds
the `Workspace`, the `DashboardPanel`, and the
`AppDialog` and `SetupWizard` (`appDialogs.ts`; the dialog's Help, Settings, Accounts, Shortcuts,
CLI, and About tabs are one `<name>Tab.ts` each). The shared startup state lives in
`appState.ts`, and `main.ts` wires it to controllers: `repoTracker.ts`, `launchController.ts`,
`favoritesLayouts.ts`, `hookOffer.ts`, and `paletteController.ts`. `appEvents.ts` subscribes to
the backend events and to settings changes.
- `Workspace` owns the tabs (each with its own split tree, focus, and collapsed panes), every
  pane of every kind, and the scrim state; whatever acts on "the" tree or focus acts on the
  active tab. `layout.ts` is the pure split-tree model; `layoutView.ts` renders it as nested
  flex containers. `workspace.ts` is the class and its public surface; the rest sits in helper
  modules it calls: `workspaceDispatch.ts` (the per-action switch), `workspacePersistence.ts`
  (snapshot, restore, layouts), `paneFactory.ts` (pane construction), `paneRouting.ts` (where
  Files, Git, and the other panes open), `paneDrag.ts` and `pathDrop.ts` (drag and drop),
  `tabView.ts` (layout rendering and zoom), and `workspaceSessions.ts` (the session list, no DOM).
- Pane kinds (`paneKinds.ts`) are terminal, scratch, files, git, ship, search, containers, ports,
  and browser (Local Browser, Windows only; `platform.ts` hides features an OS lacks). Each
  implements `PaneView`; `pane.ts` is the terminal (one xterm.js instance bound to one pty) and
  the others are `<kind>Pane.ts` (`localBrowserPane.ts` for browser). `savedWorkspace.ts` is the
  shape of the restored workspace.
- Keys: `keys.ts` runs before xterm.js and swallows a handled key for keydown, keypress, *and*
  keyup, because xterm.js acts on the keypress that follows a keydown. `keymap.ts` parses
  chords and builds the keymap from the settings payload.
- `attention.ts` is the pure attention tracker; `paneAttention.ts` applies it to pane hosts and
  is owned by `Workspace`.
- `rendererBudget.ts` caps WebGL terminals at 8, since Chromium allows about 16 contexts per
  page and the backdrop holds one; extra panes fall back to the DOM renderer.
- `osc.ts` captures the working directory from OSC 9;9 and OSC 7, so new panes open in the
  focused pane's folder (requires the `~/.bashrc` lines in `docs/setup.md`).
- `bb` commands arrive as `cli://command` and run through `cliDispatch.ts`, whose `CliTarget`
  `appEvents.ts` implements over `Workspace`.

**Layers.** A fixed full-window `<canvas id="backdrop">` (z0, `pointer-events: none`) sits under
`#panes`. Terminals draw with a transparent background. The scrim dims and blurs the whole
backdrop through a CSS filter on that canvas, driven by the `--backdrop-brightness` and
`--backdrop-blur` custom properties on `:root` (`src/scrim.ts`), so the gaps between panes match
what sits behind them.

**Backdrop (`src/backdrop`).** `backdropHost.ts` (`BackdropHost`) is the only entry point the
rest of the app uses; it owns the canvas and mounts the `backdrop.style` chosen, each style
returning a `BackdropHandle`. The Lights style is the colony: `backdrop.ts` (`mountBackdrop`),
with `sim/` the simulation (must stay DOM-free) and `render/` the Three.js renderer. The other
styles sit in `galaxy/`, `matrix/`, `wave/`, and `image/` (which also runs the slideshow), and a
backdrop feature must work across all of them. The animated styles pause while the window is
hidden or minimized (`src/windowVisibility.ts`), honor `backdrop.maxFps` through `framePacer.ts`,
and freeze on a still frame when `backdrop.animate` is false.

## Changes that span files

- **A settings field** lives in places that must agree: the Rust struct and `Default` in
  `src-tauri/src/settings/model.rs`, and `try_parse_settings` in `settings/parse.rs`; the `Settings` interface and `DEFAULT_SETTINGS` in
  `src/settings.ts`; the schema in `docs/design/data.md` section 8; and, if user-facing,
  `docs/settings.md` and a field in `src/settingsModel.ts` for the Settings tab. Hot reload
  reaches the front end through `listenSettingsChanges` in `src/appEvents.ts` and `Workspace.applySettings`.
- **A keybinding action** needs, in order:
  1. a row in `src/actionRegistry.ts`, in F1 guide order (name, argument kind, label, section,
     optional note); the action lists in `keymap.ts` and `helpModel.ts` and the per-argument rows
     in `keybindingEdit.ts` derive from it;
  2. the member in the `Action` union in `src/keymap.ts` (tsc fails if 1 and 2 disagree);
  3. if it has a default chord, an entry in `src/defaultKeybindings.json` and its macOS
     counterpart `src/defaultKeybindings.macos.json` (both shared with Rust), and the
     `default_keybindings_are_pinned` and `macos_default_keybindings_are_pinned` tests in
     `src-tauri/src/settings/keybindings.rs`;
  4. a case in `dispatchAction` in `src/workspaceDispatch.ts`;
  5. a row with its name in the section 4.5 table in `docs/design/keys.md` (checked by
     `src/actionRegistry.test.ts`) and its key in `docs/user-guide.md`;
  6. only if `keys.ts` must handle it itself instead of dispatching: add it to `SpecialAction`
     and give it a case.
- **A coding agent** needs a row in `src/agents.json` (names, launch and resume commands, hook
  shell, and the rest; `docs/design/sessions.md` section 3.24), the `AgentId` variant in
  `src-tauri/src/agents.rs` and the id in the `AgentId` union in `src/agentTable.ts` (tests fail
  if the enum, the union, and the JSON disagree), its status table in `hooks.rs`, its installer
  in `hook_install.rs`, and its transcript reader under `src-tauri/src/transcript/`.
