# Bashboard: design spec

A desktop terminal dashboard for Windows, with macOS and Linux previews, built with Tauri, that
opens, collapses, and arranges terminals (Git Bash by default on Windows) over a live backdrop, launches them from favorite folders, and shows
every local coding agent session (Claude Code, and as a preview Codex and Copilot) at a glance. The repo and binary are `bashboard`; the window
title is "Bashboard".

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; the index below maps each to its file.

## Index

| Section | File |
| --- | --- |
| 1 Goals | [README.md](README.md) |
| 2 Architecture | [README.md](README.md) |
| 3.1 PtyManager (`src-tauri/src/pty.rs`) | [terminal.md](terminal.md) |
| 3.2 SessionRoster (`src-tauri/src/roster.rs`) | [sessions.md](sessions.md) |
| 3.3 HookReceiver (`src-tauri/src/hooks.rs`) | [sessions.md](sessions.md) |
| 3.4 Pane to session binding | [sessions.md](sessions.md) |
| 3.5 Platform glue | [terminal.md](terminal.md) |
| 3.6 Settings (`src-tauri/src/settings/`) | [data.md](data.md) |
| 3.7 Workspace and favorites (`src-tauri/src/workspace.rs`) | [data.md](data.md) |
| 3.8 Repo files (`src-tauri/src/files.rs`) | [files.md](files.md) |
| 3.9 Git (`src-tauri/src/git.rs`, `src-tauri/src/git_fetch.rs`, `src-tauri/src/git_worktrees.rs`, `src-tauri/src/git_branches.rs`, `src-tauri/src/git_watch.rs`) | [git.md](git.md) |
| 3.10 Containers (`src-tauri/src/containers.rs`) | [containers.md](containers.md) |
| 3.11 Code search (`src-tauri/src/search.rs`) | [files.md](files.md) |
| 3.12 Editors (`src-tauri/src/editors.rs`) | [files.md](files.md) |
| 3.13 Pane CLI (`bb`) | [app.md](app.md) |
| 3.14 Shell integration install (`src-tauri/src/shell_integration.rs`) | [app.md](app.md) |
| 3.15 Git install (`src-tauri/src/git_install.rs`) | [app.md](app.md) |
| 3.16 Updates and releases | [app.md](app.md) |
| 3.17 Fonts (`src-tauri/src/fonts.rs`) | [terminal.md](terminal.md) |
| 3.18 Single instance (`src-tauri/src/second_instance.rs`) | [app.md](app.md) |
| 3.19 Local model servers (`src-tauri/src/model_servers.rs`) | [containers.md](containers.md) |
| 3.20 Ship (`src-tauri/src/forge/`) | [ship.md](ship.md) |
| 3.21 Local file server (`src-tauri/src/browser_files/`) | [browser.md](browser.md) |
| 3.22 Crash recovery and log (`src-tauri/src/crash_recovery.rs`, `src-tauri/src/app_log.rs`) | [app.md](app.md) |
| 3.23 CI for agents (`src-tauri/src/ci.rs`, `src-tauri/src/forge/failure.rs`, `src-tauri/src/forge/diagnostic.rs`) | [ship.md](ship.md) |
| 3.24 Agent table (`src/agents.json`) | [sessions.md](sessions.md) |
| 3.25 Branch size (`src-tauri/src/git_branch_size.rs`, `src-tauri/src/size_route.rs`) | [git.md](git.md) |
| 3.27 New worktree (`src-tauri/src/worktree_new.rs`, `src-tauri/src/worktree_trust.rs`, `src-tauri/src/worktree_route.rs`) | [git.md](git.md) |
| 3.28 Usage limits (`src-tauri/src/usage.rs`, `src-tauri/src/statusline_client.rs`, `src/usageModel.ts`) | [sessions.md](sessions.md) |
| 3.29 Media sessions (`src-tauri/src/media.rs`, `media_linux.rs`, `media_mpris.rs`, `system_volume.rs`) | [dashboard.md](dashboard.md) |
| 3.30 Background waits (`src-tauri/src/hooks.rs`, `src-tauri/src/background_agents.rs`) | [sessions.md](sessions.md) |
| 3.31 WebKitGTK environment (`src-tauri/src/webkit_env.rs`) | [app.md](app.md) |
| 3.32 AppImage menu entry (`src-tauri/src/appimage_entry.rs`, `src/appImageOffer.ts`) | [app.md](app.md) |
| 3.33 Session history (`src-tauri/src/history/`) | [sessions.md](sessions.md) |
| 3.34 Window size (`src-tauri/src/window_fit.rs`) | [app.md](app.md) |
| 3.35 Credential store (`src-tauri/src/credential_store.rs`, `src-tauri/src/credential_store_linux.rs`) | [ship.md](ship.md) |
| 4.1 Layers | [workspace.md](workspace.md) |
| 4.2 Pane layout | [workspace.md](workspace.md) |
| 4.3 Collapsing | [workspace.md](workspace.md) |
| 4.4 Terminal pane (`pane.ts`) | [terminal.md](terminal.md) |
| 4.5 Key handling | [keys.md](keys.md) |
| 4.6 Dashboard panel | [dashboard.md](dashboard.md) |
| 4.7 Attention | [sessions.md](sessions.md) |
| 4.8 Terminal status | [terminal.md](terminal.md) |
| 4.9 Restore | [workspace.md](workspace.md) |
| 4.10 Tabs | [workspace.md](workspace.md) |
| 4.11 Pane kinds | [workspace.md](workspace.md) |
| 4.12 Files and pins | [files.md](files.md) |
| 4.13 Git pane | [git.md](git.md) |
| 4.14 Search pane | [files.md](files.md) |
| 4.15 Scratch pads | [files.md](files.md) |
| 4.16 Containers | [containers.md](containers.md) |
| 4.17 Setup wizard | [app.md](app.md) |
| 4.18 App dialog | [app.md](app.md) |
| 4.19 Ports | [containers.md](containers.md) |
| 4.20 Ship pane | [ship.md](ship.md) |
| 4.21 Local Browser | [browser.md](browser.md) |
| 4.22 Code colors (`src/code/`) | [files.md](files.md) |
| 4.23 Agent glow and border lights (`src/paneLights.ts`) | [sessions.md](sessions.md) |
| 4.24 Program status (OSC 7501) | [sessions.md](sessions.md) |
| 4.25 Cloud context chip (`src/cloudContextModel.ts`) | [terminal.md](terminal.md) |
| 4.26 Runs bound to panes (`src/paneRunModel.ts`, `src/paneRunTracker.ts`) | [ship.md](ship.md) |
| 4.27 New worktree flow (`src/worktreeNewModel.ts`, `src/worktreeNewFlow.ts`, `src/worktreeTrustDialog.ts`, `src/worktreeNewDialog.ts`) | [git.md](git.md) |
| 4.28 Needs you (`src/needsYouModel.ts`, `src/needsYouStore.ts`, `src/needsYouSection.ts`) | [dashboard.md](dashboard.md) |
| 4.29 Tour (`src/tourModel.ts`, `src/tourController.ts`, `src/tourCard.ts`) | [app.md](app.md) |
| 4.30 Tab transition and background tabs | [workspace.md](workspace.md) |
| 4.31 Media section (`src/mediaModel.ts`, `src/mediaSection.ts`, `src/mediaSlider.ts`) | [dashboard.md](dashboard.md) |
| 4.32 Sessions dialog (`src/sessionsDialog.ts`, `src/sessionHistoryModel.ts`) | [sessions.md](sessions.md) |
| 5 Readability | [README.md](README.md) |
| 6 Backdrop | [backdrop.md](backdrop.md) |
| 6.1 Modules | [backdrop.md](backdrop.md) |
| 6.2 Backdrop API | [backdrop.md](backdrop.md) |
| 6.3 Colony upkeep | [backdrop.md](backdrop.md) |
| 6.4 Performance | [backdrop.md](backdrop.md) |
| 6.5 Image and Slideshow | [backdrop.md](backdrop.md) |
| 6.6 Galaxy | [backdrop.md](backdrop.md) |
| 6.7 Wave | [backdrop.md](backdrop.md) |
| 6.8 Matrix | [backdrop.md](backdrop.md) |
| 7 Data model | [data.md](data.md) |
| 8 Settings | [data.md](data.md) |
| 9 Security | [README.md](README.md) |
| 9.1 Local Browser | [security.md](security.md) |
| 10 Testing | [README.md](README.md) |
| 11 Risks | [README.md](README.md) |

## 1. Goals

- **A daily-driver terminal for Claude Code.** Every key Claude Code and bash rely on reaches
  the shell; copy, paste, resizing, colors, and box drawing behave as they do in Windows Terminal.
- **A live simulation as the backdrop.** The real simulation, not a video or shader approximation, renders
  behind transparent terminals at full frame rate. One instance fills the window behind every
  terminal. Galaxy is the default backdrop style; Swirling Lights, Matrix, Wave,
  Image, Slideshow, and None are alternatives (section 6).
- **A terminal dashboard.** Open, collapse, and arrange terminals in tabs. Within a tab,
  expanded terminals tile the window as Windows Terminal style panes, with the same keybindings
  as the current Windows Terminal setup; collapsed terminals keep running as cards in a side
  panel, grouped by tab, each showing whether it is idle, working, waiting on you, or done
  since you last looked.
- **Favorite folders.** One click opens a terminal in a favorite folder.
- **Picks up where it left off.** On restart the app reopens the same terminals in the same
  folders and layout, and resumes the agent sessions that were running in them.
- **Session awareness.** A roster of all local agent sessions (Claude Code, Codex, and Copilot, in
  this app and elsewhere), their status, and which ones need attention. Claude Code is the tested path; Codex, Copilot, and the Local AI models section
  are a preview.
- **Repo companions.** What usually stays open beside Claude Code (a folder of plans, a to-do
  file, git status, a code search, a scratch pad, Docker and Podman containers) opens as panes next to the
  terminals, so a repo's working set lives in one tab and a saved layout reopens all of it.

### Non-goals

- Platforms other than Windows 11, macOS, and Linux. Windows with WebView2 is the primary
  target; macOS ships as ad-hoc signed preview builds (`docs/macos-testing.md`) and Linux as early
  `.deb`, `.rpm`, Arch package, and AppImage builds (`docs/linux-testing.md`).
- Replacing Claude Code's interface. Claude runs unmodified inside a pane.
- Shells other than Git Bash, PowerShell 7, Windows PowerShell, and Command Prompt on Windows,
  and on macOS and Linux the login shell, zsh, bash, fish, and what `/etc/shells` lists.
- Remote or SSH sessions.
- Being a code editor. The file preview edits text and colors code by language (4.22), but
  completion, diagnostics, and refactoring stay in the preferred editor (3.12).
- A full git client or container manager. The Git pane covers status, staging, committing,
  diffs, undoing the last commit, and creating, switching, renaming, and deleting local branches,
  with no merge or rebase; the Containers pane covers existing containers and
  starting or stopping the engines that run them.

## 2. Architecture

```
┌────────────────────────────── WebView2 (one window) ──────────────────────────────┐
│  z0  Backdrop canvas (per style, full window, dimmed, optional blur)              │
│  z1  Pane grid: xterm.js terminals, transparent background                        │
│  z2  Chrome: tab strip, dashboard panel, pane borders/titles, toasts              │
└──────────────▲──────────────────────────────▲───────────────────────▲─────────────┘
               │ invoke / Channel             │ events                │ events
┌──────────────┴───────────┐   ┌──────────────┴──────────┐   ┌────────┴────────────┐
│ PtyManager               │   │ SessionRoster           │   │ HookReceiver        │
│ portable-pty (ConPTY)    │   │ watches ~/.claude/      │   │ 127.0.0.1 HTTP,     │
│ one pty per pane         │   │ sessions/*.json         │   │ token-checked       │
└──────────────────────────┘   └─────────────────────────┘   └─────────────────────┘
                                 Rust (Tauri core process)
```

The Rust core owns everything that touches the OS: ptys, the clipboard, file watching, the
hook endpoint, process inspection, repo files, git, containers, code search, and code host APIs. The front end owns layout, rendering, and input
mapping. They talk through Tauri commands (request/response) and Tauri channels and events
(streams). The diagram shows Windows; on macOS the page runs in WKWebView and on Linux in
WebKitGTK, and `portable-pty` opens a Unix pty there instead of a ConPTY.

### Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 on WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux |
| Pty | `portable-pty` (ConPTY on Windows, a Unix pty elsewhere) |
| Clipboard | `arboard` for text and file lists, with `clipboard-win` for File Explorer's file formats on Windows |
| File watching | `notify` |
| Process inspection | `sysinfo` |
| Hook endpoint | `tiny_http` on a background thread |
| Terminal | `@xterm/xterm` 6 with fit, WebGL, Unicode 11, search, serialize, and web-links addons |
| Backdrop | Three.js for Swirling Lights (the colony simulation) and Galaxy, Canvas 2D for Matrix, Wave, Image, and Slideshow, or nothing, chosen by `backdrop.style`, in `src/backdrop/` (section 6) |
| Front end | TypeScript, Vite, no framework |
| Markdown | `markdown-it`, sanitized with `DOMPurify` |
| Text editor, code colors | CodeMirror 6 and its Lezer language parsers (4.22) |
| Code search | `ignore`, `grep-searcher`, and `grep-regex` (ripgrep's libraries) |
| Git, containers | The `git`, `docker`, and `podman` command-line tools, run as child processes |
| Code host APIs | `ureq` over `rustls` with the platform certificate verifier (3.20) |
| Pane CLI | `bb` (`bb.exe` on Windows), a second binary in the Tauri crate, installed beside the app (3.13) |
| Updates | `tauri-plugin-updater` against GitHub releases (3.16) |
| Font list | DirectWrite through the `windows` crate on Windows, Core Text through `objc2-core-text` on macOS, `fc-list` on Linux (3.17) |

The chrome is a pane tree, the dashboard panel, the app dialog, and overlays, built in plain
TypeScript with one class or module per file and pure `*Model.ts` modules beside the DOM code.

## 5. Readability

Bloom behind text is the main readability risk, so the whole backdrop is dimmed by `scrim.opacity`
(default 0.5) through a CSS `brightness()` filter on its canvas, at 1 minus the opacity; that
matches a black fill at that opacity, and it covers the gaps between panes as well as what sits
behind them. Ctrl+Shift+B cycles none, light, medium, and heavy presets and saves the choice; an opacity
of 0 leaves the backdrop undimmed. The None style has no canvas, so nothing is dimmed there.

`scrim.blurPx` (default 1) blurs the whole backdrop in the same filter, under every drawn style
and at every scrim opacity. The canvas is oversized by twice the blur on each side, since a blur darkens a band
at the canvas edges as wide as itself, and the oversize pushes that band off screen. Blur over a
constantly redrawing canvas is the most expensive effect here, so the default is a light 1 px
and 0 turns it off.

`uiScale` (default 1.25, from 1 to 2; the Settings tab calls it Interface size) sizes the chrome
for people who want larger or smaller targets and text: buttons, text boxes, dropdowns, title and
tab strips, and the app dialog's panels. It sets `--ui-scale` on `:root`, and the CSS rules that
apply it are described in `src/uiScale.ts`. Content text stays put; it follows `font.size`, the
Settings tab's Text size, through the `--text-scale` property (`font.size` over 14, set by
`applyTextScale`).

## 9. Security

- The hook endpoint listens on loopback only and requires the per-launch token; the token
  lives only in pane environments and in memory. Its `/cli` path (3.13) carries out only
  actions the UI already offers, with the same path checks. Its `/ci` path (3.23) reads what Ship
  already shows and writes (re-run, cancel) only when `ship.cliWrites` is on. Its `/size` path
  (3.25) only counts the changed lines of the caller's own repo, its `/worktree` path (3.27)
  creates a worktree only of the caller's own repo and runs a setup script only after the user
  approves it, and its `/usage` path (3.28) only records an agent's usage report.
- Tauri capabilities stay minimal: the app's own commands plus `core:default`,
  `core:window:allow-destroy` (closing the window after the workspace is saved),
  `core:window:allow-request-user-attention` (the taskbar flash), `core:window:allow-set-focus`,
  `core:window:allow-set-fullscreen`, `updater:default`, and `process:allow-restart` (installing
  an update, 3.16). No shell, fs, or http plugins are exposed to the page.
- A strict CSP in release builds (`default-src 'self'`; scripts, fonts, and styles
  self-hosted, with inline `<style>` elements allowed because xterm.js injects them), so a
  malicious escape sequence that somehow injected markup could not load remote code.
  xterm.js renders terminal output as text, never HTML.
- Hyperlinks in terminal output, both detected URLs (the xterm web-links addon) and OSC 8
  hyperlinks, open only `http` and `https` URLs, through the system browser, on Ctrl+click; a
  loopback link opens the Local Browser pane (4.21) instead, and Ctrl+Shift+click sends it to
  the system browser.
- The Local Browser pane (4.21) runs pages the app did not write, so its threat model and every
  measure that contains a framed page, including the local file server (3.21) and its trust
  levels, are in [security.md](security.md) (9.1). The CSP `frame-src` lists exactly
  `http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*`, in both `csp`
  and `devCsp` (WebView2 rejects an IPv6 host such as `[::1]` there, so the pane does not open
  one), and deliberately omits `*.localhost`: the release app is served from
  `http://tauri.localhost`, so a framed copy of it with `allow-same-origin` would share its origin
  and reach the Tauri IPC bridge.
- Markdown is the only file content rendered as HTML: `markdown-it` with raw HTML off, then
  `DOMPurify`, with no remote images and links opened only through `open_url` (4.12).
- The file commands (3.8) normalize every path, write only to existing files, and create or
  delete only the app's own scratch files.
- Ship tokens stay in the core's memory and never reach the page or a log; how they are read,
  stored, and sent is in 3.20 and 3.35.
- `git`, `docker`, and `podman` run with argument lists, never through a shell, and paths come
  after `--` where the CLI accepts it. `open_in_editor` runs only a detected editor or the
  user's own `editor.command`.

## 10. Testing

Pure modules (no DOM) carry the logic worth testing and are covered by Vitest beside each
module (`src/**/*.test.ts`); the Rust core's tests sit in each module and run against temp
folders, temp repos, captured CLI output, and a spawned pty. Keys are the exception: what
reaches the shell through WebView2 and xterm.js can only be checked by hand, with the keyboard
checklist in [development.md](../development.md#keyboard-checklist) before each release.

The Ship providers' tests, including the live `#[ignore]` checks run by hand, are listed in
[ship.md](ship.md).

CI: a GitHub Actions workflow (`.github/workflows/ci.yml`) on `windows-latest` runs the type
check, Vitest, `cargo test`, and `pnpm tauri build`, then uploads the NSIS installer as the
`bashboard-installer` artifact. A second job on `macos-latest` runs the same checks and builds
an ad-hoc signed universal `.app`, failing unless `bb` ships inside it for both architectures. A
third job on `ubuntu-22.04` runs the same checks, builds the `.deb`, `.rpm`, and AppImage,
lays the packages out so `bb` stays off the system `PATH` (3.13), repackages the `.rpm` as an
Arch package in an `archlinux:base-devel` container, and uploads them all as `bashboard-linux`.

## 11. Risks

- **Undocumented session files.** If Claude Code changes `~/.claude/sessions`, the roster
  degrades to showing only hook-reported sessions in this app's panes. Parsing is lenient and
  failures are logged, never fatal.
- **Codex and Copilot internals.** Their hook payloads, transcripts, and resume flags are
  internal to each tool and can change. Every field is optional on parse, a payload the receiver
  cannot read changes nothing, and `BASHBOARD_HOOK_LOG` captures payloads for reports. Support
  for both is a preview.
- **WebGL contexts.** Many panes plus the Swirling Lights backdrop approach Chromium's limit; the
  budget and DOM fallback in 4.4 cover it, at some cost in rendering speed for the extra panes.
  Disposing the backdrop releases its context at once (6.4), so switching styles does not leak one.
- **GPU cost.** The Swirling Lights backdrop plus bloom behind several WebGL terminals is the
  heaviest part of the app. The visibility pausing in 6.4 means it costs nothing while hidden, and
  `backdrop.maxFps` trims it on weaker GPUs. Matrix and Wave are far lighter, and None costs nothing.
- **Resume.** Restore types the agent's resume command (4.9); if that session's transcript is
  gone, the command fails visibly in its terminal rather than silently.
- **Off-screen output.** Collapsed terminals and those in background tabs keep parsing output
  into off-DOM xterm instances; a very chatty one costs parse time, though no rendering.
- **Container CLI output.** The JSON from `docker ps` and `podman ps` is not a stable
  contract, and the two differ. Each engine's parser treats every field as optional, so a
  format change degrades a row rather than the list.
- **Edits racing an agent.** A file can change between a Files pane's read and its save. The
  modified-time check in `fs_write_text` turns that into the Reload or Keep mine choice (4.12)
  instead of a silent overwrite.
- **Ctrl+W.** Bound to close pane (as in the current Windows Terminal setup), so bash's
  delete-previous-word is unavailable unless the settings file unbinds it.
