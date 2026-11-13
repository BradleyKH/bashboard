//! Listening TCP ports for the dashboard's Ports section and the Ports pane
//! (docs/design/containers.md section 4.19).
//!
//! Each listener carries its owning process and, when the process was started from a pane, that
//! pane's pty id, so a server launched in the background still says where it came from.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::State;

use crate::hooks::Hooks;
use crate::pty::{console_host, PtyInfo, Ptys};

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
    /// A Windows service or the kernel (session 0), which the dashboard leaves out.
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

/// Programs whose descendants count as started from a terminal: shells and Claude Code.
const SHELLS: &[&str] = &["bash.exe", "sh.exe", "zsh.exe", "fish.exe", "cmd.exe", "pwsh.exe", "powershell.exe", "nu.exe", "claude.exe", "codex.exe", "copilot.exe"];

fn is_shell(name: &str) -> bool {
    SHELLS.iter().any(|s| name.eq_ignore_ascii_case(s))
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
                .with_environ(UpdateKind::OnlyIfNotSet),
        );
        let procs: HashMap<u32, Proc> = self
            .sys
            .processes()
            .iter()
            .map(|(pid, p)| (pid.as_u32(), Proc { parent: p.parent().map(|pp| pp.as_u32()), start: p.start_time() }))
            .collect();
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
                system: os::is_system(pid),
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
                .filter(|p| start >= p.started_at / 1000)
                .find(|p| {
                    let shell_start = procs.get(&p.pid).map(|s| s.start).unwrap_or(0);
                    self.host(p.pid, shell_start) == Some(host)
                })
                .map(|p| p.id)
        })
        .or_else(|| {
            let id = inherited_pane(self.sys.process(Pid::from_u32(pid))?.environ(), hook_url)?;
            // A process older than the pane holds an id from a previous run of this app.
            ptys.iter().find(|p| p.id == id && start >= p.started_at / 1000).map(|p| p.id)
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

/// Ends the listening process and everything it started (taskkill /T), so a dev server's
/// workers go with it.
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
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        crate::editors::hide_console(&mut cmd);
        let out = cmd.output().map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(if msg.is_empty() { format!("taskkill exited with {}", out.status) } else { msg })
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
    pub fn is_system(pid: u32) -> bool {
        let mut session = 0u32;
        pid <= 4 || unsafe { ProcessIdToSessionId(pid, &mut session) } == 0 || session == 0
    }
}

#[cfg(not(windows))]
mod os {
    use super::RawListener;

    pub fn listeners() -> Vec<RawListener> {
        Vec::new()
    }

    // No session-0 equivalent to key on, so nothing is hidden as a system port.
    pub fn is_system(_pid: u32) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(port: u16, address: &str, pid: u32) -> RawListener {
        RawListener { port, address: address.into(), pid }
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
