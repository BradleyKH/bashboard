# Testing a Linux build

The Linux port is early. The builds are meant for hand testing on a real machine with a real
desktop, since the parts that differ between distros (the keyring, notifications, Wayland, the GPU
driver, scaling) are the ones a container can't show. This page lists what to check and what to
send back.

Run these again on each new major release of a desktop (a new Plasma or GNOME), not only on new
Bashboard builds: notifications [16], window raise [32], keys [34], and the clipboard [37, 38]
lean on desktop interfaces that change between releases. Plasma 6 moved where KWin puts a loaded
script on the bus, for one, which broke the window raise until it was found this way.

## Report header

Fill this in first, and put it at the top of what you send back.

- Distro and version (`cat /etc/os-release`):
- Desktop and version (GNOME, KDE Plasma, Xfce, and so on):
- Session type, Wayland or X11 (`echo $XDG_SESSION_TYPE`):
- GPU and driver (`lspci -k | grep -A3 -E 'VGA|3D'`; for NVIDIA, proprietary or nouveau):
- Display size and scale factor:
- Install format used (AppImage, `.deb`, `.rpm`, or Arch package) and its file name:

## Builds

Each release carries the `.deb`, beside the Windows installer, on the
[latest release](https://github.com/BradleyKH/bashboard/releases/latest). The AppImage, `.rpm`, and
Arch package come from CI only: open the latest run of the CI workflow on `main` on GitHub, and download the
`bashboard-linux` artifact from the run's Artifacts list. That artifact also holds a `.deb` of
the unreleased code. Both workflows build on Ubuntu 22.04, so the packages run on anything with
that glibc or newer. The artifact holds four files:

- `bashboard_<version>_amd64.AppImage`
- `bashboard_<version>_amd64.deb`
- `bashboard-<version>-1.x86_64.rpm`
- `bashboard-<version>-1-x86_64.pkg.tar.zst`

## Install

Use the format that suits the distro, and say which one you used.

**AppImage** (any distro)

1. Make it executable and run it:

   ```sh
   chmod +x bashboard_*_amd64.AppImage
   ./bashboard_*_amd64.AppImage
   ```

2. It needs no `libfuse2`. If the AppImage fails to start on a distro without it, that is a
   finding.
3. The first time it runs, a toast offers to add Bashboard to your applications menu. Choose
   **Add**. `~/.local/share/applications/bashboard.desktop` now exists and Bashboard appears in
   the menu with its icon. The offer does not come back on the next launch.

**.deb** (Ubuntu, Kubuntu, Debian, Kali)

```sh
sudo apt install ./bashboard_*_amd64.deb
```

**.rpm** (Fedora, RHEL 10)

```sh
sudo dnf install ./bashboard-*.x86_64.rpm
```

On RHEL 10, run `sudo dnf install epel-release` first; the WebKitGTK package Bashboard depends on
comes from EPEL.

**Arch package** (Arch, CachyOS, Manjaro, EndeavourOS)

```sh
sudo pacman -U bashboard-*-x86_64.pkg.tar.zst
```

With the `.deb`, `.rpm`, or Arch package, the install pulls in WebKitGTK 4.1 and GTK 3 by itself.
Check the layout once the package is in:

```sh
readlink /usr/bin/bashboard   # ../lib/bashboard/bashboard
ls /usr/lib/bashboard         # bashboard and bb
ls /usr/bin/bb                # No such file or directory
```

## Not expected to work yet

- The Local Browser pane is hidden. Links from Ports, Containers, and terminal output open in
  your system browser.

## Checks

For each check, report pass or fail, plus what you saw if it failed.

**Launch**

1. Start Bashboard from the applications menu, not from a terminal. A launch from the menu is
   what checks that the app picks up your login shell's `PATH`. The window opens, and the
   background animation runs behind the panes.
2. The first pane is your login shell, and its prompt looks the same as in your terminal app.
   It runs as a login shell: in bash, `shopt login_shell` prints `on` (zsh:
   `[[ -o login ]] && echo login`; fish: `status is-login && echo login`).
3. Alt+Shift+T opens the shell picker. It lists your login shell, and also zsh, bash, and fish
   when installed and not already your login shell, plus any other shell in `/etc/shells` (install
   `nushell` and `nu` appears as Nushell). It does not list `sh`, `rbash`, `git-shell`, or
   `tmux`. The Default shell select in Settings, Terminal lists the same shells.
4. Quit, then start it from a terminal (`bashboard` for the packages, the file itself for the
   AppImage). It starts the same way.

**PATH, `bb`, and Claude Code**

5. `command -v bb` in a pane prints `/usr/lib/bashboard/bb` for the `.deb` and `.rpm`, or a path
   inside the AppImage's mount for the AppImage. In a terminal outside Bashboard, `command -v bb`
   does not find it (or finds a different program, such as Babashka).
6. `claude` starts Claude Code in a pane, and the dashboard lists that session.
7. Open the dashboard and choose **Install Claude Code hooks**. `~/.claude/settings.json` gains
   Bashboard's hook entries beside any you had. Give Claude a prompt that needs a permission:
   the pane's status turns to waiting while it asks, and back to done when it stops.
8. In a pane inside a git repo, Ctrl+Shift+G opens a Git pane that shows the repo's status. An
   error saying git was not found means the app didn't pick up your `PATH`.

**Shells**

9. For each of bash, zsh, and fish that is installed, open a pane with Alt+Shift+T. `cd` to
   another folder, then split the pane with Alt+Shift+D. The new pane opens in that folder. If it
   opens in your home folder instead, press F1 and look at that shell's integration row in the
   Setup list: it should read installed, or offer Install.
10. bash: on a distro whose first login file (`~/.bash_profile`, `~/.bash_login`, or `~/.profile`)
    does not read `~/.bashrc`, the setup wizard says so and leaves the fix to you. On Ubuntu and
    Debian it does not need anything.
11. fish, on CachyOS where it is the default shell: the first pane is fish, new panes open in the
    folder of the focused pane, and `~/.config/fish/conf.d/bashboard.fish` exists.

**Tokens**

12. On GNOME, with GNOME Keyring unlocked: in Settings, Accounts, add a Bitbucket token. Its card
    says the token is stored in the keyring, and **Test** reads it back. Quit and start Bashboard
    again; the card still shows a stored token. In Passwords and Keys (Seahorse) the item has
    the attributes `application bashboard`.
13. On KDE, with KWallet open: the same steps. The token appears in KWallet Manager.
14. In a pane, run `bb auth bitbucket` and enter a token. The desktop may ask to unlock the
    keyring. Then `bb auth bitbucket --clear` removes the token, and the Accounts card drops it.
15. On a login with no usable keyring (stop the keyring daemon, turn KWallet off in System
    Settings, or use a window manager session with none), the first **Save** in Accounts asks
    whether to keep tokens in a file. **Cancel** stores nothing. **Allow** stores the token in
    `~/.local/share/bashboard/credentials.json`, with mode `600` in a folder with mode `700`
    (`stat -c '%a %n' ~/.local/share/bashboard ~/.local/share/bashboard/credentials.json`), and
    the card says it is in a file. `bb auth bitbucket` then writes to the file too. Start the
    keyring again and choose **Move to keyring**; the token moves and leaves the file.

**Notifications**

16. Start `claude` in a pane, give it a prompt that needs a permission, and switch to another
    app before it asks. A notification appears with the pane's title, on GNOME and on KDE.
    Clicking it brings Bashboard forward with that pane focused. On Wayland, say whether the
    click raised the window or only flashed it.

**Media**

17. Play something in Spotify (from a `.deb`, Flatpak, or Snap) or in Firefox, then look at the
    dashboard. The Media section shows the title, the artist, and the album art, and the
    play/pause, previous, and next buttons control the player. Dragging the position bar seeks.
18. The volume bar and the mute button change the system volume (the panel's volume icon
    follows them), for a browser too. A volume key or the panel's slider moves the bar within a
    second.
19. Start a second player and pause the first. The section follows the one that is playing.
    `bb media play-pause` in a pane toggles it. Close every player; the section goes away.

**Editors**

20. With VS Code installed from Microsoft's `.deb`, the editor list in Settings, Editor shows
    it. Opening a search result opens the file at its line in VS Code.
21. With a JetBrains IDE installed through the Toolbox App, the same list shows it. If you have
    a Flatpak or Snap editor, check that too. The list also shows the desktop's own text editor
    (GNOME Text Editor, Kate, or Xed) and any terminal editor with a desktop entry (micro,
    Helix), each once, by its menu name; VS Code and a JetBrains IDE are not listed a second
    time under their menu names. Choose the desktop's editor and open a file from a Files pane:
    it opens there. Choose micro or Helix: the file opens in a new pane.

**Containers**

22. With Docker Engine installed and stopped (`sudo systemctl stop docker.socket docker`), the
    Containers pane shows Docker's heading with `sudo systemctl start docker` and a Copy button.
    Copy puts that command on the clipboard, and nothing starts by itself. The dashboard's row
    for it shows the same command in its tooltip. Run the command, and the containers appear.
23. With Docker Desktop for Linux or rootless Docker installed and stopped, the heading has a
    Start button, and it starts the engine. With Podman only, no engine heading appears.

**Setup and code hosts**

24. Press F1. The Setup list has a Git row reading Installed.
25. On a machine without git (a fresh VM, or after removing the package), the setup wizard's Git
    step shows your distro's install command (apt, dnf, pacman, zypper, or emerge) with Copy and
    Check again. Run the command in a terminal, choose Check again, and the wizard continues.

**Ports and orphans**

26. Run `python3 -m http.server 8765` in a pane. The Ports pane and the dashboard show port 8765
    tied to that pane, and Stop ends the server.
27. The Ports pane has no services checkbox on Linux, and ports held by system daemons (CUPS on
    631, systemd-resolved on 53) do not appear.
28. Run `(python3 -m http.server 8766 &)` in a pane. Its parent is gone, and the Ports pane still
    ties port 8766 to that pane. In a shell without Bashboard's integration lines (which report
    each command themselves, so a background job leaves the pane idle there), `(sleep 120 &)`
    keeps the pane's status working until the `sleep` exits.

**Disks and fonts**

29. In Settings, Dashboard, turn on System (under Ambient). Its drive list shows your root and home file systems
    once each, with no `/boot` or `/boot/efi`, no tmpfs, and no Snap or AppImage mounts.
30. The Font family field in Settings, Appearance suggests installed fonts, with monospace fonts
    such as DejaVu Sans Mono listed first.

**Desktop integration** (the `.deb`, the `.rpm`, or an AppImage after accepting the menu offer)

31. Bashboard is in the applications menu with its icon, under Development or System.
32. In Dolphin (KDE) or Nemo (Cinnamon), right-click a folder: **Open in Bashboard** opens it
    (a new window, or a new tab when Bashboard is already running). With Bashboard running behind
    the file manager, its window comes to the front; on KDE Wayland that goes through a KWin
    script, so if it stays behind, include the output of `journalctl --user | grep
    bashboard-raise`. Then check that Bashboard
    did not become the folder handler: `gio mime inode/directory` and `xdg-mime query default
    inode/directory` still name the file manager, and a browser's Show in folder opens the file
    manager, not Bashboard.
33. The running window groups under the Bashboard icon in the panel or dock, with that icon and
    name, not a generic one, and pinning it keeps working after a restart.

**Keys**

34. Run the keyboard checklist in [Development](development.md#releasing): its first list names the
    chords, which are the same Ctrl chords on Linux. Do it on each desktop you have. Note any
    chord the desktop takes before Bashboard sees it (for example Ctrl+Alt+digit or
    Ctrl+Alt+Arrow, which desktops often use for workspaces).
35. With IBus running (the default on GNOME, and often on KDE), Ctrl+Shift+E opens a Files pane.
    It does not open IBus's emoji picker.
36. For a chord that does nothing, set `BASHBOARD_KEYLOG` and start Bashboard from a terminal:

    ```sh
    BASHBOARD_KEYLOG=/tmp/keys.txt bashboard
    ```

    Press the chord in a pane. A line in `/tmp/keys.txt` means it reached the shell; no line means
    the desktop, IBus, or WebKit took it first.

**Files pane and clipboard**

37. In a Files pane, select a file and choose **Copy** from its menu (or Ctrl+C), then paste in
    the desktop's file manager. The file arrives. Copy a file in the file manager, and **Paste**
    in the Files pane (right-click the empty space below the rows) puts it in the folder. Do this
    on Wayland and on X11. On Wayland the clipboard goes through XWayland, so say which way each
    direction went.
38. Select text in a pane, then Ctrl+Shift+C copies it and Ctrl+V or Ctrl+Shift+V pastes it once
    (not twice).

**Rendering**

39. NVIDIA proprietary driver only: the window opens and draws. With the default
    `linux.disableDmabufRenderer` of `"auto"`, Bashboard turns the DMA-BUF renderer off by
    itself. If it opens blank, add `"linux": { "disableDmabufRenderer": "on" }` to
    `settings.json` (in `~/.config/dev.bashboard/`), start again, and report that it was needed.
    The setting has no field in the Settings tab.
40. On another GPU where the window opens blank, try the same setting, and report the GPU.
41. At each display scale you can set (100, 125, and 200 percent), box-drawing characters in a
    pane (run `tree` on a folder with subfolders, or open `htop`) join without gaps or doubled
    lines, and glyph edges look crisp rather than smeared. Check that the text size is
    the same as in your terminal app at that scale. Set the scale in System Settings or GNOME
    Settings, Displays, and restart Bashboard after each change.

**Crash recovery**

42. Open a few panes. Find the `WebKitWebProcess` that belongs to Bashboard (`pgrep -a
    WebKitWebProcess`, or the process list in System Monitor) and end it (`kill <pid>`). The
    window reloads, and every pane comes back with its shell still running.

**Updates**

43. `.deb` only. Install a `.deb` older than the latest release (an earlier release's, or the
    CI artifact from a commit before the latest release's version bump). At launch, or from
    **Check for updates** in the About tab, a banner offers the latest version. **Install and
    restart** downloads it, asks for your password (polkit, or a zenity or kdialog prompt),
    installs it, and restarts on the new version: the About tab shows it, and
    `dpkg -s bashboard | grep Version` agrees.
44. `.deb` only, same setup, launched from the applications menu: dismiss each password prompt.
    The banner says the update was not installed and offers **Try again** and **Download**, and
    the old version keeps running. (Launched from a terminal, the last fallback asks for your
    sudo password in that terminal instead.)
45. AppImage, `.rpm`, and Arch package: **Check for updates** says this install cannot update
    itself, pointing to the package manager or **Download**, which opens the latest release.

## Measurements

These need the WebKit inspector, and the packages from CI do not include it: they are built
without Bashboard's `devtools` feature, and the page turns off the browser right-click menu, so
there is no Inspect Element. There is also no frame-time readout in the app. Use a build that has
the inspector:

```sh
git clone https://github.com/BradleyKH/bashboard && cd bashboard
pnpm install
WEBKIT_INSPECTOR_SERVER=127.0.0.1:9223 pnpm tauri dev
```

Tauri's Linux build packages must be installed first (the `linux` job in
`.github/workflows/ci.yml` lists them). A dev run keeps its settings in
`~/.config/dev.bashboard/dev`, seeded from the installed app's on the first run.
`pnpm tauri build --features devtools` makes a release build with the feature. The environment
variable asks WebKitGTK to serve its inspector on that address. Open `inspector://127.0.0.1:9223`
in a WebKitGTK browser such as GNOME Web (Epiphany) or `MiniBrowser`, choose the Bashboard page,
and paste each snippet into the Console tab. If your WebKitGTK build offers no inspector, say so
in your report instead; the numbers are then not available from this machine.

Take every measurement on both Wayland and X11 (log out and pick the other session at the login
screen), and say which GPU drove the display.

**Frame time.** In Bashboard's Settings, set `backdrop.maxFps` to `0` (no cap). Run the snippet
with one pane (the backdrop alone), then again with eight terminal panes in one tab, which is
the most that use WebGL. Then run it with `scrim.blurPx` at `0` and at `20`, to show what the
scrim's blur costs. Set `backdrop.maxFps` back to `20` and `scrim.blurPx` back to where it was when
you're done.

```js
(() => {
  const gaps = [];
  let last = performance.now();
  const end = last + 5000;
  const tick = (now) => {
    gaps.push(now - last);
    last = now;
    if (now < end) return requestAnimationFrame(tick);
    gaps.sort((a, b) => a - b);
    const at = (q) => gaps[Math.floor(gaps.length * q)].toFixed(1);
    console.log(`frames ${gaps.length}, median ${at(0.5)} ms, p95 ${at(0.95)} ms`);
  };
  requestAnimationFrame(tick);
})();
```

**WebGL context limit.** Run this last: it takes the GPU contexts away from the background and the
panes, so quit and restart Bashboard afterward.

```js
(() => {
  const contexts = [];
  for (let i = 0; i < 64; i++) contexts.push(document.createElement('canvas').getContext('webgl2'));
  setTimeout(() => {
    const live = contexts.filter((gl) => gl && !gl.isContextLost()).length;
    console.log(`live WebGL contexts: ${live} of 64`);
  }, 1000);
})();
```

## What to send back

- The filled-in report header: distro and version, desktop, Wayland or X11, GPU and driver, and
  display scale. A report that runs on more than one desktop or session type names each.
- Which install format you used.
- Pass or fail for each check, with a screenshot of any failure.
- The keyboard checklist result, with any chord a desktop took. A Linux run records that result
  with the pre-release keyboard checklist in [Development](development.md#releasing).
- The frame-time lines for the backdrop alone and with eight terminals, on Wayland and on X11,
  and the WebGL context count. If you could not open the inspector, say that.
