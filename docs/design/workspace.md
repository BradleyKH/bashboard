# Workspace, layout, and tabs

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 4.1 Layers

`index.html` stacks three fixed layers (section 2). The backdrop owns z0 and receives no pointer events;
it never reacts to clicks, drags, or scrolls meant for terminals. Terminals draw with a fully
transparent background (`allowTransparency`, theme background `#00000000`, and an override
of xterm.css's black viewport), so whatever is under them shows through.

There is one backdrop instance for the whole window. Terminals and tabs never get their own copy:
expanded terminals sit over it, collapsed ones and those in background tabs cost it nothing,
and creating or switching tabs neither resets nor interrupts it.

## 4.2 Pane layout

Each tab (4.10) arranges its expanded panes by its own binary split tree, which is empty when
every pane in the tab is collapsed (4.3). Only the active tab's tree is on screen. A leaf holds
a pane of any kind (4.11); this section says "terminal" where only terminals apply.

```ts
type Layout =
  | { kind: 'pane'; paneId: string }
  | { kind: 'split'; dir: 'row' | 'column'; ratio: number; a: Layout; b: Layout };
```

- Rendered as nested flex containers with a 4 px divider that can be dragged; ratios clamp so
  no pane drops below 20 columns by 5 rows.
- **Splitting** replaces the focused leaf with a split whose first child is the original pane.
  "Auto" picks `row` when the pane is wider than it is tall (in pixels), as Windows Terminal
  does.
- **Closing** closes the pane (killing a terminal's shell) and replaces the parent split with
  the surviving sibling. Closing a tab's last pane, expanded or collapsed, closes the tab, and
  closing the last tab closes the window. When every pane in the active tab is collapsed, the backdrop
  fills the window.
- **Docking.** Dragging a pane's title strip or a dashboard card over a pane shows five drop
  targets: each edge splits that pane in that direction with the dragged pane on that side,
  and the center swaps the two. A pane dragged from elsewhere in the tree leaves its old spot
  first, the same way closing does but without closing it. A collapsed card dropped on
  a center takes the target's place and collapses the target. A card from another tab docks the
  same way and moves its pane into the active tab; a tab left with no panes closes.
  Dragging a favorite or recent
  folder (4.6) shows the four edge targets only, since a folder has nothing to swap with; the
  drop opens a new terminal there.
- **Window-edge docking.** While anything dockable is dragged and the tab has at least one
  expanded pane, a 24 px band along each edge of the pane area is a fifth kind of target, drawn
  over the pane targets beneath it. Dropping there splits the root of the tree, so the dragged
  pane runs the full length of that edge and takes a third of the area, or more when a third
  would be under the minimum size. Drags use pointer events and begin after the pointer moves
  4 px, so a plain click still clicks and a finished drag does not also click its source. A drop
  that would leave a pane below the minimum size is refused with a toast.
- **Focus** follows click and the move-focus keys; the focused pane has a 1 px accent border
  and the others dim their cursor. Each tab remembers its own focused pane, and moving focus or
  resizing never leaves the active tab.
- **Zoom** (Ctrl+Shift+Z, or the title strip's zoom button) fills the tab's pane area with the
  focused pane, as Windows Terminal's pane zoom does, and the same again restores the layout.
  The tree is unchanged; the other panes leave the DOM as a background tab's do (4.10) and
  release their WebGL contexts. Zoom is per tab and is not saved. It ends before anything that
  changes the tab's tree (split, close, collapse, dock, expand, opening a pane into the tab) and
  before moving focus, which then moves as usual; resizing does nothing while zoomed. A tab with
  one expanded pane cannot zoom. While a hidden pane in the zoomed tab is marked for attention
  (4.7), the zoom button pulses.

**Duplicating the working directory.** A new pane or tab starts in the focused pane's current
directory, read from OSC 9;9 (what Windows Terminal uses) or OSC 7 sequences that xterm.js
handlers capture. Git Bash emits neither by default, so the `~/.bashrc` lines in
[setup.md](../setup.md#new-panes-in-the-current-folder) (installed by 3.14) emit OSC 9;9 along with
the OSC 133 command markers terminal status uses (4.8). Without them, new panes start in the home
directory. Only a drive-letter path is taken from OSC 9;9, as OSC 7 already requires: any program's
output can send one, and the folder is probed on disk as it arrives, so a UNC path would have
Windows authenticate to that host over SMB. A pane in a network share keeps its last local folder.

## 4.3 Collapsing

A terminal is one pty plus its xterm instance, and belongs to one tab. Expanded, it occupies a
leaf of its tab's layout; collapsed, it leaves the tree and appears only as a card in the
dashboard panel (4.6). Its pty keeps running and its xterm instance stays alive off the DOM, so
output keeps arriving and the scrollback is intact when it comes back. Terminals in a tab that
is not active are off the DOM in the same way, expanded or not.

- **Collapse** (Ctrl+Shift+M, or the title strip's button) removes the leaf the same way
  closing does, without killing the terminal; focus moves to the sibling.
- **Expand** (clicking the card) switches to the card's tab if it is not active, then splits
  that tab's focused pane in the auto direction with the terminal as the new side, or fills the
  window when the layout is empty. When the focused pane has no room to split, a toast says so
  and the terminal stays collapsed. Dragging the card docks it anywhere in the active tab
  instead (4.2).
- The pty keeps its last size while collapsed, and the terminal is refit when it expands.
- A collapsed terminal releases its WebGL context (4.4).

## 4.9 Restore

The front end saves the workspace (3.7, shape in section 7) one second after any change to the
tabs, layouts, collapsed terminals, working directories, session bindings, or a terminal's pty,
and again when the window closes. On launch:

- A saved terminal whose `pty` the core still runs (after a page reload or a rebuilt window,
  3.22) reattaches to it (3.1): the replayed output is written with the terminal's input,
  bells, and command events muted, since xterm.js answers queries in old output and those
  answers must not reach the shell, then the terminal resizes one column narrower and back,
  which makes ConPTY redraw the screen and repairs anything the replay could not, such as a
  full-screen program whose mode switch fell outside it. A reattached terminal skips its saved
  scrollback and its resume command, since its shell and any agent in it are still running.
- Every other saved terminal gets a new shell of its saved profile (the default profile when
  none is saved or the profile is unavailable) in its saved directory, or in
  `startingDirectory` if that folder is missing. Each tab's layout and collapsed terminals are rebuilt around the new
  pane ids, the tabs keep their order and names, the same tab is active, and each tab's focus
  returns to the same terminal.
- A terminal that had a live agent session bound when last saved gets its agent's resume command
  typed into it once its shell is ready (the first OSC 133 `A`, or the first output when the
  markers are absent), so the command shows in the terminal and in history like any other. The
  saved pane records the session's `agent`, and `resumeCommand` in `savedWorkspace.ts` builds
  the command:

  | Agent | Command |
  | --- | --- |
  | Claude Code | `claude --resume <sessionId>`, plus `--permission-mode <mode>` when the saved mode is anything but `default` |
  | Codex | `codex resume <sessionId>` |
  | Copilot | `copilot --resume <sessionId> --model <model>`, the `--model` part when a model is saved |

  Claude's mode is the one the session's newest hook event reported, so a change made with
  Shift+Tab after that event is not saved. Copilot's id and model are space-separated because
  `--resume=<id>` exits at once on Windows, and the model is passed back because a resumed
  Copilot session otherwise falls back to the default model. The session id and model are held to
  a safe character set, since they are typed into a shell.
- Each terminal's scrollback is saved as the window closes, and once a minute in between: xterm.js's serialize addon writes
  the normal buffer as escape sequences, leaving out terminal modes (so a replay cannot turn on
  mouse reporting or bracketed paste) and the alternate buffer. On launch the saved text is
  written into the terminal before its shell spawns, followed by a gray "restored scrollback"
  rule, so the new prompt (and any resumed Claude session) appears below it. Container shells
  and terminals opened from a layout start empty. The periodic save (`src/scrollbackAutosave.ts`)
  covers a core that dies without closing: each pass serializes only the terminals that had
  output since the last one, one at a time when the page is idle, and writes each with
  `scrollback_save`. The close-time save stays the one that removes stale files.
- A saved pane that cannot be rebuilt (its constructor throws) does not stop the rest of the
  restore: it is logged (3.22), a toast names its kind, and a terminal opens in its place, in
  the pane's folder when it had one and reattached to its pty when it named a live one.
- A missing or empty workspace opens one tab with one terminal in `startingDirectory`. Closing
  the last tab saves an empty workspace, so the next launch starts fresh.

`restore.enabled`, `restore.resumeSessions`, and `restore.scrollback` (section 8) turn each part
off. `restore.resumeSessions` covers every agent; a settings file that holds the older
`restore.resumeClaude` key and no `restore.resumeSessions` supplies the value from it. With `restore.scrollback` off, closing saves no scrollback and deletes what was saved, and the periodic save does not run.

Opening a named layout (4.6) rebuilds one tab the same way, appended as a new tab with the
layout's terminals in their saved directories and profiles. Session ids are always null in a
layout, so no agent session is resumed.

## 4.10 Tabs

A tab is a named group of panes (4.11) with its own split tree (4.2), focused pane, and
collapsed panes (4.3). Every pane belongs to exactly one tab. The window always has at least one
tab; the one on screen is the active tab.

**Tab strip.** With two or more tabs, a 28 px strip runs along the top of the window above the
panes, which reflow to make room; with one tab there is no strip, so a single-tab window looks
the same as a window without tabs. Each tab shows a status dot for the most urgent of its
terminals (`waiting`, then `failed`, then `done`, then `working`, then `idle`), its name, and a
close button on hover. The tab's tooltip lists each waiting terminal's title and reason (3.3). A
"+" at the end of the strip opens a new tab.

- Clicking a tab switches to it. Double-clicking its name renames it inline; Enter or blur
  saves, Esc cancels. Tabs reorder by drag, and the dashboard's groups follow.
- Holding a dragged pane, card, or path (4.4) over a tab for half a second switches to that tab,
  so the drag can continue into a dock target there (4.2) and move the terminal across tabs, or
  into a terminal there to drop the path.
- Dropping a pane's title strip or card on the strip past its last tab (the "+" and the empty
  space after it, highlighted while the pane is over it) moves the pane into a new tab, as the
  title strip menu's Move to new tab does: the new tab is appended and made active, and holds
  only that pane, expanded and focused. A pane alone in its tab is not offered this target, since
  the move would only trade its tab for a new one. With one tab the strip is hidden, so the menu
  item is the only way. A favorite or recent folder (4.6) dropped there opens a new tab with a
  terminal in that folder, as New tab does.
- The strip is chrome on z2 and draws over the backdrop with the same scrim as the title strips.
- **Menus.** A right-click on a tab offers Rename, New tab, and Close tab, each as the tab's own
  gesture does; a tab being renamed offers its input's text field menu instead. A right-click on
  the strip outside any tab offers New tab.

**New tab** (Ctrl+Shift+T or the "+"): appends a tab with one terminal of the default profile in
the focused pane's working directory (4.2), and makes it active.

**Switching** (click, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Alt+digit, or the dashboard): the
outgoing tab's terminals leave the DOM the way collapsed terminals do (4.3), keeping their ptys
and scrollback and releasing their WebGL contexts. The incoming tab's layout is rendered and its
terminals are refit, take WebGL contexts as the budget allows (4.4), and focus returns to the
tab's focused pane. The backdrop keeps running throughout; switching tabs does not touch it.
With `tabTransition` on, the switch and New tab animate (4.30).

**Closing a tab** (Ctrl+Shift+W, or its close button) kills all of its terminals. When any of
them has a running command or a live Claude session, a confirm dialog lists them first and
nothing changes if it is declined. Closing a tab activates its right neighbor, or its left one
when it was last. Closing the last tab closes the window.

**Names.** A new tab takes its name from its focused pane's title (the bound session's name or
the working directory's last folder, 4.4) and follows it as focus and folders change. Renaming
the tab fixes its name; renaming it to an empty string returns it to following the focused
pane. A tab opened from a layout starts with the layout's name, fixed.

## 4.30 Tab transition and background tabs

**Tab transition** (`tabTransition`, on by default). Switching tabs or opening a new one plays a
depth swap: the outgoing panes recede (scale 0.93, 6 px blur, fade out, 240 ms) and the incoming
panes rise through the same depth to rest (320 ms, starting 60 ms in). Under reduced motion both
legs are a 150 ms crossfade. The motion lives in `tabTransitionModel.ts`; `tabTransition.ts`
plays it.

- The outgoing hosts leave the DOM as soon as the switch renders (4.10), so they recede as
  ghosts: deep clones taken just before the switch, placed at their window rects in `#drift`, a
  fixed layer under `#panes` that takes no pointer events. A clone's canvases come out blank, so
  each 2D canvas is redrawn from its source. A WebGL terminal's canvas cannot be read once
  composited, so its visible rows are drawn from the buffer instead (`terminalSnapshot.ts`, with
  colors resolved through the theme in `terminalSnapshotModel.ts`); a DOM-renderer terminal's
  rows come with the clone. Iframes are replaced with empty boxes so no page reloads, ids are
  stripped, scroll offsets are copied, and the ghost is inert.
- The incoming hosts animate in place with transforms, opacity, and a filter only. None of those
  change a host's layout size, so no terminal refits and no pty resizes mid-animation; the
  terminals refit and take WebGL as usual when the switch renders.
- A switch during a transition ends it first: ghosts are dropped and the incoming panes snap to
  rest before the new ghosts are captured. While the window is hidden the switch is instant.
- Rects read during the rise are scaled, so the drag overlay rereads them when the transition
  settles.

**Background tabs** (`showBackgroundTabs`, off by default). The active tab's panes keep their
split-tree layout, while every other tab drifts behind them as a loose cluster of its panes in
`#drift`, over whichever backdrop style is mounted (section 6) or none. The
`toggleBackgroundTabs` action (4.5, no default key) turns it on or off and saves the setting.
Geometry and motion live in `backgroundTabsModel.ts`; `backgroundTabsLayer.ts` draws the
clusters.

- **Homes.** Every tab, the active one included, has a home on an ellipse that nearly touches
  the pane area's edges, starting at the top left and running clockwise in tab order. The home
  sets where the cluster's drift is measured from; a cluster is drawn wherever its drift has
  carried it. A cluster is the
  tab's split tree at 30% of the pane area, shrinking by 2% per tab past three down to 16%, with
  a 6 px gap between its panes. A tab whose panes are all collapsed shows them in a row; a tab
  with no panes has no cluster.
- **Pictures.** Background panes are not live. A terminal is drawn from its buffer
  (`drawTerminalInto` in `terminalSnapshot.ts`) every 250 ms while it has new output, at most
  six per pass in turn, and not while the window is hidden. Rows under 7 px tall are drawn as
  runs of ink in each run's color rather than glyphs. Other kinds show a card with their kind's
  icon and the pane's title. Clusters take no pointer events.
- **Dimming.** Each cluster's panes take the scrim's `--backdrop-brightness` (times 0.9) and
  `--backdrop-blur`, and the cluster's opacity is 0.75, so the drifting panes sit with the
  backdrop and stay under the readability bar of section 5. The filter sits inside the drifting
  element, so the compositor moves an already filtered layer.
- **Drift.** Each cluster floats across the pane area on a Lissajous loop that spans 80% of the
  room it has on each axis, so clusters pass behind the active panes and each other. The axis
  frequencies (1:2, 1:3, or 2:3), phases, and loop length (90 to 150 s) come from a hash of the
  tab id, so neighbors take different paths. A cluster's place in its loop follows the clock, so
  a tab that returns to the background picks its path up where it would have been. A change to
  the pane area or the tab count replans the loop. Reduced motion holds them still at home.
- **Depth.** A cluster with a pane that needs you (4.7) or a waiting terminal comes forward
  (scale 1.1, opacity 1, drawn over the others); one whose terminals are all idle sinks back
  (scale 0.92, opacity 0.55). Depth changes ease over 1.6 s.
- **Switching** is the tab transition with different paths: each incoming pane rises from where
  its cluster drew it (380 ms) and each outgoing ghost shrinks into its spot in its tab's cluster
  (360 ms), which stays hidden until the ghosts land and then takes their place. Panes with no
  cluster spot, such as a new tab's first pane, use the depth swap. Under reduced motion it is
  the crossfade.

## 4.11 Pane kinds

Every leaf of a tab's split tree is a pane of one kind:

| Kind | Content | Section |
| --- | --- | --- |
| `terminal` | A shell | 4.4 |
| `files` | A folder's files beside a preview of the selected one | 4.12 |
| `git` | A repo's changes, staging, commits, and diffs | 4.13 |
| `ship` | The Overview of pinned repos, and one repo's CI runs and open pull requests from its code host | 4.20 |
| `search` | Code search over a repo | 4.14 |
| `scratch` | A plain text scratch pad | 4.15 |
| `containers` | Docker and Podman containers grouped by Compose project | 4.16 |
| `ports` | Listening TCP ports, their processes, and the panes that started them | 4.19 |
| `browser` | A dev server's page on localhost, with a Console and Network drawer | 4.21 |

Every kind but `scratch`, `containers`, `ports`, and `browser` has a folder: a terminal's working directory, or the
folder another pane was opened for. A pane's repo is the repo (3.8) of its folder.

- **Ids.** Pane ids come from a front-end counter: `p<n>` for terminals and `v<n>` for other
  kinds. A terminal's pty id (3.1) is separate.
- **Kind menu.** The first control in the title strip shows the pane's kind as an icon.
  Clicking it lists the kinds, Terminal first and the rest alphabetical by label, and choosing
  one replaces the pane in place: same spot in the tree, same folder. A pane with no folder passes on the Launch section's repo (4.6), except for
  Ship, which opens on the Overview (4.20) rather than on that repo. Replacing a
  terminal with a running command or a live Claude session asks first, as closing it does, and
  so does replacing a scratch pad that is not empty. A terminal chosen from the menu runs the
  default profile. The menu lists Containers only while a container engine is available (3.10),
  whatever `dashboard.sections.containers` says. It is drawn by the shared context menu module (4.4)
  below the button, with the current kind checked; choosing the current kind does nothing. The
  title strip's right-click menu offers the same entries as its Change kind submenu.
- **Opening.** Ctrl+Shift+S, E, G, and H (4.5), Launch, and the Open menu on dashboard
  rows (4.6) open a pane as a split of the focused pane, the way a favorite does: when there is
  no room, a toast says so and the pane opens collapsed. A Git pane for a repo that already has
  one in the active tab focuses that one instead.
- **Common behavior.** Every kind has the title strip, focus border, docking, collapsing,
  and closing that terminals have. Status, attention, and the WebGL budget apply to terminals
  only. A tab's status dot comes from its terminals; its name follows the focused pane's title,
  which for other kinds is the folder's name, a scratch pad's first line, "Containers", or "Ports".
- **Restore.** Each kind saves its state with the workspace (section 7): a Files pane's folder,
  selected file, sort, and whether its preview is expanded (4.12), a Git pane's repo and tab, a Ship pane's repo and tab (or the Overview), a Search pane's
  repo, query, and options (rerun on restore), and a scratch pad's text. A pane whose folder no
  longer exists opens on a notice naming the path, with the kind menu still available. A Files
  pane restored expanded over a file that is missing or cannot be previewed as text shows its list.
- **Layouts** save every kind. Scratch pads are saved empty, so a layout opens fresh pads.
