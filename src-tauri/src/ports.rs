//! Listening TCP ports for the dashboard's Ports section and the Ports pane
//! (docs/design/containers.md section 4.19).
//!
//! Each listener carries its owning process and, when the process was started from a pane, that
//! pane's pty id, so a server launched in the background still says where it came from.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System, UpdateKind};
use tauri::State;

use crate::hooks::Hooks;
use crate::pty::{console_host, spawned_secs, PtyInfo, Ptys};

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub port: u16,
    /// Local addresses the process listens on for this port, IPv4 first.
    pub addresses: Vec<String>,
    pub pid: u32,
    /// Seconds since the epoch; with `pid`, it names the process across pid reuse.
    pub started_at: u64,
    pub name: String,
    /// The full command line, or empty when Windows would not share it.
    pub command: String,
    pub cwd: Option<String>,
    pub pty_id: Option<u32>,
    /// A live ancestor is a shell or Claude Code, so it was likely started from a terminal.
    pub from_shell: bool,
    /// The OS's own listener, which the dashboard leaves out: on Windows a service or the kernel
    /// (session 0), on macOS a program shipped inside the system, on Linux a process owned by a
    /// uid below 1000 (root and the system accounts).
    pub system: bool,
    /// Bashboard itself (its hook receiver), which the dashboard also leaves out.
    pub own: bool,
}

/// One row of the OS listener table, before process details are joined in.
#[derive(Clone, Debug, PartialEq)]
pub struct RawListener {
    pub port: u16,
    pub address: String,
    pub pid: u32,
}

#[derive(Default)]
pub struct PortsProbe {
    sys: System,
    /// Console hosts already looked up, keyed by (pid, start time) so a reused pid is looked up afresh.
    hosts: HashMap<(u32, u64), Option<usize>>,
    /// Sticky attributions: once a process is traced to a pane it stays traced, even after the
    /// parent chain that proved it has exited.
    owners: HashMap<(u32, u64), u32>,
}

#[derive(Default)]
pub struct PortsState(Arc<Mutex<PortsProbe>>);

#[derive(Clone, Copy)]
struct Proc {
    parent: Option<u32>,
    start: u64,
}

/// Programs whose descendants count as started from a terminal: shells and Claude Code, by base
/// name (Windows adds `.exe`, which `is_shell` drops).
const SHELLS: &[&str] = &["bash", "sh", "zsh", "fish", "cmd", "pwsh", "powershell", "nu", "claude", "codex", "copilot"];

fn is_shell(name: &str) -> bool {
    let base = match name.len().checked_sub(4).and_then(|i| name.get(i..)) {
        Some(ext) if ext.eq_ignore_ascii_case(".exe") => &name[..name.len() - 4],
        _ => name,
    };
    SHELLS.iter().any(|s| base.eq_ignore_ascii_case(s))
}

/// The first process on `pid`'s parent chain, `pid` included, that `hit` accepts. A parent that
/// started after its child is a reused pid, not the real parent, so the walk stops there.
fn ancestor(pid: u32, procs: &HashMap<u32, Proc>, hit: impl Fn(u32) -> bool) -> Option<u32> {
    let mut current = pid;
    let mut seen = HashSet::from([current]);
    loop {
        if hit(current) {
            return Some(current);
        }
        let me = procs.get(&current)?;
        let parent = me.parent?;
        let up = procs.get(&parent)?;
        if up.start > me.start || !seen.insert(parent) {
            return None;
        }
        current = parent;
    }
}

/// Every live descendant of `root`, breadth first, `root` excluded. A child that started before
/// its recorded parent is attached to a reused pid, so it is not followed (as in `ancestor`).
#[cfg_attr(windows, allow(dead_code))]
fn descendants(root: u32, procs: &HashMap<u32, Proc>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, p) in procs {
        if let Some(parent) = p.parent {
            if procs.get(&parent).is_some_and(|up| up.start <= p.start) {
                children.entry(parent).or_default().push(pid);
            }
        }
    }
    let mut out = Vec::new();
    let mut seen = HashSet::from([root]);
    let mut queue = std::collections::VecDeque::from([root]);
    while let Some(next) = queue.pop_front() {
        for &child in children.get(&next).into_iter().flatten() {
            if seen.insert(child) {
                out.push(child);
                queue.push_back(child);
            }
        }
    }
    out
}

/// Follows `pid`'s parent chain to a pane shell, giving that pane's pty id.
fn traced_owner(pid: u32, procs: &HashMap<u32, Proc>, shells: &HashMap<u32, u32>) -> Option<u32> {
    ancestor(pid, procs, |p| shells.contains_key(&p)).map(|p| shells[&p])
}

/// Folds the per-address rows into one row per (port, pid), addresses IPv4 first, sorted by port.
pub fn merge(raw: Vec<RawListener>) -> Vec<(u16, u32, Vec<String>)> {
    let mut by: BTreeMap<(u16, u32), Vec<String>> = BTreeMap::new();
    for r in raw {
        let list = by.entry((r.port, r.pid)).or_default();
        if !list.contains(&r.address) {
            list.push(r.address);
        }
    }
    by.into_iter()
        .map(|((port, pid), mut addrs)| {
            addrs.sort_by_key(|a| (a.contains(':'), a.clone()));
            (port, pid, addrs)
        })
        .collect()
}

fn proc_map(sys: &System) -> HashMap<u32, Proc> {
    sys.processes()
        .iter()
        .map(|(pid, p)| (pid.as_u32(), Proc { parent: p.parent().map(|pp| pp.as_u32()), start: p.start_time() }))
        .collect()
}

/// Quotes an argument that holds a space, so the joined command line reads unambiguously.
fn join_command(args: &[std::ffi::OsString]) -> String {
    args.iter()
        .map(|a| {
            let s = a.to_string_lossy();
            if s.contains(' ') && !s.starts_with('"') {
                format!("\"{s}\"")
            } else {
                s.into_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The pane id a process inherited from its pane's shell, when it was this instance's pane: the
/// hook URL names the running receiver, so a dev build beside the installed app, whose panes
/// reuse the same small ids, never claims the other's servers.
fn inherited_pane(environ: &[std::ffi::OsString], hook_url: Option<&str>) -> Option<u32> {
    let var = |name: &str| {
        environ.iter().find_map(|e| {
            let e = e.to_str()?;
            let (k, v) = e.split_once('=')?;
            k.eq_ignore_ascii_case(name).then_some(v)
        })
    };
    if var("BASHBOARD_HOOK_URL") != hook_url {
        return None;
    }
    var("BASHBOARD_PANE_ID")?.parse().ok()
}

impl PortsProbe {
    pub fn list(&mut self, ptys: &[PtyInfo], hook_url: Option<&str>) -> Vec<Listener> {
        let rows = merge(os::listeners());
        if rows.is_empty() {
            return Vec::new();
        }
        self.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
        let pids: Vec<Pid> = rows.iter().map(|r| Pid::from_u32(r.1)).collect::<HashSet<_>>().into_iter().collect();
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            false,
            ProcessRefreshKind::nothing()
                .with_cmd(UpdateKind::OnlyIfNotSet)
                .with_cwd(UpdateKind::OnlyIfNotSet)
                .with_environ(UpdateKind::OnlyIfNotSet)
                .with_exe(UpdateKind::OnlyIfNotSet),
        );
        let procs = proc_map(&self.sys);
        let shells: HashMap<u32, u32> = ptys.iter().map(|p| (p.pid, p.id)).collect();
        let terminals: HashSet<u32> = self
            .sys
            .processes()
            .iter()
            .filter(|(_, p)| is_shell(&p.name().to_string_lossy()))
            .map(|(pid, _)| pid.as_u32())
            .collect();
        let live: HashSet<(u32, u64)> = procs.iter().map(|(&pid, p)| (pid, p.start)).collect();
        self.owners.retain(|k, _| live.contains(k));
        self.hosts.retain(|k, _| live.contains(k));

        let mut out = Vec::with_capacity(rows.len());
        for (port, pid, addresses) in rows {
            let start = self.sys.process(Pid::from_u32(pid)).map(|p| p.start_time()).unwrap_or(0);
            let pty_id = self.owner(pid, start, &procs, &shells, ptys, hook_url);
            let process = self.sys.process(Pid::from_u32(pid));
            out.push(Listener {
                port,
                addresses,
                pid,
                started_at: start,
                name: process.map(|p| p.name().to_string_lossy().into_owned()).unwrap_or_default(),
                command: process.map(|p| join_command(p.cmd())).unwrap_or_default(),
                cwd: process.and_then(|p| p.cwd()).map(|c| c.to_string_lossy().into_owned()).filter(|c| !c.is_empty()),
                from_shell: pty_id.is_some() || ancestor(pid, &procs, |p| terminals.contains(&p)).is_some(),
                pty_id,
                system: os::is_system(pid, process.and_then(|p| p.exe())),
                own: pid == std::process::id(),
            });
        }
        out
    }

    /// The pane a listener came from: its parent chain, then its console, then its environment.
    /// MSYS exec can leave a process parented to a fork stub that has already exited, breaking
    /// the chain, but it still shares its pane's ConPTY console host. Claude Code's Bash tool
    /// breaks both: it runs each command in a bash with no console (which then opens its own
    /// conhost) and exits once a background server is up. The pane id the server inherited
    /// survives all of that in native processes; MSYS ones keep a trimmed Windows environment.
    fn owner(
        &mut self,
        pid: u32,
        start: u64,
        procs: &HashMap<u32, Proc>,
        shells: &HashMap<u32, u32>,
        ptys: &[PtyInfo],
        hook_url: Option<&str>,
    ) -> Option<u32> {
        let live_pty = |id: u32| ptys.iter().any(|p| p.id == id);
        if let Some(&id) = self.owners.get(&(pid, start)) {
            if live_pty(id) {
                return Some(id);
            }
        }
        let found = traced_owner(pid, procs, shells).or_else(|| {
            let host = self.host(pid, start)?;
            ptys.iter()
                .filter(|p| start >= spawned_secs(p.started_at))
                .find(|p| {
                    let shell_start = procs.get(&p.pid).map(|s| s.start).unwrap_or(0);
                    self.host(p.pid, shell_start) == Some(host)
                })
                .map(|p| p.id)
        })
        .or_else(|| {
            let id = inherited_pane(self.sys.process(Pid::from_u32(pid))?.environ(), hook_url)?;
            // A process older than the pane holds an id from a previous run of this app.
            ptys.iter().find(|p| p.id == id && start >= spawned_secs(p.started_at)).map(|p| p.id)
        });
        if let Some(id) = found {
            self.owners.insert((pid, start), id);
        }
        found
    }

    fn host(&mut self, pid: u32, start: u64) -> Option<usize> {
        *self.hosts.entry((pid, start)).or_insert_with(|| console_host(pid))
    }

    /// Whether `pid` is still the process that started at `started_at`, so a stop never lands
    /// on a reused pid.
    fn same_process(&mut self, pid: u32, started_at: u64) -> bool {
        let p = Pid::from_u32(pid);
        self.sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
        self.sys.process(p).is_some_and(|proc| proc.start_time() == started_at)
    }
}

#[tauri::command]
pub async fn ports_list(
    state: State<'_, PortsState>,
    ptys: State<'_, Ptys>,
    hooks: State<'_, Hooks>,
) -> Result<Vec<Listener>, String> {
    let probe = state.0.clone();
    let list = ptys.list();
    let hook_url = hooks.url().map(str::to_owned);
    tauri::async_runtime::spawn_blocking(move || {
        let mut p = probe.lock().map_err(|e| e.to_string())?;
        Ok(p.list(&list, hook_url.as_deref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ends the listening process and everything it started, so a dev server's workers go with it.
#[tauri::command]
pub async fn ports_stop(state: State<'_, PortsState>, pid: u32, started_at: u64) -> Result<(), String> {
    if pid <= 4 || pid == std::process::id() {
        return Err("that process cannot be stopped from here".into());
    }
    let probe = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !probe.lock().map_err(|e| e.to_string())?.same_process(pid, started_at) {
            return Err("the process has already exited".to_string());
        }
        kill_tree(pid, started_at)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `taskkill /T /F`: the whole tree, forcefully.
#[cfg(windows)]
fn kill_tree(pid: u32, _started_at: u64) -> Result<(), String> {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::child_process::prepare(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if msg.is_empty() { format!("taskkill exited with {}", out.status) } else { msg })
    }
}

#[cfg(not(windows))]
fn kill_tree(pid: u32, started_at: u64) -> Result<(), String> {
    end_tree(pid, started_at)
}

/// How long a SIGTERMed tree gets to exit before SIGKILL.
const TERM_GRACE: Duration = Duration::from_secs(2);

/// The (pid, start) targets still running; a zombie has exited and only awaits its parent's wait.
#[cfg_attr(windows, allow(dead_code))]
fn survivors(targets: &[(u32, u64)]) -> Vec<(u32, u64)> {
    // A fresh System each poll: on macOS sysinfo reads a process's status only when it first
    // sees the pid, so a reused System would never report the zombie a stopped listener becomes.
    let mut sys = System::new();
    let pids: Vec<Pid> = targets.iter().map(|t| Pid::from_u32(t.0)).collect();
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, ProcessRefreshKind::nothing());
    targets
        .iter()
        .copied()
        .filter(|&(pid, start)| {
            sys.process(Pid::from_u32(pid)).is_some_and(|p| p.start_time() == start && p.status() != ProcessStatus::Zombie)
        })
        .collect()
}

/// SIGTERM to the descendants and then `pid`, SIGKILL for whatever outlasts the grace period, so
/// the end state matches `taskkill /F`. Each signal is re-checked against the start time, so a
/// pid reused mid-stop is left alone.
#[cfg_attr(windows, allow(dead_code))]
fn end_tree(pid: u32, started_at: u64) -> Result<(), String> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let procs = proc_map(&sys);
    if procs.get(&pid).map(|p| p.start) != Some(started_at) {
        return Err("the process has already exited".into());
    }
    let mut targets: Vec<(u32, u64)> = descendants(pid, &procs).into_iter().map(|p| (p, procs[&p].start)).collect();
    targets.push((pid, started_at));

    let send = |sys: &System, live: &[(u32, u64)], signal: Signal| {
        for &(p, start) in live {
            if let Some(proc) = sys.process(Pid::from_u32(p)).filter(|x| x.start_time() == start) {
                proc.kill_with(signal);
            }
        }
    };
    let wait = |mut live: Vec<(u32, u64)>, limit: Duration| {
        let deadline = Instant::now() + limit;
        loop {
            live = survivors(&live);
            if live.is_empty() || Instant::now() >= deadline {
                return live;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    };

    send(&sys, &targets, Signal::Term);
    let left = wait(targets, TERM_GRACE);
    if left.is_empty() {
        return Ok(());
    }
    send(&sys, &left, Signal::Kill);
    if wait(left, Duration::from_secs(1)).iter().any(|t| t.0 == pid) {
        return Err("the process did not exit".into());
    }
    Ok(())
}

#[cfg(windows)]
mod os {
    use super::RawListener;
    use std::net::{Ipv4Addr, Ipv6Addr};

    const AF_INET: u32 = 2;
    const AF_INET6: u32 = 23;
    const TCP_TABLE_OWNER_PID_LISTENER: u32 = 3;
    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const NO_ERROR: u32 = 0;
    const ROW4_BYTES: usize = 24;
    const ROW6_BYTES: usize = 56;

    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn GetExtendedTcpTable(table: *mut u8, size: *mut u32, order: i32, af: u32, class: u32, reserved: u32) -> u32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
    }

    /// The table for one address family, as raw bytes; grows the buffer until it fits.
    fn table(af: u32) -> Option<Vec<u8>> {
        let mut size: u32 = 16 * 1024;
        for _ in 0..4 {
            // u32 storage keeps the rows' u32 fields aligned.
            let mut buf = vec![0u32; (size as usize).div_ceil(4)];
            let rc = unsafe {
                GetExtendedTcpTable(buf.as_mut_ptr().cast(), &mut size, 0, af, TCP_TABLE_OWNER_PID_LISTENER, 0)
            };
            match rc {
                NO_ERROR => {
                    let bytes: Vec<u8> = buf.iter().flat_map(|w| w.to_ne_bytes()).collect();
                    return Some(bytes[..(size as usize).min(bytes.len())].to_vec());
                }
                ERROR_INSUFFICIENT_BUFFER => continue,
                _ => return None,
            }
        }
        None
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_ne_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    /// The port sits in the low 16 bits of its field in network byte order.
    fn port_of(field: u32) -> u16 {
        u16::from_be_bytes([(field & 0xff) as u8, ((field >> 8) & 0xff) as u8])
    }

    pub fn parse4(b: &[u8]) -> Vec<RawListener> {
        if b.len() < 4 {
            return Vec::new();
        }
        let n = u32_at(b, 0) as usize;
        (0..n)
            .filter_map(|i| {
                let at = 4 + i * ROW4_BYTES;
                let row = b.get(at..at + ROW4_BYTES)?;
                let addr = Ipv4Addr::from([row[4], row[5], row[6], row[7]]);
                Some(RawListener { port: port_of(u32_at(row, 8)), address: addr.to_string(), pid: u32_at(row, 20) })
            })
            .collect()
    }

    pub fn parse6(b: &[u8]) -> Vec<RawListener> {
        if b.len() < 4 {
            return Vec::new();
        }
        let n = u32_at(b, 0) as usize;
        (0..n)
            .filter_map(|i| {
                let at = 4 + i * ROW6_BYTES;
                let row = b.get(at..at + ROW6_BYTES)?;
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&row[0..16]);
                let addr = Ipv6Addr::from(octets);
                Some(RawListener { port: port_of(u32_at(row, 20)), address: addr.to_string(), pid: u32_at(row, 52) })
            })
            .collect()
    }

    pub fn listeners() -> Vec<RawListener> {
        let mut out = table(AF_INET).map(|b| parse4(&b)).unwrap_or_default();
        out.extend(table(AF_INET6).map(|b| parse6(&b)).unwrap_or_default());
        out
    }

    /// The kernel or a service in session 0; a process whose session Windows will not report is
    /// a protected service.
    pub fn is_system(pid: u32, _exe: Option<&std::path::Path>) -> bool {
        let mut session = 0u32;
        pid <= 4 || unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 || session == 0
    }
}

/// Parses `lsof -F ptn` output: `p<pid>` opens a process, `f<fd>` a file within it, then `t`
/// (`IPv4` or `IPv6`) and `n<addr>:<port>`. A wildcard becomes the unspecified address of the
/// file's family and IPv6 brackets are dropped, so rows sort and display like the Windows ones.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof(text: &str) -> Vec<RawListener> {
    let mut out = Vec::new();
    let mut pid: Option<u32> = None;
    let mut v6 = false;
    for line in text.lines() {
        let Some(tag) = line.chars().next() else { continue };
        let rest = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                pid = rest.parse().ok();
                v6 = false;
            }
            'f' => v6 = false,
            't' => v6 = rest == "IPv6",
            'n' => {
                let Some(pid) = pid else { continue };
                let Some((host, port)) = rest.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
                let address = match host {
                    "*" if v6 => "::".to_string(),
                    "*" => "0.0.0.0".to_string(),
                    "" => continue,
                    h => h.to_string(),
                };
                out.push(RawListener { port, address, pid });
            }
            _ => {}
        }
    }
    out
}

#[cfg(target_os = "macos")]
mod os {
    use super::{parse_lsof, RawListener};
    use std::process::{Command, Stdio};

    /// lsof by full path, since an app launched from the Dock has a minimal PATH. Without root it
    /// sees only the user's own processes, which is what the pane wants. It exits nonzero when it
    /// finds nothing or skips an unreadable process, so only its output counts.
    pub fn listeners() -> Vec<RawListener> {
        Command::new("/usr/sbin/lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "ptn"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map(|o| parse_lsof(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }

    /// lsof shows only the user's own processes, but those include macOS's per-user services,
    /// such as AirPlay Receiver holding 5000 and 7000; they run from the sealed system volume.
    pub fn is_system(_pid: u32, exe: Option<&std::path::Path>) -> bool {
        exe.is_some_and(super::is_apple_system_path)
    }
}

/// The LISTEN rows of `/proc/net/tcp` (or `tcp6` when `v6`) as (port, address, socket inode).
/// Each address is a hex IP in the kernel's host byte order (IPv4 one word, IPv6 four), formatted
/// like the other platforms' rows, so a wildcard is `0.0.0.0` or `::`. Rows that do not parse and
/// sockets with no inode (inode 0, which belongs to no process) are skipped.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_proc_net_tcp(text: &str, v6: bool) -> Vec<(u16, String, u64)> {
    const LISTEN: &str = "0A";
    text.lines()
        .filter_map(|line| {
            let mut f = line.split_whitespace();
            let (_, local, _, state) = (f.next()?, f.next()?, f.next()?, f.next()?);
            if state != LISTEN {
                return None;
            }
            // After the state: tx:rx queues, timer, retransmits, uid, timeout, then the inode.
            let inode: u64 = f.nth(5)?.parse().ok().filter(|&i| i != 0)?;
            let (ip, port) = local.split_once(':')?;
            let port = u16::from_str_radix(port, 16).ok()?;
            let address = if v6 {
                if ip.len() != 32 || !ip.is_ascii() {
                    return None;
                }
                let mut octets = [0u8; 16];
                for (i, chunk) in octets.chunks_exact_mut(4).enumerate() {
                    chunk.copy_from_slice(&u32::from_str_radix(&ip[i * 8..i * 8 + 8], 16).ok()?.to_ne_bytes());
                }
                std::net::Ipv6Addr::from(octets).to_string()
            } else {
                if ip.len() != 8 {
                    return None;
                }
                std::net::Ipv4Addr::from(u32::from_str_radix(ip, 16).ok()?.to_ne_bytes()).to_string()
            };
            Some((port, address, inode))
        })
        .collect()
}

/// The inode in a `/proc/<pid>/fd/<n>` link target such as `socket:[12345]`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn socket_inode(link: &str) -> Option<u64> {
    link.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
}

#[cfg(target_os = "linux")]
mod os {
    use super::{parse_proc_net_tcp, socket_inode, RawListener};
    use std::collections::{HashMap, HashSet};
    use std::os::unix::fs::MetadataExt;

    /// Uids below this belong to root and the system accounts; people start at 1000.
    const FIRST_USER_UID: u32 = 1000;

    /// The pids holding each wanted socket inode, from one pass over every `/proc/<pid>/fd`. A
    /// process whose fd folder cannot be read (another user's) is skipped, so its listeners have
    /// no pid and are dropped, as lsof on macOS shows only the user's own.
    fn inode_pids(wanted: &HashSet<u64>) -> HashMap<u64, Vec<u32>> {
        let mut out: HashMap<u64, Vec<u32>> = HashMap::new();
        let Ok(procs) = std::fs::read_dir("/proc") else { return out };
        for entry in procs.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else { continue };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else { continue };
                let Some(inode) = target.to_str().and_then(socket_inode).filter(|i| wanted.contains(i)) else { continue };
                let pids = out.entry(inode).or_default();
                if !pids.contains(&pid) {
                    pids.push(pid);
                }
            }
        }
        out
    }

    pub fn listeners() -> Vec<RawListener> {
        let mut rows = Vec::new();
        for (path, v6) in [("/proc/net/tcp", false), ("/proc/net/tcp6", true)] {
            if let Ok(text) = std::fs::read_to_string(path) {
                rows.extend(parse_proc_net_tcp(&text, v6));
            }
        }
        if rows.is_empty() {
            return Vec::new();
        }
        let wanted: HashSet<u64> = rows.iter().map(|r| r.2).collect();
        let owners = inode_pids(&wanted);
        rows.into_iter()
            .flat_map(|(port, address, inode)| {
                owners.get(&inode).into_iter().flatten().map(move |&pid| RawListener { port, address: address.clone(), pid })
            })
            .collect()
    }

    /// Owned by root or a system account (uid below 1000), such as a database or web server
    /// daemon, as opposed to a dev server the user started.
    pub fn is_system(pid: u32, _exe: Option<&std::path::Path>) -> bool {
        std::fs::metadata(format!("/proc/{pid}")).is_ok_and(|m| m.uid() < FIRST_USER_UID)
    }
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
mod os {
    use super::RawListener;

    pub fn listeners() -> Vec<RawListener> {
        Vec::new()
    }

    pub fn is_system(_pid: u32, _exe: Option<&std::path::Path>) -> bool {
        false
    }
}

/// An executable that ships with macOS: the sealed system volume and the system's own
/// daemons. `/usr/bin` is left out, since it holds the developer tools' launchers.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_apple_system_path(exe: &std::path::Path) -> bool {
    ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/"]
        .iter()
        .any(|root| exe.to_str().is_some_and(|e| e.starts_with(root)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(port: u16, address: &str, pid: u32) -> RawListener {
        RawListener { port, address: address.into(), pid }
    }

    #[test]
    fn apple_system_paths_are_services() {
        use std::path::Path;
        let control = "/System/Library/CoreServices/ControlCenter.app/Contents/MacOS/ControlCenter";
        assert!(is_apple_system_path(Path::new(control)));
        assert!(is_apple_system_path(Path::new("/usr/libexec/rapportd")));
        assert!(!is_apple_system_path(Path::new("/usr/bin/python3")));
        assert!(!is_apple_system_path(Path::new("/opt/homebrew/bin/node")));
        assert!(!is_apple_system_path(Path::new("/Applications/Docker.app/Contents/MacOS/com.docker.backend")));
    }

    #[test]
    fn merge_folds_addresses_per_port_and_pid() {
        let rows = merge(vec![
            raw(5173, "::1", 10),
            raw(3000, "0.0.0.0", 20),
            raw(5173, "127.0.0.1", 10),
            raw(3000, "::", 20),
            raw(3000, "0.0.0.0", 20),
            raw(3000, "0.0.0.0", 21),
        ]);
        assert_eq!(
            rows,
            vec![
                (3000, 20, vec!["0.0.0.0".to_string(), "::".to_string()]),
                (3000, 21, vec!["0.0.0.0".to_string()]),
                (5173, 10, vec!["127.0.0.1".to_string(), "::1".to_string()]),
            ]
        );
    }

    fn procs(list: &[(u32, Option<u32>, u64)]) -> HashMap<u32, Proc> {
        list.iter().map(|&(pid, parent, start)| (pid, Proc { parent, start })).collect()
    }

    #[test]
    fn traces_through_the_parent_chain() {
        let p = procs(&[(100, None, 1), (200, Some(100), 2), (300, Some(200), 3)]);
        let shells = HashMap::from([(100, 7)]);
        assert_eq!(traced_owner(300, &p, &shells), Some(7));
        assert_eq!(traced_owner(100, &p, &shells), Some(7));
    }

    #[test]
    fn stops_at_a_reused_parent_pid() {
        // 200's recorded parent 100 started after it, so 100 is a newer process with an old pid.
        let p = procs(&[(100, None, 9), (200, Some(100), 2)]);
        let shells = HashMap::from([(100, 7)]);
        assert_eq!(traced_owner(200, &p, &shells), None);
    }

    #[test]
    fn recognizes_shells_in_any_case() {
        assert!(is_shell("bash.exe") && is_shell("PowerShell.exe") && is_shell("claude.exe"));
        assert!(is_shell("codex.exe") && is_shell("Copilot.exe"));
        assert!(!is_shell("node.exe") && !is_shell("explorer.exe"));
    }

    #[test]
    fn recognizes_shells_without_an_extension() {
        assert!(is_shell("zsh") && is_shell("bash") && is_shell("fish") && is_shell("nu") && is_shell("claude"));
        assert!(is_shell("codex") && is_shell("Copilot"));
        assert!(!is_shell("node") && !is_shell("exe") && !is_shell("") && !is_shell("bash.exe.bak") && !is_shell("\u{e9}.exe"));
    }

    #[test]
    fn parses_lsof_ipv4_and_ipv6_listeners() {
        let text = "p100\nf5\ntIPv4\nn*:3000\nf6\ntIPv6\nn*:3000\nf7\ntIPv6\nn[::1]:5173\nf8\ntIPv4\nn127.0.0.1:5173\n\
                    p200\nf3\ntIPv6\nn[fe80::1]:8080\n";
        assert_eq!(
            parse_lsof(text),
            vec![
                raw(3000, "0.0.0.0", 100),
                raw(3000, "::", 100),
                raw(5173, "::1", 100),
                raw(5173, "127.0.0.1", 100),
                raw(8080, "fe80::1", 200),
            ]
        );
    }

    #[test]
    fn lsof_wildcard_follows_its_own_files_family() {
        // The family resets per file, so an `n` with no `t` before it reads as IPv4.
        assert_eq!(parse_lsof("p1\nf1\ntIPv6\nn*:1\nf2\nn*:2\n"), vec![raw(1, "::", 1), raw(2, "0.0.0.0", 1)]);
    }

    #[test]
    fn lsof_skips_lines_it_cannot_parse() {
        let text = "garbage\n\np10\nf1\ntIPv4\nnno-port-here\nn*:notaport\nn:99\nn127.0.0.1:70000\nn127.0.0.1:80\nx\n";
        assert_eq!(parse_lsof(text), vec![raw(80, "127.0.0.1", 10)]);
        // An address with no owning process line is dropped.
        assert_eq!(parse_lsof("n*:80\n"), Vec::new());
        assert_eq!(parse_lsof("pjunk\nn*:80\n"), Vec::new());
    }

    #[test]
    fn descendants_walks_the_tree() {
        let p = procs(&[(1, None, 1), (2, Some(1), 2), (3, Some(2), 3), (4, Some(1), 4), (5, Some(9), 5), (6, None, 6)]);
        let mut d = descendants(1, &p);
        d.sort();
        assert_eq!(d, vec![2, 3, 4]);
        assert_eq!(descendants(3, &p), Vec::<u32>::new());
        assert_eq!(descendants(77, &p), Vec::<u32>::new());
    }

    #[test]
    fn descendants_skip_a_reused_parent_pid() {
        // 3 started before the process now holding pid 2, so 2 is not its real parent.
        let p = procs(&[(1, None, 1), (2, Some(1), 5), (3, Some(2), 3), (4, Some(2), 6)]);
        let mut d = descendants(1, &p);
        d.sort();
        assert_eq!(d, vec![2, 4]);
    }

    #[test]
    fn descendants_end_on_a_parent_cycle() {
        let p = procs(&[(1, Some(2), 1), (2, Some(1), 1), (3, Some(2), 2)]);
        let mut d = descendants(1, &p);
        d.sort();
        assert_eq!(d, vec![2, 3]);
    }

    #[test]
    fn finds_any_matching_ancestor() {
        let p = procs(&[(1, None, 1), (2, Some(1), 2), (3, Some(2), 3)]);
        assert_eq!(ancestor(3, &p, |x| x == 1), Some(1));
        assert_eq!(ancestor(3, &p, |x| x == 3), Some(3));
        assert_eq!(ancestor(3, &p, |x| x == 9), None);
    }

    #[test]
    fn a_broken_chain_is_untraced() {
        let p = procs(&[(300, Some(250), 3)]);
        assert_eq!(traced_owner(300, &p, &HashMap::from([(100, 7)])), None);
    }

    #[test]
    fn a_parent_cycle_ends() {
        let p = procs(&[(1, Some(2), 1), (2, Some(1), 1)]);
        assert_eq!(traced_owner(1, &p, &HashMap::new()), None);
    }

    fn env(vars: &[&str]) -> Vec<std::ffi::OsString> {
        vars.iter().map(Into::into).collect()
    }

    #[test]
    fn reads_the_inherited_pane_of_this_instance_only() {
        let url = Some("http://127.0.0.1:5");
        let mine = env(&["PATH=x", "BASHBOARD_HOOK_URL=http://127.0.0.1:5", "BASHBOARD_PANE_ID=3"]);
        assert_eq!(inherited_pane(&mine, url), Some(3));
        let other = env(&["BASHBOARD_HOOK_URL=http://127.0.0.1:6", "BASHBOARD_PANE_ID=3"]);
        assert_eq!(inherited_pane(&other, url), None);
        assert_eq!(inherited_pane(&env(&["BASHBOARD_PANE_ID=3"]), url), None);
        assert_eq!(inherited_pane(&env(&["BASHBOARD_PANE_ID=3"]), None), Some(3));
        assert_eq!(inherited_pane(&env(&["PATH=x"]), None), None);
    }

    #[test]
    fn quotes_arguments_with_spaces() {
        let args: Vec<std::ffi::OsString> = ["node", "C:\\Program Files\\x.js", "--port", "3000"].iter().map(Into::into).collect();
        assert_eq!(join_command(&args), "node \"C:\\Program Files\\x.js\" --port 3000");
    }

    // Real rows from WSL Ubuntu, trimmed: systemd-resolved on 127.0.0.53:53 and 10.255.255.254:53,
    // python3 -m http.server on 0.0.0.0:8765, and an ESTABLISHED row.
    const TCP4: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 3500007F:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000   101        0 654964 1 0000000000000000 100 0 0 10 5\n\
   1: 00000000:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 659706 1 0000000000000000 100 0 0 10 0\n\
   2: FEFFFF0A:0035 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 104 1 0000000000000000 100 0 0 10 0\n\
   3: 0100007F:E3D2 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 660001 1 0000000000000000 100 0 0 10 0\n";

    // Real rows: a listener on :: (8766), one on ::1 (8767), and an ESTABLISHED one.
    const TCP6: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n\
   0: 00000000000000000000000000000000:223E 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 647787 1 0000000000000000 100 0 0 10 0\n\
   1: 00000000000000000000000001000000:223F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 647788 1 0000000000000000 100 0 0 10 0\n\
   2: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 647789 1 0000000000000000 100 0 0 10 0\n";

    // The kernel prints each address word in host byte order, so these fixtures are little-endian.
    #[cfg(target_endian = "little")]
    #[test]
    fn parses_proc_net_tcp_listeners() {
        assert_eq!(
            parse_proc_net_tcp(TCP4, false),
            vec![
                (53, "127.0.0.53".to_string(), 654964),
                (8765, "0.0.0.0".to_string(), 659706),
                (53, "10.255.255.254".to_string(), 104),
            ]
        );
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn parses_proc_net_tcp6_listeners() {
        assert_eq!(parse_proc_net_tcp(TCP6, true), vec![(8766, "::".to_string(), 647787), (8767, "::1".to_string(), 647788)]);
        let mapped = "0: 0000000000000000FFFF00000100007F:1F90 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 55 1";
        assert_eq!(parse_proc_net_tcp(mapped, true), vec![(8080, "::ffff:127.0.0.1".to_string(), 55)]);
    }

    #[cfg(target_endian = "little")]
    #[test]
    fn proc_net_tcp_skips_unusable_rows() {
        let text = "garbage\n\n0: nocolon 0:0 0A 0:0 0:0 0 0 0 5 1\n\
                    1: 0100007F:ZZZZ 0:0 0A 0:0 0:0 0 0 0 5 1\n\
                    2: 0100007F:0050 0:0 0A 0:0 0:0 0 0 0 0 1\n\
                    3: 0100007F:0050 0:0 0A 0:0 0:0 0 0 0 notanumber 1\n\
                    4: 0100007F:0050 0:0 0A\n\
                    5: 0100007F:0050 0:0 0A 0:0 0:0 0 0 0 6 1\n";
        assert_eq!(parse_proc_net_tcp(text, false), vec![(80, "127.0.0.1".to_string(), 6)]);
        // An address of the wrong width for its family is skipped, not misread.
        assert_eq!(parse_proc_net_tcp("0: 0100007F:0050 0:0 0A 0:0 0:0 0 0 0 6 1", true), Vec::new());
        let v6_row = "0: 00000000000000000000000001000000:0050 0:0 0A 0:0 0:0 0 0 0 6 1";
        assert_eq!(parse_proc_net_tcp(v6_row, false), Vec::new());
    }

    #[test]
    fn reads_socket_inodes() {
        assert_eq!(socket_inode("socket:[12345]"), Some(12345));
        assert_eq!(socket_inode("socket:[]"), None);
        assert_eq!(socket_inode("pipe:[12345]"), None);
        assert_eq!(socket_inode("/dev/null"), None);
        assert_eq!(socket_inode("anon_inode:[eventpoll]"), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_own_listener_from_proc() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        assert!(os::listeners().iter().any(|r| r.port == port && r.pid == me && r.address == "127.0.0.1"));
        let list = PortsProbe::default().list(&[], None);
        let row = list.iter().find(|l| l.port == port).expect("own listener");
        assert_eq!(row.pid, me);
        assert!(row.own && row.started_at > 0);
        assert_eq!(row.addresses, vec!["127.0.0.1".to_string()]);
        // CI containers often run as root, which is a system uid.
        if unsafe { libc::getuid() } >= 1000 {
            assert!(!row.system && !os::is_system(me, None));
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn pid_one_is_a_system_process() {
        assert!(os::is_system(1, None));
    }

    /// Starts a real server, finds it in the list, stops its tree, and confirms it is gone.
    #[cfg(target_os = "linux")]
    #[test]
    fn lists_and_stops_a_spawned_server() {
        use std::process::{Command, Stdio};

        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let Ok(mut child) = Command::new("python3")
            .args(["-m", "http.server", &port.to_string(), "--bind", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            eprintln!("python3 is not installed; skipping");
            return;
        };
        let mut probe = PortsProbe::default();
        let deadline = Instant::now() + Duration::from_secs(10);
        let found = loop {
            if let Some(l) = probe.list(&[], None).into_iter().find(|l| l.port == port) {
                break Some(l);
            }
            if Instant::now() >= deadline {
                break None;
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let Some(found) = found else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the spawned server never appeared in the list");
        };
        let stopped = kill_tree(found.pid, found.started_at);
        // Reaping the child turns the zombie into a vanished pid.
        let _ = child.wait();
        let gone = !probe.list(&[], None).iter().any(|l| l.port == port);
        let _ = child.kill();
        assert_eq!(found.pid, child.id());
        assert!(found.command.contains("http.server"));
        stopped.unwrap();
        assert!(gone, "the server still listens after kill_tree");
    }

    #[cfg(windows)]
    #[test]
    fn parses_ipv4_rows() {
        let mut b = Vec::new();
        b.extend(1u32.to_ne_bytes());
        b.extend(2u32.to_ne_bytes()); // state LISTEN
        b.extend([127, 0, 0, 1]);
        b.extend([0x14, 0x45, 0, 0]); // 5189 in network order
        b.extend([0u8; 8]);
        b.extend(4242u32.to_ne_bytes());
        assert_eq!(os::parse4(&b), vec![raw(5189, "127.0.0.1", 4242)]);
    }

    #[cfg(windows)]
    #[test]
    fn parses_ipv6_rows() {
        let mut b = Vec::new();
        b.extend(1u32.to_ne_bytes());
        let mut local = [0u8; 16];
        local[15] = 1;
        b.extend(local);
        b.extend(0u32.to_ne_bytes()); // scope
        b.extend([0x0b, 0xb8, 0, 0]); // 3000
        b.extend([0u8; 16]);
        b.extend(0u32.to_ne_bytes());
        b.extend(0u32.to_ne_bytes());
        b.extend(2u32.to_ne_bytes());
        b.extend(77u32.to_ne_bytes());
        assert_eq!(os::parse6(&b), vec![raw(3000, "::1", 77)]);
    }

    #[cfg(windows)]
    #[test]
    fn reads_the_live_table() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let me = std::process::id();
        assert!(os::listeners().iter().any(|r| r.port == port && r.pid == me));
        let list = PortsProbe::default().list(&[], None);
        let row = list.iter().find(|l| l.port == port).expect("own listener");
        assert_eq!(row.pid, me);
        assert!(!row.system && row.own);
        assert!(row.started_at > 0);
    }
}
