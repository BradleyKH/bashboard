# Containers, ports, and model servers

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.10 Containers (`src-tauri/src/containers.rs`)

Two engines, each through its own CLI: `docker` (Docker Desktop) and `podman` (Podman, with
its machine on Windows). At startup each CLI (`docker.exe`, `podman.exe`) is searched for on
`PATH`, and its `version --format json` probe decides whether that engine is running. An engine
whose CLI is missing is left out everywhere, and with neither, nothing in the app mentions
containers, except that a Containers pane restored from a saved workspace or layout says "No
container engine found." An engine whose CLI is found but is not running is still listed, as not running. Both CLIs take the same commands, but their `--format json` output
differs (Podman prints one array with `Names` and `Labels` as structures, Docker one object per
line with strings), so each engine has its own parser into the shared `Container` shape
(section 7).

| Command | Runs, on the container's engine |
| --- | --- |
| `containers_list() -> ContainersSnapshot` | `ps -a --format json` on every running engine: the engines with their running state, any start or stop in flight (`pending`), and whether each can be started and stopped (`canStart`, `canStop`), plus each container's engine, id, name, image, state, status text, published ports, and the Compose project and service labels. An engine whose `ps` fails is reported as not running |
| `containers_action(engine, ids, action)` | `start`, `stop`, or `restart`; ids follow `--` |
| `containers_logs(engine, id, onData) -> streamId`, `containers_logs_stop(streamId)` | `logs -f --tail 500`, stdout and stderr streamed over a `Channel` as raw bytes |
| `containers_stats(engine, ids) -> ContainerStats[]` | `stats --no-stream --format json`: CPU and memory |
| `containers_engine_start(engine)`, `containers_engine_stop(engine)` | The engine's own start or stop (below), then a probe every 2 seconds until the engine agrees, for up to 4 minutes. One at a time per engine |

`containers://changed` carries the same `ContainersSnapshot` as `containers_list`, so the front
end learns which engines exist and run from the same message as the list. Every CLI runs with an
argument list and no console window.

The Compose project comes from `com.docker.compose.project`, else `io.podman.compose.project`
(podman-compose), and the service likewise.

For each running engine, an `events --filter type=container --format json` child triggers
`containers://changed` with a fresh snapshot, debounced 300 ms. Events for exec, attach, and
resize, which leave the list as it was, do not trigger one. When the events child exits, or the
engine is not running, the core marks that engine not running, emits a snapshot, and probes it
again every 10 seconds; on recovery it restarts the events child and emits. The logs and events
children are killed when the app exits.

**Starting and stopping an engine.** At startup, and on each 10-second probe of an engine that
is not running, the core works out how that engine can be controlled:

- **Docker:** `docker desktop start` and `docker desktop stop` when the `docker desktop` command
  exists (Docker Desktop 4.37 and later). Otherwise, when `Docker Desktop.exe` is in the install
  that holds `docker.exe` (`<install>\resources\bin`), start only, by launching it, since an
  older Docker Desktop has no clean stop short of its own Quit. Docker Engine inside WSL,
  Rancher Desktop, and other setups get neither, so no button appears that cannot work.
- **Podman:** `podman machine start` and `podman machine stop` on the machine that `podman
  machine list` marks as default, else the first one listed. With no machine there is nothing to
  start; the app does not run `podman machine init`.

While a start or stop runs, every snapshot carries it as `pending`, so each Containers pane and
the dashboard show it from the same message. A start that succeeds wakes the engine's watcher, so
it follows events at once instead of at its next probe; a stop ends the events child, which the
watcher notices as usual.

Container shells open through `pty_spawn` with the command
`<engine>.exe exec -it <id> sh -c "command -v bash >/dev/null && exec bash || exec sh"`.

## 3.19 Local model servers (`src-tauri/src/model_servers.rs`)

The Local AI models section (4.6) and the launcher's local-model entries need to know which model
servers answer on this machine and what they have loaded. The core asks Ollama and LM Studio over
loopback HTTP with an 800 ms timeout per request; a server that does not answer is absent from the
result, never an error.

- **Addresses.** Ollama's is `localModels.ollamaUrl`, else the `OLLAMA_HOST` environment variable
  (a bare host or port, a scheme, and `0.0.0.0` or `[::]` read as loopback), else
  `http://127.0.0.1:11434`. LM Studio's is `localModels.lmStudioUrl`, else
  `http://127.0.0.1:1234`.
- **`model_servers_poll()`** returns a snapshot: `ollama` and `lmStudio`, each present only when
  the server answered, with its URL, version (Ollama's, from `/api/version`), and loaded models,
  plus `ollamaOnPath`, whether an `ollama` executable sits in a `PATH` folder. A loaded model
  carries its name, total size, bytes in GPU memory, context length, and the time Ollama will
  unload it. Ollama's come from `/api/ps`; LM Studio's from `/api/v1/models`, whose models with
  `loaded_instances` count as loaded, reporting each instance's configured context length and no
  GPU placement.
- **`model_servers_ollama_models()`** returns the installed Ollama models from `/api/tags`, for
  the launcher's submenus; empty when the server does not answer.

Both commands read the settings on every call, so a changed URL applies without a restart. Every
field of every reply is optional on parse, since these APIs are not versioned contracts.

## 4.16 Containers

Docker and Podman containers (3.10) are grouped by engine and Compose project; a container with
no project is its own group, named after the container. A group is running when all its
containers run, partial when some do, and stopped when none do, and its state dot shows which.

**Dashboard section** (4.6). One row per group, with no mention of the engine: groups with the
same name on both engines share a row. Each row shows the dot, the name, and a running count
such as "1 of 2". A single-container group adds a hover button, Start when it is stopped and
Stop when it runs; a group of two or more has no button, so a partly running group is never
started or stopped without seeing which containers it holds, and its slot stays blank so the
counts line up. Clicking a row opens the Containers tab with that group expanded. An engine that
is not running adds a single row saying so, such as "Podman is not running", with a Start button
at its right, always shown, when the app can start that engine (3.10). While it starts the row
reads "Podman is starting…" and has no button. The dashboard never stops an engine.

**Containers tab.** Open Containers switches to the tab holding a Containers pane, focusing it,
or appends a tab named "Containers" with one. A Containers pane is an ordinary pane and can be
docked anywhere.

**Containers pane.** One heading per available engine, Docker and then Podman, each showing
whether that engine is running, starting, or stopping, and at its right a Start button when the
engine is not running or a Stop button when it is, for each the app can do (3.10). A lone engine
gets a heading only when it has one of those buttons. Stop asks first, saying how many running
containers will stop and that the engine shuts down for every app that uses it. The buttons are
disabled while a start or stop runs. Under each,
groups expand to their containers. Each container row shows its state dot,
service or container name, image, status text ("Up 3 hours"), published ports as links to
`http://localhost:<port>` (through `open_url`), and CPU and memory, refreshed every 5 seconds
while the pane is on screen. Groups and containers have Start, Stop, and Restart; containers also
have Logs and Shell. The buttons are always shown at the row's right edge, disabled while the
state rules one out (Start on a running container, Shell on a stopped one, Start, Stop, and
Restart while an action on it runs), so they line up down the list; a group heading holds blank space where a
container row has Logs and Shell, so its three buttons sit over its containers' own.

- **Logs**, which follow the container's output in a panel beside the list. Scrolling up stops
  following; scrolling to the end resumes it. The panel's header has − and + zoom buttons before
  Close that, with Ctrl+wheel over the panel, work as the Files pane's do (4.12) and save to
  `textZoom.containerLogs`; a zoom keeps a following panel at the end. A **Fix with agent**
  button between the end-follow button and the zoom buttons appears when the container has a
  compose `com.docker.compose.project.working_dir` label (`Container.workingDir`, 3.10), the
  project's folder on the host, when that folder exists here; a container with no project, a
  project without the label, or one whose label names a path this machine lacks (an engine in
  WSL or a Podman machine labels its own Linux path) has none, since the agent needs a folder
  to work in. It hands the last 150 lines of the
  panel's cleaned text, with the container's name, image, engine, and compose service, to an
  agent in that folder, as the Ship pane's Fix with agent does (4.20, which describes the
  delivery).
- **Shell**, which opens a terminal running a shell in the container (3.10) as a split beside
  the pane, titled with the container's name. Container shells are not saved by restore or in
  layouts.

A right-click on a group heading offers Start, Stop, and Restart, enabled as the heading's
buttons are. A right-click on a container row offers Start, Stop, Restart, Logs, and Shell
(enabled only while running); then one Open `localhost:<port>` per distinct published TCP port;
then Copy name. A dashboard Containers row has its own menu (4.6).

## 4.19 Ports

Background dev servers are easy to lose track of, above all ones an agent started in a pane, so
Bashboard lists every listening TCP port with the process behind it and, where it can tell, the
pane that started it.

**Source.** `ports_list()` (`ports.rs`) reads Windows' IPv4 and IPv6 listener tables
(`GetExtendedTcpTable` with owning pids) and folds them into one row per port and process, its
addresses IPv4 first. Each row joins the process's name, start time, command line, and working
folder from `sysinfo`; command lines and folders are read once per process. A process in session
0 (a Windows service), one whose session Windows will not report (a protected service), or pid
4 and below (the kernel) is marked `system`, and Bashboard's own process `own`. `fromShell` is
set when a live ancestor, the process included, is a shell (bash, sh, zsh, fish, cmd, pwsh,
powershell, nu) or Claude Code, walked the same way as the owning pane below.

**macOS.** The listener table comes from `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN -F ptn`, run by
full path because an app launched from the Dock has a minimal `PATH`; `parse_lsof` folds its
output into the same per-address rows, a `*` becoming `0.0.0.0` or `::` by the row's family and
IPv6 brackets dropped. Without root, lsof lists only the user's own processes, which is what the
pane wants, so no row is marked `system` and the Windows services checkbox is hidden. Shell names
match with any `.exe` dropped, so `zsh` and the rest count. Stop has no `taskkill`: it gathers the
process's descendants from the process list (stopping at a child older than its recorded parent,
a reused pid), sends SIGTERM to them and then the process, waits up to 2 s, and sends SIGKILL to
whatever is left, so the end state matches the forceful Windows stop.

**Owning pane.** A row's `ptyId` is the pane terminal (3.1) it came from. The core walks the
process's parent chain up to a pane's shell, stopping at a parent that started after its child,
which is a reused pid rather than the real parent. MSYS exec can leave a process parented to a
fork stub that has already exited; such a process still shares its pane's ConPTY console host,
which is checked next, as the activity sweep does (4.8). Claude Code's Bash tool defeats both: it
runs each command in a bash with no console, which opens a conhost of its own, and that bash exits
once a background server is up. The last check reads the process's environment for the
`BASHBOARD_PANE_ID` its pane's shell exported, accepted only when its `BASHBOARD_HOOK_URL` matches
this instance's receiver (so a dev build beside the installed app, whose pane ids overlap, claims
none of the other's servers) and the process started after the pane did. Native processes keep
that environment; MSYS ones carry a trimmed Windows copy, but a listener is rarely one. An
attribution sticks to the process (its
pid and start time) once found, so it survives the intermediate shells exiting, and lapses when
the pane closes.

**Polling.** `PortsStore` holds the latest list for the dashboard section and every Ports pane.
It polls every 3 s while any of them wants it (the section shown and expanded on screen, or an
expanded Ports pane), polls at once when the first one starts, and polls again right after a
stop.

**Stop.** A row's context menu offers Stop, and so does the Ports pane's Stop button; the
dashboard section has no button for it. It asks first, naming the program,
pid, port, command line, and where it came from, then runs `taskkill /PID <pid> /T /F` on Windows, ending the
process and everything it started. `ports_stop(pid, startedAt)` refuses when the pid now belongs
to a process with another start time, refuses pid 4 and below and Bashboard itself, and a toast
reports the result.

**Ports tab.** The dashboard's Manage button and Show in Ports switch to the first Ports pane in
tab order, expanding it if collapsed, or add a Ports tab holding one, then select the row asked
for. A Ports pane is also in the kind menu (4.11).

**Ports pane.** A bar holds a filter field (matching the port, program, command line, folder, or
owning pane's title; Escape clears it), a count of the rows shown and hidden, a Started from a
pane checkbox, checked when the pane opens, that keeps only rows whose owning pane is still open
(Show in Ports on a row no pane started, and the "+ N other programs" row, clear it so the rows
they point at show), a Windows services
checkbox that also lists `system` rows, dimmed, and a Command lines checkbox, unchecked when the
pane opens, that shows each row's command line. The count sits left of the checkboxes so its
changing width never moves them. The list is a grid under a sticky header, with the columns
dot, Port, Program, Pane (the owning pane's title, in the accent color), Address ("localhost",
"all interfaces", or the address itself), PID, Up, and the buttons Open, Go to pane (disabled
when no pane started it), and Stop (disabled for Bashboard and pid 4 and below). When no row shown has an owning pane, the
Pane column is dropped from the header, the rows, and the grid. The folder, in monospace and
the content color with home shown as `~` (cut from the left when long), gets a Folder column
after Program when the pane is at least 900px wide, and otherwise sits beneath the row. Beneath
that, when Command lines is checked, comes the command line, in monospace and muted. Rows have
no tooltip, since every detail is in a column; the dot's tooltip reads "Local only" or "Reachable
from other machines". Rows sort by port until a header is clicked; Port, Program, Pane, Address, PID, and Up are
buttons that sort on that column ascending (Up shortest first), a second click descending, with
an arrow on the active one. Ties fall back to port, then pid, and rows with no owning pane stay
last when sorting by Pane in either direction. The sort is not saved. A click selects a row, a double-click outside the buttons opens
`http://localhost:<port>`, and the context menu is the dashboard's, less Show in Ports. When nothing on screen changed but the uptimes, a poll updates them in place rather than
rebuilding the list. The pane saves no state.
