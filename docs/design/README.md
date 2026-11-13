# Bashboard: design spec

A Windows desktop terminal dashboard, built with Tauri, that opens, collapses, and arranges Git
Bash terminals over a live colony-simulation backdrop, launches them from favorite folders, and shows
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
| 3.9 Git (`src-tauri/src/git.rs`, `src-tauri/src/git_fetch.rs`, `src-tauri/src/git_worktrees.rs`, `src-tauri/src/git_branches.rs`) | [git.md](git.md) |
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
| 3.26 Azure context (`src-tauri/src/cloud_context.rs`) | [terminal.md](terminal.md) |
| 3.27 New worktree (`src-tauri/src/worktree_new.rs`, `src-tauri/src/worktree_trust.rs`, `src-tauri/src/worktree_route.rs`) | [git.md](git.md) |
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
| 4.21 Local Browser (`src/localBrowserPane.ts`, `src-tauri/src/browser.rs`) | [browser.md](browser.md) |
| 4.22 Code colors (`src/code/`) | [files.md](files.md) |
| 4.23 Agent glow and border lights (`src/paneLights.ts`) | [sessions.md](sessions.md) |
| 4.24 Program status (OSC 7501) (`src/programStatus.ts`) | [sessions.md](sessions.md) |
| 4.25 Cloud context chip (OSC 7502) (`src/cloudContextModel.ts`) | [terminal.md](terminal.md) |
| 4.26 Runs bound to panes (`src/paneRunModel.ts`, `src/paneRunTracker.ts`) | [ship.md](ship.md) |
| 4.27 New worktree flow (`src/worktreeNewModel.ts`, `src/worktreeNewFlow.ts`) | [git.md](git.md) |
| 5 Readability | [README.md](README.md) |
| 6 Backdrop | [backdrop.md](backdrop.md) |
| 6.1 Modules | [backdrop.md](backdrop.md) |
| 6.2 Backdrop API | [backdrop.md](backdrop.md) |
| 6.3 Colony upkeep | [backdrop.md](backdrop.md) |
| 6.4 Performance | [backdrop.md](backdrop.md) |
| 6.5 Image and Slideshow | [backdrop.md](backdrop.md) |
| 6.6 Galaxy | [backdrop.md](backdrop.md) |
| 6.7 Wave | [backdrop.md](backdrop.md) |
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
  terminal. Swirling Lights is the default backdrop style; Galaxy, Matrix, Wave,
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
  this app and elsewhere), their status, and which ones need attention, also expressed as organisms
  in the simulation. Claude Code is the tested path; Codex, Copilot, and the Local AI models section
  are a preview.
- **Repo companions.** What usually stays open beside Claude Code (a folder of plans, a to-do
  file, git status, a code search, a scratch pad, Docker and Podman containers) opens as panes next to the
  terminals, so a repo's working set lives in one tab and a saved layout reopens all of it.

### Non-goals

- Cross-platform support. Windows 11 with WebView2 is the only target.
- Replacing Claude Code's interface. Claude runs unmodified inside a pane.
- Shells other than Git Bash, PowerShell 7, Windows PowerShell, and Command Prompt.
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
(streams).

### Stack

| Layer | Choice |
| --- | --- |
| Shell | Tauri 2 on WebView2 (Chromium) |
| Pty | `portable-pty` (ConPTY) |
| Clipboard | `arboard` (text only) |
| File watching | `notify` |
| Process inspection | `sysinfo` |
| Hook endpoint | `tiny_http` on a background thread |
| Terminal | `@xterm/xterm` 6 with fit, WebGL, Unicode 11, and search addons |
| Backdrop | Colony simulation and renderer (three.js), a Canvas 2D digital-rain style, or nothing, chosen by `backdrop.style`, in `src/backdrop/` (section 6) |
| Front end | TypeScript, Vite, no framework |
| Markdown | `markdown-it`, sanitized with `DOMPurify` |
| Text editor, code colors | CodeMirror 6 and its Lezer language parsers (4.22) |
| Code search | `ignore`, `grep-searcher`, and `grep-regex` (ripgrep's libraries) |
| Git, containers | The `git`, `docker`, and `podman` command-line tools, run as child processes |
| Pane CLI | `bb.exe`, a second binary in the Tauri crate, installed beside the app (3.13) |
| Updates | `tauri-plugin-updater` against GitHub releases (3.16) |
| Font list | DirectWrite through the `windows` crate (3.17) |

The chrome is a pane tree, the dashboard panel, and a few overlays, so plain TypeScript with
one class per file is enough to start. If the dashboard panel grows into real UI (richer drag
and drop, filtering, editing favorites in place), React with shadcn/ui can be introduced for
the chrome alone without touching terminals or the backdrop.

## 5. Readability

Bloom behind text is the main readability risk, so the whole backdrop is dimmed by `scrim.opacity`
(default 0.5) through a CSS `brightness()` filter on its canvas, at 1 minus the opacity; that
matches a black fill at that opacity, and it covers the gaps between panes as well as what sits
behind them. Ctrl+Shift+B cycles none, light, medium, and heavy presets and saves the choice; an opacity
of 0 leaves the backdrop undimmed. The None style has no canvas, so nothing is dimmed there.

`scrim.blurPx` (default 1) blurs the whole backdrop in the same filter, under every drawn style
and at every scrim opacity. The canvas is oversized by twice the blur on each side, since a blur darkens a band
at the canvas edges as wide as itself, and the oversize pushes that band off screen. Blur over a
constantly redrawing canvas is the most expensive effect here, hence the default of 0.

`uiScale` (default 1, up to 2; the Settings tab calls it Interface size) sizes the chrome for people
who want larger targets and text. It sets `--ui-scale` on `:root` (`src/uiScale.ts`), and one rule
in `styles.css` gives every button, single-line text box, and dropdown `zoom` by it, so a control's
glyph, padding, and border grow together, a toolbar row keeps one height, and every pane kind's
toolbar follows without its own rule. Bars with a fixed px height (the pane title strip, the tab
strip, and the offsets below them) multiply that height by the same property, and text you click or
drag scales with them: pane titles and their status dots, tab titles and dots, the dashboard's
section titles, and the find bar's match count. The app dialog zooms each tab's whole panel
instead, so every tab's text, spacing, and fields scale together, and its controls reset their own
zoom to 1 so the panel's applies once; the dialog widens by the same factor so lines keep their
length. Content text stays put; it follows `font.size`, the Settings tab's Text size, through the
`--text-scale` property (`font.size` over 14, set by `applyTextScale`), so surfaces designed at a
fixed px size keep it at the default, and its pane's zoom multiplies on top. The top of the
range puts the dashboard's buttons at the Launch section's size, and the Launch buttons themselves
stay fixed. Buttons that read as text (dialog links, Ship repo rows, Ports column headers), rename
boxes that stand in for a row's or tab's text, and the hidden dashboard's 8px edge handle are left
out. The dashboard top bar's buttons keep their side padding unscaled, so both menus and the icons
fit untruncated up to about 1.4 at the dashboard's minimum width; past that the menu labels
ellipsize until the dashboard is widened. A control whose font an ancestor already scales would be
scaled twice, so the tab strip, which scales its text, leaves its buttons' font explicit and its
rename box out.

## 9. Security

- The hook endpoint listens on loopback only and requires the per-launch token; the token
  lives only in pane environments and in memory. Its `/cli` path (3.13) carries out only
  actions the UI already offers, with the same path checks. Its `/ci` path (3.23) reads what Ship
  already shows and writes (re-run, cancel) only when `ship.cliWrites` is on. Its `/size` path
  (3.25) only counts the changed lines of the caller's own repo.
- Tauri capabilities stay minimal: the app's own commands plus `core:default` and
  `core:window:allow-destroy` (closing the window after the workspace is saved) and
  `core:window:allow-request-user-attention` (the taskbar flash). No shell, fs,
  or http plugins are exposed to the page.
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
- Ship tokens (3.20) stay in the core's memory. They are read only from `gh auth token`, `glab
  auth status --show-token`, `az account get-access-token`, the `AZURE_DEVOPS_EXT_PAT` variable,
  Git Credential Manager (`git credential fill`, never `approve` or `reject`, never interactive),
  or the credentials that the Accounts tab and `bb auth` write: `bashboard:bitbucket.org` and one
  `bashboard:dev.azure.com/<org>` per Azure DevOps organization. They never
  reach the page, a log, or an error message, and `Token`'s `Debug` output hides the value. The one
  way a secret enters the core is the Accounts tab's password field, which sends a Bitbucket token
  or an Azure DevOps personal access token to `forge_set_token` as a single argument; the core writes it to Windows Credential
  Manager and nowhere else, and overwrites its copies afterward on a best effort basis, since the
  IPC layer's own buffers are outside the app's control. The field is emptied on save, cancel, and
  when the dialog closes. A redirect to another
  host drops the `Authorization` header, the Bitbucket provider refuses any host but
  bitbucket.org before it sends anything, and the Azure DevOps provider calls only dev.azure.com,
  so a self-hosted host's token is never sent to Bitbucket Cloud or Azure DevOps. `bb auth` hides
  its input and never prints the token, and the Accounts tab's status and
  test results carry no token.
- `git`, `docker`, and `podman` run with argument lists, never through a shell, and paths come
  after `--` where the CLI accepts it. `open_in_editor` runs only a detected editor or the
  user's own `editor.command`.

## 10. Testing

Pure modules (no DOM) carry the logic worth testing and are covered by Vitest beside each
module (`src/**/*.test.ts`); the Rust core's tests sit in each module and run against temp
folders, temp repos, captured CLI output, and a spawned pty. Keys are the exception: what
reaches the shell through WebView2 and xterm.js can only be checked by hand, with the keyboard
checklist in [development.md](../development.md#releasing) before each release.

The Ship module's providers map captured JSON to the normalized shapes in pure functions, and
build the requests that change a build or pipeline apart from sending them, so the GitHub,
Bitbucket, GitLab, and Azure DevOps mappings, remote parsing and host classification, status-code
mapping, the ETag cache, account choice, the Azure DevOps header scheme by token source, and
token-source order are all tested without a network, and `bb auth`'s argument and token handling
the same. The Accounts tab's host ordering and detection, source kinds, and signed-in check are
Rust tests in `forge/accounts.rs`, and its cards, including the folding of undetected hosts, are a
Vitest module (`forgeAccountsModel.test.ts`). The notices and menus, polling intervals, grouping,
and log cleanup are Vitest cases in `shipModel.test.ts` and `shipMenus.test.ts`. Live checks
against a real repo are `#[ignore]` tests, run by hand with `cargo test forge::github --
--ignored` (it uses `gh auth token`), `cargo test forge::bitbucket -- --ignored` (it uses the
token stored by `bb auth bitbucket`), `cargo test forge::azure_devops -- --ignored` (read-only
requests; it needs `BASHBOARD_ADO_LIVE=<org>/<project>/<repo>` and `AZURE_DEVOPS_EXT_PAT`), and
`cargo test forge::http -- --ignored` (TLS through the Windows certificate store).

CI: a GitHub Actions workflow (`.github/workflows/ci.yml`) on `windows-latest` runs the type
check, Vitest, `cargo test`, and `pnpm tauri build`, then uploads the NSIS installer as the
`bashboard-installer` artifact. A second job on `macos-latest` runs the same checks and builds
an ad-hoc signed universal `.app`, failing unless `bb` ships inside it for both architectures.

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
