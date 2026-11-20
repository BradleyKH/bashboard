# Development

## Setting up a new machine

These steps set up a Windows machine to build Bashboard from source. To just use it, see
[Installing](../README.md#installing). On macOS or Linux, install Node.js, pnpm, Rust, and
Tauri's system packages for that OS (the `macos` and `linux` jobs in `.github/workflows/ci.yml`
list what CI installs), then follow steps 6 and 8.

Windows 11 already includes the WebView2 runtime. Everything else installs with `winget` from a
terminal; admin rights are needed for the Visual Studio build
tools and for machine-wide installs of the rest.

1. **Git for Windows**, which provides Git Bash, the default shell:

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

6. **Get the code:**

   ```sh
   git clone https://github.com/BradleyKH/bashboard && cd bashboard
   ```

   When copying the folder from another machine instead, leave out `node_modules/`, `dist/`, and
   `src-tauri/target/`; they hold build output with machine-specific paths and are recreated by
   the build.

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
pnpm tauri:debug    # the same, with WebView2's debugging port open (Windows only)
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
It works beside the installed app. Like `pnpm tauri dev`, it starts Vite on port 1420; when
another server already holds that port, it exits without starting anything and prints the command
to run instead: `src-tauri\target\debug\bashboard.exe` with the same variable set, which loads
from whatever is serving port 1420. The variable only affects WebView2, so this is Windows only;
on Linux, set `WEBKIT_INSPECTOR_SERVER` instead (see [Measurements](linux-testing.md#measurements)).

A script driving the window should click with a trusted input event (CDP
`Input.dispatchMouseEvent`) rather than `element.click()` from `Runtime.evaluate`. A scripted
click carries no user activation, so a button that copies to the clipboard fails with "Document
is not focused", or, with focus emulated, raises WebView2's clipboard permission prompt and hangs.

Release builds allow one running instance; debug builds don't enforce it, so a dev run starts
beside the installed app and several dev runs can start at once. Testing the second-launch
handoff therefore needs a release build, and a release build run from `src-tauri\target\release`
shares the installed app's lock and saved workspace.

## Building packages on Linux and macOS

`pnpm tauri build` alone is not what ships on either OS; build the way CI does
(`.github/workflows/ci.yml`), from the repo root. On Linux:

```sh
pnpm tauri build --bundles deb,rpm,appimage
bash scripts/linux/relayout-packages.sh    # moves bb off /usr/bin, where it collides with Babashka
bash scripts/linux/build-arch-package.sh   # the Arch package, from the .rpm (needs Docker off Arch)
bash scripts/linux/assert-bundle.sh --arch
```

On macOS, build the universal `bb` first, since a universal build merges only the main binary:

```sh
(cd src-tauri && bash ../scripts/macos/universal-bb.sh)
pnpm tauri build --target universal-apple-darwin --bundles app --config '{"bundle":{"macOS":{"signingIdentity":"-"}}}'
bash scripts/macos/assert-bundle.sh universal-apple-darwin
```

## Releasing

`pnpm tauri build` produces the release app and an NSIS installer at
`src-tauri\target\release\bundle\nsis\*-setup.exe`. The
`.github/workflows/ci.yml` workflow runs the type check, tests, and Rust tests on every push to
`main` and every pull request, then builds the installer and uploads it as the
`bashboard-installer` artifact on the workflow run. Its `macos` job runs the same checks on a
Mac runner and builds a universal `.app` (not uploaded); for a `.dmg` to hand to a tester, run
the `macOS preview` workflow from the Actions tab. Its `linux` job builds the `.deb`, `.rpm`,
AppImage, and Arch package (from the `.rpm`, in an Arch container) and uploads them as the
`bashboard-linux` artifact; [Testing a Linux
build](linux-testing.md) lists what to check with them.

To publish a release:

1. Run `pnpm version:set <version>` (for example `0.2.0`). It sets the version in
   `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`; `tauri.conf.json` reads
   it from `package.json`.
2. Commit the change, write the release notes to `notes.md`, then tag and push:

   ```sh
   git tag -a v<version> --cleanup=whitespace -F notes.md
   git push origin main v<version>
   ```

   The tag message leads the release description and the update notes installed apps see
   (`latest.json`). `--cleanup=whitespace` keeps markdown `#` headings, which git otherwise
   strips as comments. With no notes, a lightweight tag (`git tag v<version>`) works, and the
   release carries only the standard beta text.

The `.github/workflows/release.yml` workflow runs on the tag. Its Windows job checks that the tag
matches `package.json`, runs the checks, builds a draft GitHub release named
"Bashboard v<version> (beta)" holding the installer, its `.sig` signature, and `latest.json`
(the file installed apps read to find updates), and checks that the installer ships `bb.exe`.
Its Linux job, on Ubuntu 22.04 alongside it, runs the Rust tests, builds the Linux packages,
moves `bb` off the system `PATH`, builds the Arch package from the `.rpm` in an Arch container,
checks the packages, and signs all four for the updater. Once both pass, a last job attaches
the `.deb`, `.rpm`, AppImage, and Arch package to the draft, adds an entry for each to
`latest.json` (`linux-x86_64-deb`, `-rpm`, `-appimage`, and `-arch`), checks that all four and
Windows are listed, and publishes the release. If any job fails, the release stays a draft, so
a broken build never becomes the release the updater reads. The standard text after the tag
message covers SmartScreen and how to install each Linux package.

**Updater signing.** Update packages are signed with a minisign key pair made by
`tauri signer generate`. The public key is committed in `tauri.conf.json`; the private key file
(`~/.tauri/bashboard.key`) and its password stay outside the repo, and are backed up, since
losing the key means installed apps cannot verify later updates. The release workflow reads them
from two repository secrets, `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, which both the Windows and Linux jobs use. Local builds
and CI runs need no key: only the release workflow turns on `bundle.createUpdaterArtifacts`,
through `--config`, for Windows. The Linux job signs with `tauri signer sign` instead, after the
relayout rebuilds the `.deb` and `.rpm` and the Arch package is made, since signatures the
bundler made would no longer match.

**Authenticode.** The release workflow also signs the app, `bb.exe`, and the installer through
Azure Artifact Signing when the `AZURE_CLIENT_ID` secret is set, and then fails the release if
any of them lacks a valid signature. Signing needs three secrets for an Azure app registration
(`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`) holding the Artifact Signing
Certificate Profile Signer role, plus three repository variables naming the signing account:
`AZURE_SIGNING_ENDPOINT` (for example `https://eus.codesigning.azure.net`),
`AZURE_SIGNING_ACCOUNT`, and `AZURE_SIGNING_PROFILE`. The workflow builds the sign command from
them rather than keeping it in `tauri.conf.json`, so a local build does not try to sign. Without
`AZURE_CLIENT_ID`, the release ships unsigned, the workflow logs a warning, and the release text
says the installer is unsigned.

Before each release, run the [keyboard checklist](#keyboard-checklist).

## Keyboard checklist

Run through this in a `pnpm tauri dev` session or the built app:

- Ctrl+F, Ctrl+R, and Ctrl+P reach the shell
- Alt+B and Alt+F, and Ctrl+Left and Ctrl+Right, move by word
- Ctrl+Shift+Arrow splits the focused pane on that side
- Shift+Enter sends a newline to Claude Code
- Esc reaches the shell or a running program
- copy (Ctrl+Shift+C, or Ctrl+C with a selection) and paste (Ctrl+V, Ctrl+Shift+V)
- resize a pane with Alt+Shift+Arrow
- Ctrl+Shift+F finds in scrollback, and Ctrl+click opens a link
- Ctrl+Shift+T, Ctrl+Shift+W, Ctrl+Tab, Ctrl+Shift+Tab, and Ctrl+Alt+1 through 9 work on tabs;
  confirm WebView2 does not take Ctrl+Tab
- Alt+Shift+T opens the shell picker
- Ctrl+Shift+S opens a scratch pad, and Ctrl+Enter in it sends to the tab's last terminal
- Ctrl+Shift+E opens a Files pane at the focused pane's repo root, or focuses the tab's existing
  one for that repo
- Ctrl+Shift+G opens a Git pane at the focused pane's repo root, or focuses the tab's
  existing one for that repo
- Ctrl+Shift+H opens a Search pane at the focused pane's repo root, and Enter in its query field
  runs the search
- Ctrl+Shift+X opens the focused pane's repo root in the preferred editor
- Ctrl+Shift+L opens the Launch menu over the focused pane, a letter chooses an entry, and the
  highlighted entry previews where its pane will open; confirm WebView2 does not take Ctrl+Shift+L
- Ctrl+Shift+Z zooms the focused pane, restores the layout on a second press, and does nothing
  in a tab with one pane
- Ctrl+=, Ctrl+numpad +, Ctrl+-, and Ctrl+0 change the text size; confirm WebView2 does not take
  Ctrl+=
- in the file preview editor (Files or Search), Ctrl+Z undoes, Ctrl+Y redoes, and Tab moves focus
  out; Ctrl+Shift+Z (pane zoom), Ctrl+Shift+F (find), Ctrl+S (save), and Ctrl+Shift+Left and
  Ctrl+Shift+Right (split) still reach the app
- in a Files list, Delete sends the selection to the Recycle Bin, and Ctrl+C, Ctrl+X, and Ctrl+V
  copy, cut, and paste files, including to and from File Explorer; Ctrl+C in the preview still
  copies text
- Ctrl+G in the file preview editor opens the Line field, and in a terminal running Claude Code
  it still opens the prompt in an external editor
- F6 moves focus into the dashboard (peeking it when hidden), the arrows and Enter work there,
  and F6 or Esc returns to the pane
- Ctrl+Shift+N jumps to the next waiting, done, or failed terminal
- Ctrl+Shift+D toggles the dashboard, and Ctrl+Shift+A pauses or resumes the background
  animation; confirm WebView2 does not take Ctrl+Shift+A
- F1 and Ctrl+, open the app dialog on Help and Settings, Ctrl+Tab and Ctrl+PageDown move
  between its tabs, and F1 again closes it; confirm WebView2 does not take Ctrl+PageUp or
  Ctrl+PageDown
- a right-click in a terminal shows no browser menu
- with a Local Browser page focused, typing and Ctrl+A reach the page, and Ctrl+Tab, Ctrl+Shift+Tab,
  Ctrl+, and the pane focus chords still act on the app

On Linux, the chords are the same; [Testing a Linux build](linux-testing.md#checks) (Keys) adds
what to check per desktop. On macOS, run the Keys checks in
[Testing a macOS preview build](macos-testing.md#checks) instead.

## Logs and crashes

On Windows, the installed app writes the core's diagnostics to `%LOCALAPPDATA%\dev.bashboard\logs\bashboard.log`
(the previous file, once it passes 1 MB, is `bashboard.old.log`); a debug build prints them to
the terminal that ran it instead. A WebView2 crash also leaves a minidump under
`%LOCALAPPDATA%\dev.bashboard\EBWebView\Crashpad\reports` (`dev\EBWebView` for a debug build),
and the `watson_metadata` file beside `reports` names the process type and module that failed.

The log also holds core panics (`panic on thread ...`), the page's uncaught errors (`page: ...`),
and the hung-page watchdog's actions.

On macOS and Linux there is no log file. Start the app from a terminal (`bashboard`, the
AppImage itself, or `/Applications/Bashboard.app/Contents/MacOS/bashboard`) to see the core's
output there.

To exercise crash recovery against a `pnpm tauri dev` run, end the `msedgewebview2.exe` that is
a direct child of `target\debug\bashboard.exe` (the window rebuilds), or its `--type=renderer`
child (the page reloads). The hung-page watchdog is off in debug builds; launch with
`BASHBOARD_WATCHDOG=1` and run `while (true) {}` in DevTools to see its dialog after 30 seconds.

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
