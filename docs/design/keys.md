# Key handling

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 4.5 Key handling

The custom key handler (`keys.ts`) runs before xterm.js. Any key it handles is swallowed for
keydown, keypress, and keyup alike, since xterm.js acts on the keypress that follows a keydown.

Each OS has its own defaults table, sharing one action list: `src/defaultKeybindings.json` for
Windows and Linux, `src/defaultKeybindings.macos.json` for macOS. The front end and the Rust
loader read the same files. The Windows table mirrors Windows Terminal and keeps app chords on
Ctrl+Shift and Alt+Shift, the corners of the Ctrl and Alt space the shell uses least. macOS has a
modifier the shell never sees, Cmd, so its table puts app actions on Cmd and follows Mac
convention (iTerm2's split and pane chords, Cmd+T, Cmd+1 to Cmd+9), leaving every Ctrl and
Option chord to the shell. Ctrl+Tab is the one Ctrl chord the macOS table keeps; the shell has no
use for it. The macOS table also stays off the chords its Edit menu and the system claim (Cmd+Z,
Cmd+Shift+Z, Cmd+X, Cmd+A, Cmd+Q, Cmd+H, Cmd+M), which is why zoom is Cmd+Shift+Enter there.

| Windows and Linux | macOS | Action | Name |
| --- | --- | --- | --- |
| Ctrl+Shift+Right | Cmd+D | Split right (duplicate) | `splitRight` |
| Ctrl+Shift+Down | Cmd+Shift+D | Split down (duplicate) | `splitDown` |
| Ctrl+Shift+Left | None | Split left (duplicate) | `splitLeft` |
| Ctrl+Shift+Up | None | Split up (duplicate) | `splitUp` |
| Alt+Shift+D | Cmd+Option+D | Split auto (duplicate) | `splitAuto` |
| Ctrl+W | Cmd+W | Close pane | `closePane` |
| Ctrl+Shift+M | Cmd+Shift+M | Collapse pane | `collapsePane` |
| Ctrl+Shift+Z | Cmd+Shift+Enter | Zoom or unzoom the focused pane (4.2) | `togglePaneZoom` |
| Ctrl+Shift+O | Cmd+Shift+O | Open a favorite (picker; Enter opens it as a split, Ctrl+Enter opens it collapsed) | `openFavorite` |
| Ctrl+Shift+R | Cmd+Shift+R | Open a named layout (picker; opens it as a new tab, 4.6) | `openLayout` |
| Ctrl+Shift+L | Cmd+Shift+L | Open the Launch menu over the focused pane (4.6) | `openLaunch` |
| Ctrl+Shift+P | Cmd+Shift+P | Open the command palette (below) | `openPalette` |
| Alt+Shift+T | Cmd+Option+T | Split with a chosen shell (picker of the available profiles; Enter opens a split, Ctrl+Enter opens it collapsed) | `splitWithProfile` |
| Ctrl+Shift+T | Cmd+T | New tab (4.10) | `newTab` |
| Ctrl+Shift+W | Cmd+Shift+W | Close tab | `closeTab` |
| Ctrl+Shift+S | Cmd+Shift+S | New scratch pad (4.15) | `newScratch` |
| Ctrl+Shift+E | Cmd+Shift+E | Files pane for the focused pane's repo (4.12) | `openFiles` |
| Ctrl+Shift+G | Cmd+Shift+G | Git pane for the focused pane's repo (4.13) | `openGit` |
| Ctrl+Shift+H | Cmd+Shift+H | Search pane for the focused pane's repo (4.14) | `openSearch` |
| Ctrl+Shift+X | Cmd+Shift+X | Open the focused pane's repo in the preferred editor, or its folder outside a repo (3.12) | `openEditor` |
| Ctrl+Tab, Ctrl+Shift+Tab | Cmd+Shift+], Cmd+Shift+[ (and Ctrl+Tab, Ctrl+Shift+Tab) | Next tab, previous tab (wrapping) | `nextTab`, `prevTab` |
| Ctrl+Alt+1 to Ctrl+Alt+8 | Cmd+1 to Cmd+8 | Switch to that tab | `switchToTab` |
| Ctrl+Alt+9 | Cmd+9 | Switch to the last tab | `switchToLastTab` |
| Alt+Arrow | Cmd+Option+Arrow | Move focus | `moveFocus` |
| Alt+Shift+Arrow | Cmd+Ctrl+Arrow | Resize pane | `resizePane` |
| Ctrl+Shift+F | Cmd+F | Find in scrollback, or in the file preview of a Files pane (4.12) | `find` |
| Ctrl+G | Cmd+L | Go to a line, or `line:column`, in the code view of a Files or Search pane (4.12); anywhere else the key goes to the shell, so Claude Code's Ctrl+G still opens its prompt in an editor | `goToLine` |
| Ctrl+C | Cmd+C | Copy if there's a selection, otherwise pass ^C | `copy` |
| Ctrl+Shift+C | None | Copy | `copy` |
| Ctrl+V, Ctrl+Shift+V | Cmd+V | Paste text (bracketed when the app enabled it); with no text on the clipboard, pass ^V so Claude Code can paste an image | `paste` |
| Shift+Enter | Shift+Enter | Send ESC+CR (Claude Code's newline) | `sendInput` |
| Ctrl+Shift+D | Cmd+B | Toggle dashboard panel | `toggleDashboard` |
| F6 | F6 | Move focus into the dashboard panel, or back to the focused pane (4.6) | `focusDashboard` |
| Ctrl+Shift+B | Cmd+Shift+B | Cycle backdrop scrim strength (saved to `scrim.opacity`) | `cycleScrim` |
| Ctrl+Shift+A | Cmd+Shift+A | Pause or resume the background animation of the active style (saved to `backdrop.animate`); does nothing under None | `toggleBackdrop` |
| Ctrl+Shift+N | Cmd+Shift+N | Focus the next terminal that needs you, across all tabs, else cycle the agent terminals (4.7) | `nextAttention` |
| Ctrl+= or Ctrl+Numpad+ | Cmd+= or Cmd+Numpad+ | Increase the text size by 1 px (saved to `font.size`; applies to terminals and pane text; 6 to 48 px) | `increaseFontSize` |
| Ctrl+- | Cmd+- | Decrease the text size by 1 px (saved to `font.size`; applies to terminals and pane text; 6 to 48 px) | `decreaseFontSize` |
| Ctrl+0 | Cmd+0 | Reset the text size to the default, 14 px (saved to `font.size`; applies to terminals and pane text) | `resetFontSize` |
| F1 | F1 | Open the app dialog on its Help tab (4.18) | `showHelp` |
| Ctrl+, | Cmd+, | Open the app dialog on its Settings tab | `openSettings` |
| F11 | Cmd+Ctrl+F | Toggle full screen | `toggleFullscreen` |

Four more actions have no default key: `showAccounts`, `showShortcuts`, `showCli`, and `showAbout`
open the app dialog on its Accounts, Shortcuts, CLI, and About tabs.

These are built-in defaults. Entries in the settings file (section 8) layer on top, as in
Windows Terminal: an entry for a chord that has a default replaces it, a new chord adds a
binding, and `"action": "unbound"` removes a default so the key reaches the shell.

A chord is spelled with `ctrl`, `alt`, `shift`, and `win` or `cmd` (the same Meta bit), plus
`option` and `opt` for `alt` and `command` for `cmd`. On macOS the Shortcuts tab writes `cmd` and
`option` and labels them Cmd and Option; elsewhere it writes `win` and `alt`.

**macOS.** The command modifier outside the keymap follows the OS as well: Cmd+S saves in the
text editor, Cmd+Enter commits, sends a scratch pad, and opens a favorite collapsed, and
Cmd+click opens a link or toggles a Files row (`primaryHeld` in `platform.ts`). Ctrl+click is a
right click on macOS, so none of these use Ctrl there. The menu bar (`mac_menu.rs`) replaces
Tauri's default menu. WKWebView offers a Cmd chord to the page before the menu, so a chord the
keymap handles never reaches a menu item; the Edit items are there because text fields get Cmd+C,
Cmd+V, Cmd+A, and Cmd+Z only through them. The menu has no Close Window item, so Cmd+W stays the
keymap's, and its Quit closes the main window rather than exiting, so the workspace saves first.

**Keybinding editor.** Keys are changed in the app dialog's Shortcuts tab (`shortcutsTab.ts`, 4.18), which lists every
action by section with its live chords. Every action in the name list has a row, including one
with no default. An action that takes an argument has one row per argument: Move focus and Resize
pane per direction, Go to tab 1 through 8. Each `sendInput` binding has its own row labeled by
its input (Shift+Enter reads "Claude Code newline"); a new `sendInput` binding is added in the
file, since it needs text the guide has no field for. "In pickers and bars" is read-only.

A row shows its chords as keycaps. `+` after the last keycap records another chord, a clicked
keycap records a replacement for that chord, its `x` removes it, and Reset, shown only while the
row differs from the defaults, restores the default chords. A row that differs has an accent dot
by its label, and a row with no chord reads "No key", dimmed. The filter field matches labels,
and Find by key records one chord and scrolls to the row that owns it, or says "Not bound:
reaches the shell".

Recording (`keybindingRecorder.ts`) listens for `keydown` in the capture phase, ahead of
`keys.ts`, so a bound chord is recorded instead of run. Modifiers alone keep it waiting; Escape
or a click elsewhere cancels. The pure rules in `keybindingEdit.ts` check each recorded chord:

| Chord | Result |
| --- | --- |
| A printable key with no modifier or with Shift alone; Escape, Enter, Tab, or Backspace with no modifier | Refused inline ("Shift+A would stop typing A"), still listening |
| Already on this action | "Already bound here", nothing changes |
| Unbound and not a shell key | Saved at once |
| Unbound, but the shell or Claude Code uses it | Saved at once, with a dimmed note under the row for as long as the binding stands |
| Bound to another action | The move strip |

The shell-key list (Ctrl+A, E, K, U, W, R, L, D, Ctrl+Left and Ctrl+Right, and a few more) gives
each key a few words on what it does in the shell, so the note under a row names the shell
feature the binding takes over (Ctrl+R: bash's reverse search). Only listed chords get a note,
and only when the row does not hold them by default.

When the recorded chord belongs to another action, the field holds it and a move strip
(`keybindingMoveStrip.ts`) opens under the row, naming the action that gives it up and adding "It
will have no key." when the move would leave that action empty. Enter moves, Escape cancels, and
a different chord records that one instead. A move is a single write. The other action's row
flashes once with the chord struck through, and a notice (`keybindingNotice.ts`) at the bottom of
the tab says where the chord moved from, with Undo and, when that action has no key left,
Assign a key, which scrolls to its row and starts recording there. The notice stays until the
next edit or 10 seconds. Undo is a single write that restores both rows. Reset on a row whose
default chord another action holds opens the strip for those chords (all of them when there are
several) as "Move it back?", and Cancel resets nothing. Reset all, in the footer, confirms and
then empties the `keybindings` array, with the same notice and Undo.

The tab never writes the merged keymap. It sends ops to `settings_keybindings_edit` (in
`settings/mod.rs`), which applies them to the raw `keybindings` array in settings.json under the
settings write lock:

| Op | Effect on the array |
| --- | --- |
| `bind` | Removes the entries for the chord, then adds `{ keys, action, ...args }` unless the default for the chord is exactly that |
| `unbind` | Removes the entries for the chord, then adds `"action": "unbound"` when the chord has a default |
| `reset` | Removes the entries for the chord |
| `resetAll` | Empties the array |

Chords match through `normalize_chord`, aliases included, so `Shift+Ctrl+L` in the file is the
entry for `ctrl+shift+l`. Entries the loader rejected and the order of the others are kept, so an
edit to one entry never deletes a typo in another. The array is written whole by
`set_array_lines` in `settings_edit.rs`, one entry per line; comments outside the array survive
and comments inside it are not kept. The tab does not update itself after a save: the watcher's
`settings://changed` rebuilds the keymap and re-renders the tab, as a hand edit does. A failed
save leaves the rows as they were and shows the error in the notice.

In panes other than terminals, copy, paste, Shift+Enter, Ctrl+Shift+F, Ctrl+G, and typing act
on the pane's own text fields as a browser would; every other action applies as it does in a
terminal. The Files pane is the exception for Ctrl+Shift+F, which opens its preview's find bar
(4.12). Ctrl+G (`goToLine`) acts only where a code view shows line numbers, in the Files and
Search previews; the workspace never handles it, so in a terminal, as with Ctrl+C and no
selection, the key reaches the shell.

**Command palette.** Ctrl+Shift+P (`openPalette`) opens one filterable list over every pane, tab,
favorite, layout, the focused repo's pins and worktrees, and every keymap action that makes sense
without a key context. Each row shows its category at the right edge. Enter behaves as the item's
own control does: a pane is focused (expanded first when collapsed), a tab is switched to, a
favorite opens as a split, a layout opens as a new tab, a pin opens as clicking it in the Pins
section does, a worktree opens a terminal there as a split, and an action runs as its key would.
Ctrl+Enter opens a favorite or worktree collapsed. Pins whose path is missing are left out.

Actions left out are `copy`, `paste`, `sendInput` (Claude Code's newline), `switchToTab` (tabs are
items instead), and `openPalette` itself. Labels come from `helpModel.ts`, so the palette and the
Shortcuts tab agree, and each action's hint lists its chords from the live keymap, so overrides show.
`moveFocus` and `resizePane` get one row per direction. Open the Containers tab (4.16), Open the
Ports tab (4.19), Open the Ship tab (4.20), and Check for updates (3.16) are action rows with no
keymap action behind them (`PALETTE_COMMANDS` in `paletteModel.ts`), so they never appear in the
Shortcuts tab or take a key. Open the Ship tab shows the first Ship pane in tab order, backed out
to its Overview (4.20) when it is drilled into a repo, and adds a Ship tab on the Overview when
there is none. It does not depend on the focused pane's repo.

Matching is fuzzy over the label, then the detail (a pane's tab name, a favorite's path), and a
detail-only match ranks after every label match. Consecutive characters and matches at word starts
score higher. With an empty query, the session's recent picks come first (most recent first, kept
in memory and not saved), then every row in category order. A leading `>` limits the list to
actions.

Choosing a row refocuses the pane that had focus before the palette opened, then runs the
choice, so actions such as split, find, and close apply to that pane.
