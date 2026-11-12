# Proposal: run the ptys in a separate host process

Status: proposed, not scheduled.

## Problem

Every shell Bashboard runs is a ConPTY owned by the core process (`src-tauri/src/pty.rs`). The
page can crash, hang, or reload and the shells keep running, because the page only borrows
them (docs/design/terminal.md section 3.1, docs/design/app.md section 3.22). The core is the
last single point of failure: when its process ends for any reason other than a clean close,
Windows closes every pseudoconsole it holds and every shell, build, and agent session in them
ends with it.

Release builds unwind on panic, so an ordinary Rust panic now ends only one thread. What still
takes the whole process down:

- a stack overflow, which aborts regardless of the panic strategy;
- a native fault in a dependency (WebView2, the windows crate, a C library), or an access
  violation in `unsafe` code;
- running out of memory, since Rust aborts on allocation failure;
- a panic on the main thread inside a Tauri synchronous command or event callback, where it
  crosses an FFI boundary that cannot unwind;
- an external kill: Task Manager, an installer, a security product.

Each of these is rare. Their cost is not: an agent session an hour into a task, or a
long-running build, lost with no way back.

## Goal

Shells survive the core process ending abnormally, the core reconnects to them when it starts
again, and the user sees the same thing they see after a page crash today: the window comes
back, each terminal reattaches, and recent output is replayed. A clean close keeps today's
behavior, ending the shells.

Non-goals: shells surviving a reboot or logoff, sharing shells between two Bashboard windows,
and remote access.

## Design

### Processes

A small **pty host** process owns the ConPTYs. It is the same executable started in a different
mode (`bashboard.exe --pty-host <pipe name>`), so installs and updates ship one binary and the
host never needs a WebView. It holds no Tauri state, opens no window, and links only
`portable-pty`, the output tail (`pty_tail.rs`), and the protocol below.

The **core** keeps everything else and talks to the host through a client that presents the
same interface `Ptys` has today (`spawn`, `attach`, `write`, `resize`, `kill`, `contains`,
`list`, plus the pid each pty's activity sweep needs). Everything above `Ptys` (the Tauri
commands, the roster, the hook receiver, the activity sweep) stays where it is and does not know
which side runs the pty.

```
page (WebView2) --Tauri Channel--> core --named pipe--> pty host --ConPTY--> shells
```

### Discovery and lifetime

- The pipe name is per user and per data folder, for example
  `\\.\pipe\bashboard-pty-<user SID>-<hash of the config dir>`, so a debug build (which uses the
  `dev` folder) and the installed app never share a host.
- At startup the core connects to the pipe. If nothing answers, it starts the host as a
  detached child (`DETACHED_PROCESS`, own process group, outside the core's job object, if the
  core ever gets one) and connects to it.
- The host lives while either a core is connected or it holds at least one pty. With no core
  and no ptys it exits at once. With ptys but no core it waits for one.
- A clean close sends `Shutdown`: the host ends every pty, as the core does today, and exits.
  An abnormal disconnect (the pipe breaks without a `Shutdown`) puts the host in **orphaned**
  mode.
- In orphaned mode the host relaunches the core (`bashboard.exe` with a `--recovering` flag so
  the single-instance plugin does not forward it to a dying process), at most 3 times in 2
  minutes. If no core connects within 10 minutes it ends the ptys and exits, so an orphaned
  host never lingers indefinitely. Both limits are worth revisiting after use.

### Protocol

Length-prefixed binary frames over one duplex pipe, little-endian, one byte of frame type:

| Direction | Frame | Payload |
| --- | --- | --- |
| core to host | `Hello` | protocol version, a random session token |
| host to core | `Welcome` | protocol version, the live ptys (`id`, `started_at`, `pid`) |
| core to host | `Spawn` | request id, the `SpawnSpec` (command, args, cwd, env), cols, rows |
| host to core | `Spawned` | request id, pty id, `started_at`, or an error |
| core to host | `Attach` | pty id, `started_at` |
| host to core | `Output` | pty id, bytes (the first after `Attach` is the tail replay) |
| host to core | `Exited` | pty id, exit code |
| core to host | `Write`, `Resize`, `Kill` | pty id, then data, size, or nothing |
| core to host | `Shutdown` | none |

Output is forwarded as raw bytes and batched per read (up to 16 KB, the reader's buffer today),
so the host never parses terminal data. Pty ids and `started_at` come from the host, so they
stay stable across core restarts and the saved workspace's `pty` refs keep matching; the
`started_at` check that guards against id reuse today carries over unchanged.

Version mismatch (an older host left running across an update): the core refuses to adopt it,
tells the user that the running shells belong to the previous version, and starts its own host
on a versioned pipe name. In practice the updater ends the host first (below), so this path is
for a host that survived a crashed update.

### Security

The pipe's DACL grants access to the current user only, and the pipe is created with
`PIPE_REJECT_REMOTE_CLIENTS`. The first frame must carry the token the host was started with
(passed in its environment, never on the command line); any other client is disconnected. This
matches the hook receiver's model: a local loopback endpoint guarded by a per-launch secret.

### The hook endpoint

Shells inherit `BASHBOARD_HOOK_URL` and `BASHBOARD_HOOK_TOKEN` at spawn (`pty.rs`), and `bb`
and the agent hooks post there. Today the receiver binds a random port when the core starts,
so a shell that outlived its core would carry a dead URL. Two options:

1. **The host owns the listener and relays.** The host binds the loopback port and token once,
   for its own lifetime, and forwards each request to the core as a `Hook` frame, queueing them
   (bounded) while no core is connected. Hook events that arrive during a restart are delivered
   late rather than lost. This keeps the URL valid for exactly as long as the shells that hold
   it.
2. **The core rebinds the same port.** The core stores the port and token beside the
   workspace and asks for the same port on restart. Simpler, but the port can be taken in the
   meantime, and events during the gap are lost.

Recommendation: option 1. It moves only the socket, not the hook logic; `hooks.rs` keeps
parsing and applying events and receives them from the client instead of `tiny_http`.

### Recovery flow

1. The core dies. The pipe breaks; the host marks every pty orphaned and keeps reading output
   into each tail (1 MB each, as today).
2. The host relaunches the core. The new core connects, receives `Welcome` with the live ptys,
   and answers `pty_list` from it.
3. The page restores the saved workspace exactly as it does after a page crash today: each
   terminal whose saved `pty` ref matches a live pty attaches and gets the tail replay; the rest
   spawn fresh, and unclaimed ptys are killed.
4. The scrollback saved periodically (docs/design/workspace.md section 4.9) serves only the
   terminals that do not reattach, since the rest get the tail replay.

### Updates and uninstall

The updater and the installer must end the host before replacing the executable, since a
running host locks `bashboard.exe`. The core sends `Shutdown` before handing off to the
updater, which ends the shells exactly as an update does today. The NSIS uninstaller kills any
process running from the install folder, which covers an orphaned host.

### macOS and Linux

The same design on a Unix domain socket in the user's runtime directory with mode `0600`.
`portable-pty` already provides the pty side. The host-side code that differs (pipe versus
socket, detaching the child) sits under `cfg(windows)` and `cfg(not(windows))`, keeping the POSIX
side ready for Linux.

## Performance

- **Latency.** One extra local hop per keystroke and per output chunk. A named pipe round trip
  is on the order of tens of microseconds, well under a frame at 60 Hz, and keystrokes are
  already one IPC hop (page to core) today.
- **Throughput.** Pipes move several GB/s; ConPTY output tops out far below that. Batching per
  read keeps the frame count at what the reader produces today.
- **Memory.** The output tails move from the core to the host, so total memory grows only by
  the host's own footprint, a few MB.
- **Startup.** A first launch spawns the host before the first pty, adding a process start
  (tens of ms) to the first terminal's startup. Later launches find the host already running
  only after a crash, which is the case this is for.

## Risks

- **Two processes to debug.** Mitigated by logging the host to the same `bashboard.log`
  (appending with its own `host:` prefix) and by an in-process backend kept for tests.
- **Orphaned hosts.** A host bug that keeps it alive with no core would hold shells nobody can
  see. The 10-minute orphan limit and the exit-when-empty rule bound this, and the uninstaller
  covers the rest.
- **Antivirus heuristics.** A process that relaunches its parent can look suspicious. Using
  the same signed executable helps; the relaunch limit keeps it from looping.
- **Job objects.** If the core is ever placed in a job with kill-on-close (some launchers do
  this), the host must break away (`CREATE_BREAKAWAY_FROM_JOB`), which the job must allow.
  When it does not, the host dies with the core and behavior falls back to today's.

## Alternatives considered

- **Stay in process and harden further.** The panic-unwind and lock-recovery work already
  covers the common case. What remains (aborts, native faults, external kills) cannot be
  handled from inside the process that is dying.
- **Hand the pseudoconsole to a new core.** A ConPTY handle cannot be transferred to another
  process in a way that keeps the session, so a host has to hold it from the start.
- **Run shells under an existing multiplexer** (tmux in MSYS2, for example). It ties
  Bashboard to a tool many users do not have, adds its own terminal emulation layer between
  the shell and xterm.js, and does not cover PowerShell or cmd profiles.

## Plan

Each step ships on its own and leaves the app working.

1. **Backend seam.** Put the pty operations behind a `PtyBackend` trait with today's code as
   the in-process implementation. No behavior change.
2. **Host mode and protocol.** Add `--pty-host`, the frame codec, and a host loop, with
   round-trip tests that run the host in a thread over a real pipe.
3. **Client backend.** A `PtyBackend` that connects to (or starts) the host. Behind a setting
   (`terminal.ptyHost`, default off) for a release, so it can be turned off if it misbehaves.
4. **Hook relay.** Move the loopback listener into the host and relay over the pipe.
5. **Orphan handling.** Relaunch, the orphan limits, and the version check.
6. **Updater and installer.** Shut the host down before an update; verify the uninstaller ends it.
7. **Default on.** After a release with the setting available, turn it on by default and keep
   the in-process backend for tests.
8. **macOS.** The Unix socket transport.

Rough size: steps 1 to 3 are the bulk of the work, about a week of focused effort; 4 to 6
another few days; 8 a couple of days given the cfg split already in place.
