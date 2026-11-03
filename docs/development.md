# Development

## Setting up a new machine

These steps set up a machine to build Bashboard from source. To just use it, see
[Installing](../README.md#installing).

Bashboard targets Windows 11, which already includes the WebView2 runtime. Everything else
installs with `winget` from a terminal; admin rights are needed for the Visual Studio build
tools and for machine-wide installs of the rest.

1. **Git for Windows**, which provides Git Bash and the `bash.exe` that the Claude Code hooks run through:

   ```sh
   winget install --id Git.Git -e
   ```

2. **Node.js 24 or later** and **pnpm**:

   ```sh
   winget install --id OpenJS.NodeJS.LTS -e
   winget install --id pnpm.pnpm -e
   ```

3. **C++ build tools.** Rust on Windows links with the MSVC toolchain and needs the Windows SDK.
   On a machine without Visual Studio, install the Build Tools with the C++ workload:

   ```sh
   winget install --id Microsoft.VisualStudio.BuildTools -e --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   If Visual Studio is already installed, open the Visual Studio Installer instead, choose
   **Modify** on that install, check the **Desktop development with C++** workload (it includes
   the MSVC compiler and a Windows 11 SDK), and apply.

4. **Rust**, through rustup:

   ```sh
   winget install --id Rustlang.Rustup -e
   ```

   rustup installs the stable `x86_64-pc-windows-msvc` toolchain by default. If `rustup show`
   reports a `gnu` toolchain, run `rustup default stable-msvc`.

5. **Open a new terminal** so the updated `PATH` takes effect, then confirm the tools:

   ```sh
   git --version && node -v && pnpm -v && rustc -V && cargo -V
   ```

6. **Get the code.** When copying the folder from another machine, leave out `node_modules/`,
   `dist/`, and `src-tauri/target/`; they hold build output with machine-specific paths and are
   recreated by the build.

7. **Configure Git Bash** as described in
   [New panes in the current folder](setup.md#new-panes-in-the-current-folder).

8. **Build and run** from the repo root:

   ```sh
   pnpm install
   pnpm tauri dev
   ```

   The first run compiles every Rust dependency and takes several minutes; later runs are
   incremental.

Panes run `C:\Program Files\Git\bin\bash.exe --login -i` by default. When that file is missing,
Bashboard looks for a per-user install at `%LOCALAPPDATA%\Programs\Git` and then for the Git
for Windows install whose `git.exe` is on `PATH`. If Git is somewhere else, set `shell.path` in
the settings file (see [Settings](settings.md#settings)).

## Development

```sh
pnpm tauri dev      # run the app with hot reload
pnpm tauri:debug    # the same, with WebView2's remote debugging port open (9222, or pass one)
pnpm test           # frontend unit tests (Vitest)
pnpm tauri build    # release build and installer
pnpm build:bb       # rebuild bb.exe after editing src-tauri/src/bin/bb.rs
pnpm version:set 0.2.0  # set the app version everywhere (see Releasing)
```

`pnpm tauri dev` builds `bb.exe` at startup, so the debug app finds it beside `bashboard.exe`.

Rust tests run with `cargo test` from `src-tauri/`.

Debug builds keep their settings, workspace, favorites, and layouts in
`%APPDATA%\dev.bashboard\dev`, so a `pnpm tauri dev` run never restores or overwrites the
installed app's workspace. The first debug run copies the installed app's `settings.json` there.
WebView2's own data (its cache and storage) is in `%LOCALAPPDATA%\dev.bashboard\dev\EBWebView`,
apart from the installed app's, because WebView2 refuses to open one data folder from two
processes with different browser arguments.

`pnpm tauri:debug [port]` sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` to
`--remote-debugging-port=<port>` for the run, so Chrome DevTools (`chrome://inspect`, configured
for `localhost:<port>`) or Playwright's `chromium.connectOverCDP('http://127.0.0.1:<port>')` can
attach to the window, read the console, and drive the real app with the real core behind it.
It works beside the installed app. Like `pnpm tauri dev`, it starts Vite on port 1420, so when
another Vite server already holds that port, run `src-tauri\target\debug\bashboard.exe` with the
same variable set instead; it loads from whatever is serving port 1420.

Release builds allow one running instance; debug builds don't enforce it, so a dev run starts
beside the installed app and several dev runs can start at once. Testing the second-launch
handoff therefore needs a release build, and a release build run from `src-tauri\target\release`
shares the installed app's lock and saved workspace.

## Releasing

`pnpm tauri build` produces the release app and an NSIS installer at
`src-tauri\target\release\bundle\nsis\*-setup.exe`. The
`.github/workflows/ci.yml` workflow runs the type check, tests, and Rust tests on every push to
`main` and every pull request, then builds the installer and uploads it as the
`bashboard-installer` artifact on the workflow run.

To publish a release:

1. Run `pnpm version:set <version>` (for example `0.2.0`). It sets the version in
   `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`; `tauri.conf.json` reads
   it from `package.json`.
2. Commit the change, then create and push a `v<version>` tag: `git tag v<version>` and
   `git push origin main v<version>`. To give the release notes, make it an annotated tag
   instead: `git tag -a v<version> --cleanup=whitespace -F notes.md` (or `-m "..."`). The tag
   message leads the release description and the update notes installed apps see; without one,
   the release carries only the standard alpha text. `--cleanup=whitespace` keeps markdown `#`
   headings, which git otherwise strips as comments.

The `.github/workflows/release.yml` workflow runs on the tag. It checks that the tag matches
`package.json`, runs the checks, builds a draft GitHub release named
"Bashboard v<version> (alpha)" holding the installer, its `.sig` signature, and `latest.json`
(the file installed apps read to find updates), checks that the installer ships `bb.exe`, and
then publishes the release. The workflow needs two repository secrets,
`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, holding the updater
signing key. Local builds and CI runs need no key; only the release workflow signs.

The release workflow also Authenticode-signs the app, `bb.exe`, and the installer through Azure
Artifact Signing when the `AZURE_CLIENT_ID` secret is set, and then fails the release if any of
them lacks a valid signature. Signing needs three secrets for an Azure app registration
(`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`) holding the Artifact Signing
Certificate Profile Signer role, plus three repository variables naming the signing account:
`AZURE_SIGNING_ENDPOINT` (for example `https://eus.codesigning.azure.net`),
`AZURE_SIGNING_ACCOUNT`, and `AZURE_SIGNING_PROFILE`. Without `AZURE_CLIENT_ID`, the release
ships unsigned and the workflow logs a warning.

Before each release, run through this keyboard checklist in a `pnpm tauri dev` session or the
built app:

- Ctrl+F, Ctrl+R, and Ctrl+P reach the shell
- Alt+B and Alt+F move by word
- Shift+Enter sends a newline to Claude Code
- Esc reaches the shell or a running program
- copy (Ctrl+Shift+C, or Ctrl+C with a selection) and paste (Ctrl+V, Ctrl+Shift+V)
- resize a pane with Alt+Shift+Arrow
- Ctrl+Shift+F finds in scrollback, and Ctrl+click opens a link
- Ctrl+Shift+T, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, and Ctrl+Alt+1 through 9 work on tabs;
  confirm WebView2 does not take Ctrl+Tab
- Alt+Shift+T opens the shell picker
- Ctrl+Shift+N opens a scratch pad, and Ctrl+Enter in it sends to the tab's last terminal
- Ctrl+Shift+E opens a Files pane at the focused pane's repo root, or focuses the tab's existing
  one for that repo
- Ctrl+Shift+G opens a Git pane at the focused pane's repo root, or focuses the tab's
  existing one for that repo
- Ctrl+Shift+H opens a Search pane at the focused pane's repo root, and Enter in its query field
  runs the search
- Ctrl+Shift+Z zooms the focused pane, restores the layout on a second press, and does nothing
  in a tab with one pane
- Ctrl+=, Ctrl+numpad +, Ctrl+-, and Ctrl+0 change the font size; confirm WebView2 does not take
  Ctrl+=
- F6 moves focus into the dashboard (peeking it when hidden), the arrows and Enter work there,
  and F6 or Esc returns to the pane
- Ctrl+Shift+L jumps to the next waiting, done, or failed terminal
- a right-click in a terminal shows no browser menu

## Debugging input

Set `BASHBOARD_KEYLOG` to a file path before launching, and every keystroke and paste sent to a
shell is appended there, escaped (for example `\u{6}` for Ctrl+F). Use it to confirm a key
combination actually reaches the shell rather than being taken by WebView2 or xterm.js.

```sh
BASHBOARD_KEYLOG=/tmp/keys.txt pnpm tauri dev
```

To exercise the first-run wizard on a machine that has the installed app, set
`BASHBOARD_NO_DEV_SEED=1` on the `pnpm tauri dev` run. It skips copying the installed app's
`settings.json` into the dev folder, so with the dev `settings.json` removed, that launch
creates the file and opens the wizard.
