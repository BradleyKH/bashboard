# Testing a macOS preview build

The macOS port is early. These builds are ad-hoc signed, not notarized, and meant for hand
testing only. This page lists what to check and what to send back.

## Install

1. Download `Bashboard_<version>_universal.dmg` (runs on every Mac) or `_aarch64.dmg` (Apple
   silicon only) from the `macos-preview-<commit>` prerelease on the GitHub releases page.
2. Open the `.dmg` and drag Bashboard to Applications.
3. In Terminal, run this once, since the build is not notarized:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Bashboard.app
   ```

4. Start Bashboard from Finder or the Dock, not from Terminal. A launch from Finder is what
   checks that the app picks up your shell's `PATH`.

## Not expected to work yet

- The Local Browser pane and the Git install step are hidden.
- Saved Forge sign-ins (Keychain), Listening ports, font lists, and editor detection are not
  implemented yet.

## Checks

For each check, report pass or fail, plus what you saw if it failed.

**Launch**

1. The window opens, and the background animation runs behind the panes.
2. The first pane is your login shell (usually zsh), and its prompt looks the same as in
   Terminal. `echo $0` prints `-zsh`, or your shell's name with a leading dash.
3. `command -v bb` prints a path inside `Bashboard.app`.
4. Alt+Shift+T opens the shell picker. It lists your login shell, and also zsh or bash when
   that shell isn't already your login shell.

**PATH and Claude Code**

5. `claude` starts Claude Code in a pane, and the dashboard lists that session.
6. In a pane inside a git repo, Cmd+Shift+G opens a Git pane that shows the repo's status.
   An error saying git was not found means the app didn't pick up your `PATH`.

**Keys**

7. Option+B and Option+F move back and forward by word at the shell prompt.
8. Ctrl+R starts reverse history search, Ctrl+A and Ctrl+E move to the start and end of
   the line, Ctrl+W deletes the previous word, and Ctrl+C interrupts a running command.
9. Select text in a pane, then Cmd+C copies it and Cmd+V pastes it once (not twice). Cmd+C,
   Cmd+V, Cmd+A, and Cmd+Z also work in a text field, such as the Settings tab's filter.
10. Cmd+T opens a tab, Cmd+D and Cmd+Shift+D split the pane, Cmd+Option+Arrow moves focus
    between panes, Cmd+W closes the pane (not the window), and Cmd+Shift+W closes the tab.
11. Cmd+1 and Cmd+2 switch tabs, and Cmd+Shift+] and Cmd+Shift+[ step through them.
12. Cmd+Shift+P opens the command palette, Cmd+, opens Settings, and Cmd+F opens find over a
    terminal.
13. Cmd+click on a link in terminal output opens it in your browser.
14. In Claude Code, Shift+Enter starts a new line and Esc interrupts.
15. Cmd+Q quits.

**Files and restore**

16. Right-click the empty space in a Files pane. Copy path copies a path that uses `/`, and
    "Open in File Explorer" (still the Windows label) opens the folder in Finder.
17. Make a layout with two tabs and a split, quit, and start the app again. The layout comes
    back.

**Notifications**

18. Start `claude` in a pane, give it a prompt that needs a permission, and switch to another
    app before it asks. A notification appears with the pane's title; macOS asks for permission
    the first time. Clicking it brings Bashboard forward with that pane focused.

## Measurements

These need Safari's Web Inspector. In Safari, turn on Settings, Advanced, "Show features for
web developers". Then, with Bashboard running, choose Develop, then your Mac's name, then
Bashboard. Paste each snippet into the Console tab.

**Frame time.** In Bashboard's Settings, set `backdrop.maxFps` to `0` (no cap). Run the
snippet with one pane, then again with six panes in one tab. Set `backdrop.maxFps` back to
`20` when you're done.

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

**WebGL context limit.** Run this last: it takes the GPU contexts away from the background
and the panes, so quit and restart Bashboard afterward.

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

- Your Mac's model, chip (Apple silicon or Intel), macOS version, and display (built-in
  Retina or external).
- Which `.dmg` you used.
- Pass or fail for each check, with a screenshot of any failure.
- The two frame-time lines and the WebGL context count.
