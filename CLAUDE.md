# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Bashboard is a Windows terminal for Claude Code built on Tauri 2: Git Bash panes rendered by
xterm.js over a live colony-simulation backdrop. `docs/design.md` is the spec; code comments cite
its sections (e.g. "docs/design.md section 4.5"), and section 11 lists the milestones and what
is in or out of scope for each.

## Commands

```sh
pnpm tauri dev                              # run the app (Vite on port 1420 plus the Rust core)
pnpm dev                                    # front end only, in a plain browser (see below)
pnpm test                                   # Vitest, all src/**/*.test.ts
pnpm exec vitest run src/keys.test.ts       # one test file
pnpm exec vitest run -t 'cycleScrim'        # tests matching a name
pnpm exec tsc --noEmit                      # type check
pnpm build                                  # tsc + vite build
pnpm tauri build                            # release build and installer
```

Rust tests run from `src-tauri/` with `cargo test` (`cargo test settings` for one module). In
Git Bash, cargo may need `export PATH="$HOME/.cargo/bin:$PATH"` first. The Rust sources are not
`cargo fmt` clean, so don't run `cargo fmt` repo-wide; format only what you touch.

`BASHBOARD_KEYLOG=<file> pnpm tauri dev` logs every keystroke and paste sent to a shell, escaped,
to confirm a chord reaches bash rather than being eaten by WebView2 or xterm.js.

**Browser-only runs.** Under `pnpm dev` without Tauri, every `invoke` fails: settings fall back
to `DEFAULT_SETTINGS` in `src/settings.ts`, and the pane shows a "could not start the shell"
notice. That is expected; it is still useful for checking layout, scrims, and the backdrop.

## Architecture

**Rust core (`src-tauri/src`)** owns everything that touches the OS. `pty.rs` runs one ConPTY
per pane via `portable-pty` and streams output to the front end over a Tauri `Channel`;
`settings.rs` loads the JSONC settings file leniently (each invalid field falls back to its
default with a warning), layers user keybindings over the built-in defaults, and watches the
file, emitting `settings://changed` on save. `hooks.rs` is the loopback hook receiver and the
per-session status overlay that the roster merges; `hook_install.rs` installs the hook script
and registers it in `~/.claude/settings.json`. `lib.rs` registers commands and disables WebView2's
browser accelerator keys so Ctrl+F, Ctrl+R, and similar reach the shell.

**Front end (`src`)** is no-framework TypeScript, one class or module per file. Don't introduce
React. `main.ts` mounts the backdrop first (so it draws while settings load), kills ptys
orphaned by a page reload, then builds the `Workspace`.
- `Workspace` owns the split tree, the panes, focus, and the scrim state. `layout.ts` is the
  pure split-tree model (no DOM, fully unit-tested); `layoutView.ts` renders it as nested flex
  containers; `pane.ts` is one xterm.js terminal bound to one pty.
- Keys: `keys.ts` runs before xterm.js and swallows a handled key for keydown, keypress, *and*
  keyup, because xterm.js acts on the keypress that follows a keydown. `keymap.ts` parses
  chords and builds the keymap from the settings payload.
- `attention.ts` is the pure attention tracker; `paneAttention.ts` applies it to pane hosts and
  is owned by `Workspace`.
- `rendererBudget.ts` caps WebGL terminals at 8, since Chromium allows about 16 contexts per
  page and the backdrop holds one; extra panes fall back to the DOM renderer.
- `osc.ts` captures the working directory from OSC 9;9 and OSC 7, so new panes open in the
  focused pane's folder (requires the `~/.bashrc` lines in the README).

**Layers.** A fixed full-window `<canvas id="backdrop">` (z0, `pointer-events: none`) sits under
`#panes`. Terminals draw with a transparent background, and each `.pane::before` paints a scrim
driven by the `--scrim-opacity` and `--scrim-blur` custom properties on `:root`.

**Backdrop (`src/backdrop`).** `sim/` is the colony simulation and `render/` the Three.js renderer.
`sim/` must stay DOM-free. `src/backdrop/backdrop.ts` is the only entry point the rest of the
app uses (`mountBackdrop` returns a `BackdropHandle`); `render/skyDome.ts` is the sky-dome mesh
behind the colony. The loop pauses while the window
is hidden or minimized (`backdropVisibility.ts`), honors `backdrop.maxFps` through
`framePacer.ts`, and freezes on a still frame when `backdrop.animate` is false.

## Changes that span files

- **A settings field** lives in four places that must agree: the Rust struct, `Default`, and
  `try_parse_settings` in `settings.rs`; the `Settings` interface and `DEFAULT_SETTINGS` in
  `src/settings.ts`; the schema in `docs/design.md` section 8; and, if user-facing, the README's
  Settings section. Hot reload reaches the front end through `onSettingsChanged` in `main.ts`
  and `Workspace.applySettings`.
- **A keybinding action** needs its name in `keymap.ts` (the action type, the name list, and
  `DEFAULT_KEYBINDINGS`), the matching default in `default_keybindings()` in `settings.rs`, a
  case in `isHandled` in `keys.ts` (workspace actions go through `ctx.dispatch`), handling in
  `Workspace.dispatch`, a label and section in `src/helpModel.ts` (the F1 shortcut guide), and
  a row in the design doc's section 4.5 table.
