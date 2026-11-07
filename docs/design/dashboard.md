# Dashboard panel

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 4.6 Dashboard panel

A collapsible panel docked on the side `dashboard.side` names (`right` by default, or `left`;
an unknown value falls back to `right` with a warning), open on start by default, toggled with
Ctrl+Shift+D, hidden by the × button at the right end of its top bar (which also ends a peek),
and peeking open briefly while hidden when a terminal starts waiting. The first time it is hidden
with ×, a toast names the toggle's current keys and the edge handle; `dashboardHideNoticeShown`
in the saved workspace (section 8) keeps it from repeating. While the panel is neither open nor
peeking, the edge handle, a pill in the 8 px gutter on the panel's side at mid-height that widens
to a chevron on hover, opens it on click, so a user who never learned the shortcut is not stranded. Open, it narrows the panes
from its side. Dragging its inner edge (its left edge when docked right, its right edge when
docked left) resizes it, from 280 px (enough for the top bar and the Launch row each on
one line) up to 60% of the window, and the width is saved with the workspace (section 7); it is
the same width on either side. Its contents, top to bottom, are the top bar, the top slot, Pins,
the lower list, and the footer. Pins, which follow the focused pane and appear and vanish with
it, sit fixed below whatever elements are in the top slot; the lower list and the footer sit at
the bottom, so a focus change never shifts them.

**Columns.** Wide enough, the panel shows two columns side by side under the top bar, which alone
spans both. Each column has its own top slot and its own lower list, laid out as above, and scrolls
on its own; a thin rule separates them. The width alone decides: the panel switches to two columns
once it reaches 600 px and back to one below 568 px, so dragging slowly across the threshold
never flickers between the two. The columns are the same on either side, the left column always
on the left. Each element belongs to one column, in either slot. Pins belong to one column too,
always last in its top slot, and the footer sits at the bottom of the left column. In one column,
the panel shows the left column's top slot, then the right column's top slot, Pins, the left
column's lower list, and the right column's lower list, so the split between top slot and lower
list survives. Elements first go to two columns the first time the panel is that wide: Clock,
Wave, System, Local AI models, Containers, and Ports to the right column, and the rest, with
Pins, to the left; until then every element is in the left column. A column's scrollbar shows only
while the pointer or keyboard focus is in it. Keyboard rows run down the left column, then the
right.

**Top bar.** One line that stays at the panel's top edge while the panel scrolls. On the left,
a Favorites button shows while the Favorites element is disabled and a Layouts button while
Layouts is, each dropping the picker its shortcut opens (Ctrl+Shift+O and Ctrl+Shift+R, 4.5) as a
menu under the button: it filters as you type, Enter opens the selection and Ctrl+Enter opens a
favorite collapsed, and Escape closes it, handing focus back to the button when the keyboard
opened it. Beside the filter, the Favorites menu has a "+ Add" button that adds the focused
terminal's folder as the section's "+" does, disabled when there is none or it is already a
favorite, and the Layouts menu has a "+ Save" button that turns the filter into a name field: a
single row previews "Save as" or, for an existing name in any capitalization, "Replace", Enter
saves, and Escape returns to the filter. The pickers have these buttons however they open, from the
top bar or from their shortcuts. Renaming, removing, and reordering stay with the sections. After
them come icon buttons for Settings (⚙, also bound to Ctrl+,) and Help (?, also bound to F1),
which open the app dialog (4.18) on those tabs. The × that hides the
panel sits alone at the right end. Each button's tooltip ends with its action's current keys in
parentheses, read on hover so a rebinding shows, and leaves them out when the action is unbound.

**Elements.** The elements are Clock, Launch, Favorites, Layouts, Panes, Containers, Ports, Ship,
Local AI models, External sessions, System, and Wave, in that default order; Clock and Launch start in the top slot and the rest
in the lower list. Each has a `dashboard.sections.*` toggle (section 8), on by default except
Favorites, Layouts, System, Wave, and Clock (Favorites and Layouts start as top bar menus, and Launch becomes one when disabled), set from the settings
dialog's Dashboard section or from the panel's own right-click menu, which opens anywhere on the
panel no row's menu claims and lists every element with a check on the shown ones; choosing one
flips its toggle. A disabled element is gone from the panel, not collapsed, and its
rows leave the keyboard rows below. Toggles and `dashboard.side` apply live, and switching
sides while a peek is showing ends the peek.

Clicking a section's header collapses or expands it, and which sections are collapsed is saved
with the workspace (section 7). A thin rule separates each element from the one above it, and
the top slot from Pins below it.

**Order.** The elements reorder by drag: a section by its header, the clock and Wave by grabbing
anywhere on them, with the same movement threshold as favorite rows, so a click on a header still
collapses or expands it. While dragging, a line in the accent color shows where the element
will land, at whichever gap is nearest the pointer in the column under it; Pins and the footer
offer no drop position. Any element can be dropped in the top slot above Pins or the lower list
below it, in either column, and each slot keeps its own order. In one column, a dropped element
joins the column of the shown element just above where it lands in its slot, or just below it at
the slot's top edge, and keeps its own column in an otherwise empty slot or when dropped where it
already was. In two columns, Pins drag by their header to the end of either column's top slot;
in one column they do not drag. Dragging is mouse only. The order is saved with the workspace as
`dashboardSectionOrder`, which elements are in the top slot as `dashboardTopElements`, which are
in the right column as `dashboardRightElements`, and the column holding Pins as
`dashboardPinsColumn` (section 7). A disabled element keeps its place in the order, its slot,
and its column, so enabling it returns it where it was.

**Clock.** One line with no header, no collapse, and no keyboard row. On the left is a binary
grid of three rows of six rounded-square dots: hours (24-hour) on top, then minutes, then
seconds, most significant bit on the left, lit dots in the accent color and unlit dots muted.
The grid is as tall as the time's digits, so the digit height sets each dot's size. On the right is the time as
`h:mm` in 12-hour time with no am/pm and no leading zero on the hour, in white with tabular
numerals. `dashboard.clockStyle` (section 8) shows both, the time only (`time`), or the grid
only (`binary`), applying live. Right-clicking the clock opens its own menu: the three styles
as radio choices (Binary and time, Time only, Binary only), then Hide clock, each saving its
setting. The line is at most 60 px tall and shrinks with the panel's width through a container
query unit on the clock element, so the grid and time stay on one line down to the 280 px
minimum. Its accessible name is the full time with AM or PM. It updates on each second
boundary only while the panel is on screen and the window is shown, catching up at once on
show, and no timer runs while it is disabled.

**Wave.** A looping line (a Lissajous figure turning in 3D) 56 px tall across the panel's width,
with no header, no collapse, and no keyboard row. CPU load climbs a ladder of figures whose
frequency ratios gain a lobe at each step (1:2, 3:2, 3:4, 5:4), evenly spaced from a calm figure
eight when idle to a modest weave at full load; between two steps both figures draw whole and
split the line's opacity. A detune added to each step's horizontal frequency sweeps between 0 and
0.6 and back, easing at each end; while it is above 0 the figure never quite closes, and its two
loose ends keep it lopsided. Memory use sets the sweep's pace: one sweep takes 5 s divided by the
share of memory in use, so 20 s at 25% and 5 s when full, never slower than about a minute.
The flat figure gains a depth wave at its vertical frequency, spins about the vertical axis, and
tilts about the horizontal one, drawn in perspective with the near side brighter and thicker.
The tilt turns one way forever, a full turn every 30 s. Combined network traffic, on a log scale
that tops out at 10 MB/s, speeds the spin, which also turns the horizontal phase. One faint copy a
little earlier in the spin gives the line an echo. The figure is scaled to stay inside its box:
it shrinks at once when a line would cross an edge and regrows over a few seconds, so the zoom
holds steady through the spin.
CPU, memory, and network ease toward each new reading over about 1.5 s, so the figure morphs
rather than jumps. It samples `system_sample` every 2 s and draws at most 20 frames a second on a
small 2D canvas, only while it is enabled, the panel is on screen, and the window is shown. It
keeps moving with `backdrop.animate` off; with reduced motion requested, it holds a still figure
redrawn on each sample. Its tooltip and accessible name give the CPU, memory, and network
readings.

**Polling.** System, shown by `dashboard.sections.system`, polls the core on timers, and each
timer runs only while the section is enabled, expanded, and on screen (the panel open or peeking) and the window is shown.
Any of those ending stops the timer, and the next start samples at once, so the section is never
staler than one interval after it reappears. Collapsed or disabled, it costs nothing.
`PollTimer` (`pollTimer.ts`) holds the rule.

**System.** Machine load in four rows, each a label, a value, and a thin bar or sparkline:

| Row | Shows | Source | Interval |
| --- | --- | --- | --- |
| CPU | Total use as a percentage, with a 60 second sparkline | `sysinfo` CPU refresh | 2 s |
| Memory | Used of total, as "21.4 / 32 GB", with a bar | `sysinfo` memory refresh | 2 s |
| Network | Receive and send rates across all adapters, as "↓ 1.2 MB/s ↑ 40 KB/s", with 60 second sparklines for each side by side | `sysinfo` networks, loopback and virtual adapters excluded | 2 s |
| Disk | Free space on each fixed drive, as "C: 112 GB free", with a bar of used space | `sysinfo` disks, fixed drives only | 60 s |

Bars use the accent color, turning to the warning color at 80% and the error color at 90%; the
sparklines stay in the accent color. Each sparkline spans the row's full width (the network pair
splits it, download on the left), and its canvas tracks its box at device-pixel resolution. CPU
plots against 0 to 100%; each network line scales to the busiest reading on screen, never below
256 KB/s, so idle traffic stays near the baseline. Several fixed drives each take a line under Disk. Values use
tabular numerals so the rows do not shift as they change. The rows are not keyboard rows; the
section's header is. The first sample after a start shows memory and disk at once and fills in
CPU and network on the second, since both are deltas between two refreshes; they read `-` until
then, and every row reads `-` when the core cannot be reached. GPU utilization and Wi-Fi name and
signal are not shown: Windows offers GPU load only through costly counters or vendor libraries,
and the Wi-Fi values need the WLAN API for little benefit. `system_sample(includeDisks)` returns
the rows; the front end passes `includeDisks` on its 60 second beat.

Hovering the CPU or Memory row for a moment opens a popup of the six busiest programs by that
measure. Processes are grouped by executable name (`.exe` dropped, case ignored), so a browser's
dozens of processes read as one line with a `×24` count. CPU is each group's share of the whole
machine, on the same scale as the row; memory is the group's summed working sets, which counts
pages shared between its processes more than once. `system_top_processes(limit)` returns both
lists; the popup asks on opening and every 2 s while open, and nothing reads processes otherwise.
Per-process CPU is a delta like the machine's, so when the last process read is more than 5 s
old the command reads twice, 200 ms apart, and the first popup already shows CPU. The popup takes
no pointer events and closes when the pointer leaves the row or the section stops polling.

**Keyboard.** F6 moves focus into the panel, onto the row focused there last, else the focused
pane's card, else the first row; F6 again, or Escape, returns focus to the focused pane. While the
panel is hidden, F6 shows it as a peek that lasts until focus leaves it, instead of timing out.
The rows are the top bar's buttons, every section header, the Launch section's
buttons, every favorite, recent folder, layout, pin, container, tab group header, pane card, and
external session, and the footer's button, top to bottom, skipping collapsed and disabled
sections:

- Up and Down move one row, stopping at the ends; Home and End go to the first and last.
- Enter or Space acts as a click on the row, and Ctrl+Enter as a Ctrl+click.
- F2 on a favorite, layout, pin (one whose target exists), or tab group header opens the rename
  field its button, double-click, or menu opens. Enter saves and Escape cancels, both returning focus to the row;
  leaving the field saves, as it does for a mouse rename.
- Left on a row goes to its section's header, and on an expanded header collapses the section.
  Right on a collapsed header expands it, and on an expanded one goes to its first row.
- Tab reaches the buttons inside rows (folder, Open menu, close, remove), which show while their
  row has focus as they do on hover.
- Any other key runs its workspace action (4.5), as it would in a pane.

Only the keyboard focuses rows: the panel keeps mouse presses from taking focus off the pane, so
a focus ring in the panel always means keyboard focus. When the panel rebuilds its rows (a status
change, the 15 second age refresh), focus moves to the rebuilt row, or to the row now in its place
when it is gone.

Folder paths under row labels show the home folder as `~`, and an overlong path is cut from the
left so its last folders stay visible; hovering shows the full path.

Every favorite, recent folder, pane card, and external session row shows a folder button on
hover that opens its folder in File Explorer (`open_folder`, which accepts only an existing
absolute directory). Beside it, an Open menu lists Terminal, Files, Git, Search, and Editor,
each opening for that row's repo (4.11); Git is listed only for a git repo.

**Row menus.** Right-clicking a row opens a menu of the actions its buttons offer (4.4 describes
the shared module). "The Open entries" below are the Open menu's, listed first, with Git only for
a git repo; "Explorer" is Open in File Explorer.

| Row | Items |
| --- | --- |
| Pane card | Focus, Collapse or Expand; for a pane with a folder, the Open entries, Explorer, and Copy path; Close (asking as its button does) |
| External session | The Open entries, Explorer, and Copy path (when the session has a cwd); Copy cwd and Copy session id, offered whether or not the row is expanded |
| Favorite | The Open entries, Explorer, Copy path, Remove favorite |
| Recent | The Open entries, Explorer, Copy path, Add to favorites |
| Layout | Open, Rename, Remove (asking inline, as its button does) |
| Repo pin | Open, Explorer (a file pin's folder), Copy path, Rename, Remove pin |
| Tab group header | Rename (an empty name follows the focused pane's title, as in the tab strip) |
| Containers | Start when any container in the group is stopped, Stop when any runs, Open Containers |
| Ports | Open localhost:&lt;port&gt;, Go to pane (when a pane started it), Show in Ports, Copy URL, Copy command line, Copy folder, Copy PID, Stop &lt;program&gt;... |
| Claude | Focus, Copy path |

A pin whose path is missing is dimmed, and its menu disables everything but Remove pin. A Containers row that only reports an engine not running has no menu.
Section headers, the clock, Wave, the System section, the footer, gaps between
panes, and the backdrop have no menu.

The Open menu button on those rows, and the Files row's menu button (4.12), open the same shared
menu below the button, toggling on a second press. The Git entry waits for the git probe, and the
menu is dropped if another menu opened or closed meanwhile.

**Launch.** Launch and Pins follow the repo (3.8) of the focused pane's folder, or of the last
focused pane that had one; a folder outside any repo counts as its own. A Files pane counts as the
repo it was opened for, not the folder it is showing, so opening a pinned subfolder keeps them on
its repo. Under a **Launch** heading, which does not collapse, one row of equal icon buttons opens
a Terminal, Git, Files, Ship, Search, or Scratch pane, in that order, with Git and Ship for git
repos only; the row fits on one line at the panel's minimum width. Each tooltip names the option,
and those for Git, Files, Search, and Scratch end with the keys of openGit, openFiles, openSearch,
and newScratch, which open the same thing, read on hover like the top bar's; Terminal names none,
since splitAuto opens at the focused pane's folder rather than the repo root, and Ship has no
action. Ship opens a pane drilled into the repo (4.20), not on the Overview. The section is hidden
until some pane has a folder.

While a button is hovered or focused, a preview over the panes shows where its pane will land: the
focused pane outlined and the new pane's share of it shaded and labeled, the existing pane that
Files or Git would bring forward, the whole pane area of an empty tab, or the focused pane with
"opens collapsed: no room".

The **Launch menu** lists the same options plus Containers and Ports, which open as they are
rather than at the repo root, in kind menu order (4.11), with their icons and a letter each (t, g,
f, o, s, c, r, p); Containers is left out while no container engine is installed, as in the kind
menu. A letter chooses its entry, and the highlighted entry shows the same preview. The menu has
an accent border and dims the window behind it, under the preview; a click on the dimmed area
only closes the menu. While the
Launch element is disabled, a **+** button in the top bar, left of **?**, drops it, its tooltip
ending with the keys of openLaunch. openLaunch (Ctrl+Shift+L, 4.5) opens it over the focused pane
whether or not the element is shown.

**Pins.** The same repo's pins (4.12), under a **Pins** heading that collapses and expands them
like any section; it is absent while the repo has no pins. The heading names the folder after the
title ("Pins · bashboard"), dropping the name rather than wrapping when it does not fit. Each pin
shows a file or folder icon and its label or path; clicking one opens it, and pins reorder by
drag and can be renamed and removed.

**Favorites.** One row per favorite folder (3.7), showing its label and path:

- Clicking opens a new terminal there (a `cd`, no command) as a split of the focused pane;
  Ctrl+click opens it collapsed; dragging the row docks it (4.2). When the focused pane has no
  room for another split, a toast says so and the terminal opens collapsed instead.
- A "+" button adds the focused terminal's working directory, and records the focused
  terminal's shell profile when it differs from `shell.defaultProfile`. A favorite with a
  profile opens in that shell; one without opens in the default. Rows show a profile badge
  when the profile is not Git Bash. Rows can be renamed, removed, and reordered by drag.
- Below the favorites, up to five recent folders taken from the roster's session cwds that are
  not already favorites, each with a star to promote it.

**Layouts.** Named arrangements of panes (3.7), under Favorites. A layout holds one tab.
One row per layout, showing its name and pane count:

- The "+" button asks for a name and saves the active tab's panes (their kinds, folders,
  shells, collapsed state, and split layout, 4.11) under it. Saving over an existing name, compared without
  regard to case, asks inline before replacing it. Saved terminals never carry a Claude
  session.
- Clicking a row opens the layout as a new tab, named after the layout and made active. Every
  other tab is left as it was. A layout with no panes opens as a tab with one default
  terminal. Opening a layout does not resume Claude (4.9).
- Rows can be renamed and removed; removing asks inline first. Ctrl+Shift+R opens a picker over
  the layouts that opens the selection the same way. The command palette (Ctrl+Shift+P, 4.5) also
  lists favorites, layouts, pane cards, tabs, pins, and worktrees.

**Panes.** One card per pane in this app, of any kind (4.11), expanded or collapsed, grouped by
tab. Groups follow the tab strip's order, and within a group cards are in the order their panes
were opened or moved into the tab. The order stays fixed as statuses change so a card never
moves out from under the pointer.

A group's combined status follows the tab urgency order (4.10). With two or more tabs, each group has a header showing the tab's name and its pane count, with
the group's cards indented beneath it along a vertical guide line. The header has no status dot,
so only cards carry one. The active tab's header is brighter and its guide line takes the
accent color, and clicking a header switches to that tab. Its menu or F2 renames the tab in place. With one tab there
are no headers and the section reads as a plain list.

Dragging a card or a title strip onto another tab's group (its header or cards) highlights the
group, and dropping there moves the pane into that tab without switching to it. A collapsed pane
stays collapsed. An expanded one splits that tab's focused pane in the auto direction, as
expanding does (4.3), or fills its empty layout; when there is no room, a toast says so and it
lands collapsed. A tab the move empties closes, and if that was the active tab, the target tab
becomes active. A group takes precedence over any dock target beneath it, and dropping on the pane's own group does nothing.

Each card shows:

- For a terminal, the status dot (4.8): `idle`, `working` (animated), `waiting` (pulsing,
  accent color), `done` (a still check mark), or `failed` (a still cross in the error color),
  plus the attention pulse (4.7). While a terminal is `waiting`, its whole card also breathes a
  faint accent tint (2.4 s, phased off the wall clock so a rebuild of the card does not restart
  it; a steady tint under reduced motion). Other kinds show their kind's icon.
- The bound agent session's name, or the working directory's last folder, with the full path
  beneath while the header's paths toggle (a `↳` button) is on. With it off (the default) the path line is
  absent and the full path joins the title's tooltip. While the terminal is `waiting`, the line
  beneath is the waiting reason (3.3) in the accent color in place of the folder, whatever the
  toggle, one line with an ellipsis, full text on hover. A `waiting` with no message reads
  "Waiting for you". Other kinds show the pane's title (4.11) and, under the same toggle, its
  folder, if any.
- For a terminal bound to an agent session (3.4), a dimmed line below that with the session's
  model and the tokens in its context, read from its transcript. Claude Code's reads
  "Opus 5.5 · 112k tokens"; the other agents lead with their name, as "Codex · gpt-5.5 · 112k /
  272k tokens". Either half shows alone while the other is unknown (Copilot reports no tokens),
  and the line is absent until the transcript has a model or a count. The count is shown against a
  window only when one is known: Codex's transcript reports it, and for a model loaded in Ollama
  the window is the loaded context length from the Local AI models poll (3.19). Claude Code's
  transcript does not name the window, so its count stands alone rather than guess a fraction.
- For a terminal, time since the last status change.
- A profile badge when the terminal's shell is not Git Bash.
- Whether it is expanded or collapsed. Clicking an expanded card switches to its tab if needed
  and focuses its pane; clicking a collapsed one expands it (4.3).
- A close button, which asks first if a command or agent session is running, or if a scratch
  pad is not empty.

**Containers.** One row per container group (4.16) with its state dot, and a Manage
button (an arrow leaving a square) in the header. Shown while a container engine is available
(3.10) and `dashboard.sections.containers` is on. The setting affects only the dashboard; the kind menu
(4.11) offers a Containers pane whenever an engine is available.

**Ports.** One row per listening TCP port (4.19) that looks like a dev server: one started from
a pane, one with a shell or a coding agent (Claude Code, Codex, or Copilot) among its live
ancestors (`fromShell`), or one whose
program is a known dev runtime (node, python, dotnet, java, postgres, and the like). Ports
started from a pane come first, then the rest by port number. Other programs' ports (a music
app, a sync client) are counted in one muted "+ N other programs" row that opens the Ports tab,
and Windows services and Bashboard itself are left out. A row shows a dot (green for loopback only,
amber when reachable from other machines), the port, the program, and, for a port traced to a
pane, that pane's title in the accent color; its tooltip adds the command line, folder, pid, and
uptime. Clicking a row goes to its pane, or opens the Ports tab on it when no pane started it. A
port that opens while the section is shown flashes once in the accent color. The header's
Manage button (the same arrow leaving a square as Containers) opens the Ports tab. The section
polls only while enabled, expanded, and on screen with the window shown, and reads "Nothing
listening" when the list is empty.

**Ship.** What needs the viewer across the repos pinned to the Ship Overview (4.20), then
what is moving there. The item rows come first: a health branch whose newest run failed ("main failed"), a pull request awaiting the
viewer's review ("#12 needs your review"), and the viewer's own pull request with changes
requested or failing checks ("#12 changes requested", "#12 checks failing"), and the viewer's own
open, non-draft pull request that is approved and has no failing checks, so it waits only on a
merge ("#12 approved by Andrew Cartwright", naming up to two approvers, "and 2 others" past that).
Each row shows a status icon (a failure icon, the success icon for an approval, or the neutral icon
for a review request), the repo's `owner/name`, and that text, with the run's or pull request's
title in its tooltip. Every failure row comes first, in the Overview's attention order, then every
approved row, then at most 5 review request rows. Clicking a branch
row opens that repo's Pipelines in a Ship pane, and a pull request row its Pull requests (4.20
says which pane).

Two summary lines follow. The running line is always shown: with one run queued or running, it
shows that run's repo, branch, pipeline name, and start ("main · Build · 3m ago") and opens the
repo's Pipelines; otherwise it counts them ("0 pipelines running", "3 pipelines running in 2
repos"), naming and opening the repo when they share one, else opening the Overview. The pull
request line counts the open pull requests across the pinned repos, drafts left out ("12 open
PRs"), and adds the review request count when it passes the row cap ("12 open PRs, 7 need your
review"). It is shown when some open pull request has neither a review request row nor an
approved row, or when review requests pass the cap, and opens the Overview. Both count from what each poll already
fetches, a repo's newest 20 runs and 50 open pull requests.

When a pin's last poll failed for want of an account (signed out, or a code host's CLI missing), a
sign-in row leads the section, "Sign in to bitbucket.org for keysys/kweb" or "Sign in for 3
pinned repos", naming the host when every such pin shares one. It opens the Accounts tab (4.20)
on that host, straight to the token form for Bitbucket and Azure DevOps (with the organization
filled in when every such pin shares one). The header's button, the Overview icon,
opens the Overview. The section is never empty: before any pinned repo has loaded it shows the
sign-in row or else a dash, and with no repo pinned it shows a "Pin repos" row
that opens the Overview, since the section is a new user's way into Ship. It reads the Overview's shared store (4.20), which polls only while this
section is shown by `dashboard.sections.ship`, expanded, and on screen with the window shown.

**Local AI models.** Shown while `dashboard.sections.localModels` is on and at least one model
server answers (3.19), and a preview. One header row per answering server (Ollama first, then LM
Studio) shows its name and version, with the server's URL in the tooltip, and a row beneath it
per loaded model shows the model's name, where it runs (`GPU`, `CPU`, or a GPU share, for Ollama
only), its context length, and the time until Ollama unloads it (`never` for a model kept loaded).
A server with nothing loaded reads "No model loaded". A context length under
`localModels.minContext` tokens (default 64000; 0 turns the warning off) is shown in the warning
color, with a tooltip explaining that agents need that much context and that Ollama's is raised
with `OLLAMA_CONTEXT_LENGTH`. The section hides when no server answers. It polls
`model_servers_poll` every 5 seconds only while it is enabled, expanded, and on screen with the
window shown.

**Launch menu.** For each detected agent (3.2) the Launch menu holds an "<agent name> on a local
model" entry while Ollama answers and `ollama` is on `PATH`. The entry is a submenu of the
installed Ollama models (`model_servers_ollama_models`); picking one opens a new terminal at the
launch root and types `ollama launch <agent> --model <model>` into it. The session that starts
is an ordinary agent session, so its card, status, and resume behave as any other.

**External sessions.** Agent sessions running outside this app (Windows Terminal, VS
Code), sorted waiting, then busy, then idle, then by most recent change. Only Claude Code sessions
appear, since the others have no session files and bind to a pane by hooks alone (3.2). Clicking a row shows
its cwd and session id with copy buttons. A `waiting` row shows the reason under the folder,
the same as a card. The section is hidden while there are none.

**Footer.** One install button sits at the bottom of the panel for each detected agent whose
hooks are not installed (3.3): "Install Claude Code hooks", "Install Codex hooks (preview)", and
"Install Copilot hooks (preview)". A button reads "Update <agent> hooks" instead when the
agent's hook config is complete and only the hook script is out of date. With every detected
agent's hooks in, the footer takes no space.

The app dialog's Settings tab (`settingsTab.ts`, 4.18) edits every user-facing setting, in the
sections Terminal, Dashboard, Appearance, Background, Editor, Git, Ship, Local AI models, and Restore. A filter field above them
shows only the fields whose label, hint, group, or section holds every word typed, and hides
sections left empty. Dashboard holds the side choice, Left or Right, and a
checkbox per element under "Show on the dashboard", followed by the Clock style select while the
clock is on. Terminal includes a Default shell
select listing the available profiles. Editor selects the preferred editor from those found (3.12),
plus a custom command field. Ship holds the Overview refresh interval (4.20). Appearance's Font family field suggests installed fonts as you type
(3.17), monospace first, with the bundled JetBrainsMono Nerd Font Mono (3.16) leading. It stays a
text field, so a name that is not installed or a comma-separated fallback list saves as typed;
picking an entry replaces the whole value and saves it at once. The list loads after the tab
opens. Each change is written to settings.json
through the app, so the file's comments survive. Toggles save immediately; number and text fields
save on blur or Enter; the shell arguments list (one argument per line) saves on blur or Ctrl+Enter;
sliders save shortly after the drag stops and show the live value. Invalid input (out of range,
empty, or not a number) shows an inline error and is not saved, and a failed save shows an inline
error too. When settings.json changes on disk while the tab is open, every control except the
focused one refreshes. Fields that do not apply live say so beside the control:
dashboard.visibleOnStart and restore.* apply at the next launch, and shell.* applies to panes opened
afterward. Warnings about the current settings appear at the top of the tab. The Open
settings.json button in the footer opens the file in the default editor, with the note "Keyboard
shortcuts are changed in the Shortcuts tab; keys that type text are added to the "keybindings"
list in settings.json."

A peek overlays the panes from the panel's side without narrowing them. It ends after a few seconds, but stays
while the pointer is over the panel and ends when the pointer leaves; opening the panel ends
it too.

