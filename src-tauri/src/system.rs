//! Machine load and per-session process figures for the dashboard's System and Claude sections
//! (docs/design.md section 4.6).
//!
//! The sampler persists between calls because CPU, network, and per-process CPU are deltas
//! between two refreshes; a reading whose previous refresh is missing or too old is reported as
//! `None` rather than averaged over the gap.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use sysinfo::{Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::State;

/// A delta over a longer gap than this is stale (the section was hidden or collapsed).
const MAX_DELTA_GAP: Duration = Duration::from_secs(5);

/// Name fragments of loopback and virtual adapters, matched case-insensitively.
const VIRTUAL_ADAPTERS: &[&str] = &[
    "loopback",
    "vethernet",
    "virtualbox",
    "vmware",
    "hyper-v",
    "isatap",
    "teredo",
    "wsl",
    "docker",
    "tap-",
    "npcap",
];

/// Microsoft's OUI, used by Hyper-V virtual adapters.
const HYPER_V_MAC: [u8; 3] = [0x00, 0x15, 0x5d];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskRow {
    pub mount: String,
    pub total_bytes: u64,
    pub available_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSample {
    pub cpu_percent: Option<f32>,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub net_rx_per_sec: Option<f64>,
    pub net_tx_per_sec: Option<f64>,
    /// `None` when the caller did not ask for disks on this sample.
    pub disks: Option<Vec<DiskRow>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcFigures {
    pub pid: u32,
    pub memory_bytes: u64,
    /// Percent of the whole machine, as Task Manager shows it.
    pub cpu_percent: Option<f32>,
}

/// One process as `descendant_sums` sees it; `cpu` is sysinfo's per-core percentage.
#[derive(Debug, Clone, Copy)]
struct ProcEntry {
    parent: Option<u32>,
    start: u64,
    memory: u64,
    cpu: f32,
}

pub struct SystemSampler {
    sys: System,
    networks: Networks,
    disks: Option<Disks>,
    last_cpu_net: Option<Instant>,
    last_procs: Option<Instant>,
}

impl Default for SystemSampler {
    fn default() -> Self {
        Self {
            sys: System::new(),
            networks: Networks::new(),
            disks: None,
            last_cpu_net: None,
            last_procs: None,
        }
    }
}

/// The sampler, shared with the blocking tasks the commands run on.
#[derive(Default)]
pub struct SystemState(Arc<Mutex<SystemSampler>>);

fn fresh(last: Option<Instant>, now: Instant) -> Option<Duration> {
    let gap = now.checked_duration_since(last?)?;
    (gap <= MAX_DELTA_GAP).then_some(gap)
}

/// Whether an adapter counts toward the network rates: loopback and virtual adapters do not.
/// sysinfo on Windows already skips interfaces with no physical address.
fn counted_adapter(name: &str, mac: [u8; 6]) -> bool {
    let lower = name.to_lowercase();
    if VIRTUAL_ADAPTERS.iter().any(|v| lower.contains(v)) {
        return false;
    }
    mac[..3] != HYPER_V_MAC
}

/// `C:\` as `C:`; anything that is not a drive root (a mounted folder, a network path) is `None`.
fn drive_root(mount: &Path) -> Option<String> {
    let s = mount.to_str()?;
    let b = s.as_bytes();
    (b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        .then(|| s[..2].to_ascii_uppercase())
}

/// Memory and CPU per root, summed over the root and its descendants. A child started before
/// its parent is skipped: Windows reuses a dead parent's pid. Roots no longer in the table are
/// omitted.
fn descendant_sums(
    table: &HashMap<u32, ProcEntry>,
    roots: &[u32],
    cpu_count: usize,
) -> Vec<ProcFigures> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, entry) in table {
        if let Some(parent) = entry.parent {
            children.entry(parent).or_default().push(pid);
        }
    }
    let cpus = cpu_count.max(1) as f32;
    roots
        .iter()
        .filter(|root| table.contains_key(root))
        .map(|&root| {
            let mut visited = HashSet::from([root]);
            let mut queue = VecDeque::from([root]);
            let (mut memory, mut cpu) = (0u64, 0f32);
            while let Some(pid) = queue.pop_front() {
                let entry = &table[&pid];
                memory += entry.memory;
                cpu += entry.cpu;
                for &child in children.get(&pid).into_iter().flatten() {
                    if table[&child].start >= entry.start && visited.insert(child) {
                        queue.push_back(child);
                    }
                }
            }
            ProcFigures {
                pid: root,
                memory_bytes: memory,
                cpu_percent: Some(cpu / cpus),
            }
        })
        .collect()
}

impl SystemSampler {
    pub fn sample(&mut self, include_disks: bool, now: Instant) -> SystemSample {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.networks.refresh(true);
        let gap = fresh(self.last_cpu_net, now);
        self.last_cpu_net = Some(now);

        let (rx, tx) = self
            .networks
            .iter()
            .filter(|(name, data)| counted_adapter(name, data.mac_address().0))
            .fold((0u64, 0u64), |(rx, tx), (_, d)| {
                (rx + d.received(), tx + d.transmitted())
            });
        let secs = gap.map(|g| g.as_secs_f64()).filter(|s| *s > 0.0);

        let disks = include_disks.then(|| {
            let disks = match &mut self.disks {
                Some(d) => {
                    d.refresh(true);
                    d
                }
                None => self.disks.insert(Disks::new_with_refreshed_list()),
            };
            let mut rows: Vec<DiskRow> = disks
                .iter()
                .filter(|d| !d.is_removable())
                .filter_map(|d| {
                    Some(DiskRow {
                        mount: drive_root(d.mount_point())?,
                        total_bytes: d.total_space(),
                        available_bytes: d.available_space(),
                    })
                })
                .collect();
            rows.sort_by(|a, b| a.mount.cmp(&b.mount));
            rows
        });

        SystemSample {
            cpu_percent: gap.map(|_| self.sys.global_cpu_usage()),
            memory_used_bytes: self.sys.used_memory(),
            memory_total_bytes: self.sys.total_memory(),
            net_rx_per_sec: secs.map(|s| rx as f64 / s),
            net_tx_per_sec: secs.map(|s| tx as f64 / s),
            disks,
        }
    }

    pub fn processes(&mut self, roots: &[u32], now: Instant) -> Vec<ProcFigures> {
        self.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory().with_cpu(),
        );
        let cpu_fresh = fresh(self.last_procs, now).is_some();
        self.last_procs = Some(now);

        let table: HashMap<u32, ProcEntry> = self
            .sys
            .processes()
            .iter()
            .map(|(pid, p)| {
                (
                    pid.as_u32(),
                    ProcEntry {
                        parent: p.parent().map(|pp| pp.as_u32()),
                        start: p.start_time(),
                        memory: p.memory(),
                        cpu: p.cpu_usage(),
                    },
                )
            })
            .collect();
        let cpu_count = std::thread::available_parallelism().map_or(1, |n| n.get());
        let mut figures = descendant_sums(&table, roots, cpu_count);
        if !cpu_fresh {
            for f in &mut figures {
                f.cpu_percent = None;
            }
        }
        figures
    }
}

#[tauri::command]
pub async fn system_sample(
    state: State<'_, SystemState>,
    include_disks: bool,
) -> Result<SystemSample, String> {
    let sampler = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sampler.lock().map_err(|e| e.to_string())?;
        Ok(s.sample(include_disks, Instant::now()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn claude_processes(
    state: State<'_, SystemState>,
    pids: Vec<u32>,
) -> Result<Vec<ProcFigures>, String> {
    let sampler = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sampler.lock().map_err(|e| e.to_string())?;
        Ok(s.processes(&pids, Instant::now()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: [u8; 6] = [0x3c, 0x7c, 0x3f, 0x01, 0x02, 0x03];

    #[test]
    fn counts_physical_adapters_only() {
        assert!(counted_adapter("Ethernet", MAC));
        assert!(counted_adapter("Wi-Fi", MAC));
        assert!(!counted_adapter("Loopback Pseudo-Interface 1", MAC));
        assert!(!counted_adapter("vEthernet (WSL)", MAC));
        assert!(!counted_adapter("VirtualBox Host-Only Network", MAC));
        assert!(!counted_adapter(
            "Ethernet 3",
            [0x00, 0x15, 0x5d, 0xaa, 0xbb, 0xcc]
        ));
    }

    #[test]
    fn drive_roots_only() {
        assert_eq!(drive_root(Path::new("C:\\")), Some("C:".into()));
        assert_eq!(drive_root(Path::new("d:\\")), Some("D:".into()));
        assert_eq!(drive_root(Path::new("C:\\mnt\\data")), None);
        assert_eq!(drive_root(Path::new("\\\\server\\share\\")), None);
    }

    fn table(entries: &[(u32, Option<u32>, u64, u64, f32)]) -> HashMap<u32, ProcEntry> {
        entries
            .iter()
            .map(|&(pid, parent, start, memory, cpu)| {
                (
                    pid,
                    ProcEntry {
                        parent,
                        start,
                        memory,
                        cpu,
                    },
                )
            })
            .collect()
    }

    #[test]
    fn sums_descendants() {
        let t = table(&[
            (1, None, 100, 1000, 10.0),
            (2, Some(1), 110, 200, 4.0),
            (3, Some(2), 120, 30, 2.0),
            (4, Some(1), 105, 4, 0.0),
            (9, None, 100, 50_000, 50.0),
            // A reused pid: its parent 1 was started after it.
            (5, Some(1), 50, 7_000, 8.0),
        ]);
        let figs = descendant_sums(&t, &[1], 4);
        assert_eq!(
            figs,
            vec![ProcFigures {
                pid: 1,
                memory_bytes: 1234,
                cpu_percent: Some(4.0)
            }]
        );
    }

    #[test]
    fn cycle_terminates_and_missing_root_omitted() {
        let t = table(&[(1, Some(2), 100, 1, 0.0), (2, Some(1), 100, 2, 0.0)]);
        let figs = descendant_sums(&t, &[1, 77], 1);
        assert_eq!(
            figs,
            vec![ProcFigures {
                pid: 1,
                memory_bytes: 3,
                cpu_percent: Some(0.0)
            }]
        );
    }

    #[test]
    fn second_sample_fills_cpu_and_network() {
        let mut s = SystemSampler::default();
        let t0 = Instant::now();
        let first = s.sample(false, t0);
        assert!(first.cpu_percent.is_none());
        assert!(first.net_rx_per_sec.is_none() && first.net_tx_per_sec.is_none());
        assert!(first.memory_total_bytes > 0 && first.memory_used_bytes > 0);
        assert!(first.disks.is_none());

        std::thread::sleep(Duration::from_millis(300));
        let second = s.sample(false, t0 + Duration::from_secs(2));
        assert!(second.cpu_percent.is_some());
        assert!(second.net_rx_per_sec.is_some() && second.net_tx_per_sec.is_some());

        let stale = s.sample(false, t0 + Duration::from_secs(10));
        assert!(stale.cpu_percent.is_none());
    }

    #[test]
    fn disks_only_when_asked() {
        let mut s = SystemSampler::default();
        assert!(s.sample(false, Instant::now()).disks.is_none());
        let rows = s
            .sample(true, Instant::now())
            .disks
            .expect("disks requested");
        assert!(rows.iter().any(|r| r.mount == "C:" && r.total_bytes > 0));
        let mounts: Vec<_> = rows.iter().map(|r| r.mount.clone()).collect();
        let mut sorted = mounts.clone();
        sorted.sort();
        assert_eq!(mounts, sorted);
    }

    /// Kills the spawned tree however the test ends.
    #[cfg(windows)]
    struct TreeGuard(std::process::Child);

    #[cfg(windows)]
    impl Drop for TreeGuard {
        fn drop(&mut self) {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &self.0.id().to_string()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(windows)]
    #[test]
    fn sums_a_spawned_tree() {
        use std::os::windows::process::CommandExt;

        let child = std::process::Command::new("cmd.exe")
            .raw_arg("/c ping -n 20 127.0.0.1 >nul")
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd");
        let guard = TreeGuard(child);
        let cmd_pid = guard.0.id();

        let mut s = SystemSampler::default();
        let deadline = Instant::now() + Duration::from_secs(10);
        let ping_pid = loop {
            s.sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            let found = s.sys.processes().iter().find(|(_, p)| {
                p.parent().map(|pp| pp.as_u32()) == Some(cmd_pid)
                    && p.name().to_string_lossy().eq_ignore_ascii_case("ping.exe")
            });
            if let Some((pid, _)) = found {
                break pid.as_u32();
            }
            assert!(Instant::now() < deadline, "ping never appeared under cmd");
            std::thread::sleep(Duration::from_millis(100));
        };

        let figs = s.processes(&[cmd_pid], Instant::now());
        let mem = |pid: u32| {
            s.sys
                .process(sysinfo::Pid::from_u32(pid))
                .map_or(0, |p| p.memory())
        };
        let (cmd_mem, ping_mem) = (mem(cmd_pid), mem(ping_pid));
        assert_eq!(figs.len(), 1);
        assert_eq!(figs[0].pid, cmd_pid);
        assert!(cmd_mem > 0 && ping_mem > 0);
        assert!(figs[0].memory_bytes >= cmd_mem + ping_mem);
        drop(guard);
    }
}
