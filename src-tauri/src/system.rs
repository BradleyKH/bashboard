//! Machine load for the dashboard's System section (docs/design/dashboard.md section 4.6).
//!
//! The sampler persists between calls because CPU and network are deltas
//! between two refreshes; a reading whose previous refresh is missing or too old is reported as
//! `None` rather than averaged over the gap.

use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Serialize;
use sysinfo::{
    Disks, Networks, Pid, ProcessRefreshKind, ProcessesToUpdate, System,
    MINIMUM_CPU_UPDATE_INTERVAL,
};
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

/// One program in the top-processes popup: every process sharing an executable name, summed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessGroup {
    pub name: String,
    pub count: u32,
    /// Share of the whole machine, on the same 0 to 100 scale as `SystemSample::cpu_percent`.
    pub cpu_percent: f32,
    /// Summed working sets, so pages shared between the group's processes count more than once.
    pub memory_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProcesses {
    pub by_cpu: Vec<ProcessGroup>,
    pub by_memory: Vec<ProcessGroup>,
}

pub struct SystemSampler {
    sys: System,
    networks: Networks,
    disks: Option<Disks>,
    last_cpu_net: Option<Instant>,
    last_processes: Option<Instant>,
}

impl Default for SystemSampler {
    fn default() -> Self {
        Self {
            sys: System::new(),
            networks: Networks::new(),
            disks: None,
            last_cpu_net: None,
            last_processes: None,
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

/// Folders whose direct mounts are user volumes: macOS's external drives, and Linux's
/// conventional places for extra disks.
const UNIX_VOLUME_PARENTS: &[&str] = &["/Volumes/", "/mnt/", "/media/", "/run/media/"];

/// `/` and the user volumes under `UNIX_VOLUME_PARENTS`, as their mount paths. Everything else
/// is left out: macOS's APFS system volumes under `/System/Volumes` share the root's container
/// and would count its space again, and Linux's `/boot`, tmpfs, and snap mounts are not disks a
/// user thinks of.
fn unix_volume(mount: &Path) -> Option<String> {
    let s = mount.to_str()?;
    let user_volume = UNIX_VOLUME_PARENTS
        .iter()
        .any(|parent| s.strip_prefix(parent).is_some_and(|rest| !rest.is_empty()));
    (s == "/" || user_volume).then(|| s.to_string())
}

/// The label a disk row shows: a drive letter on Windows, a mount path elsewhere.
fn disk_label(mount: &Path) -> Option<String> {
    if cfg!(windows) { drive_root(mount) } else { unix_volume(mount) }
}

/// `chrome.exe` as `chrome`; grouping ignores case, keeping the first spelling seen.
fn group_name(name: &str) -> &str {
    let n = name.len();
    if n > 4 && name[n - 4..].eq_ignore_ascii_case(".exe") {
        &name[..n - 4]
    } else {
        name
    }
}

/// Sums processes into groups by name and returns the `limit` busiest by CPU and by memory.
fn top_groups(
    procs: impl Iterator<Item = (String, f32, u64)>,
    cpu_count: usize,
    limit: usize,
) -> TopProcesses {
    let mut groups: HashMap<String, ProcessGroup> = HashMap::new();
    let cores = cpu_count.max(1) as f32;
    for (name, cpu, mem) in procs {
        let display = group_name(&name);
        let g = groups
            .entry(display.to_lowercase())
            .or_insert_with(|| ProcessGroup {
                name: display.to_string(),
                count: 0,
                cpu_percent: 0.0,
                memory_bytes: 0,
            });
        g.count += 1;
        // sysinfo reports a process's CPU as a share of one core.
        g.cpu_percent += cpu / cores;
        g.memory_bytes += mem;
    }
    let all: Vec<ProcessGroup> = groups.into_values().collect();

    let mut by_cpu: Vec<ProcessGroup> = all
        .iter()
        .filter(|g| g.cpu_percent > 0.0)
        .cloned()
        .collect();
    by_cpu.sort_by(|a, b| {
        b.cpu_percent
            .total_cmp(&a.cpu_percent)
            .then_with(|| a.name.cmp(&b.name))
    });
    by_cpu.truncate(limit);

    let mut by_memory = all;
    by_memory.sort_by(|a, b| {
        b.memory_bytes
            .cmp(&a.memory_bytes)
            .then_with(|| a.name.cmp(&b.name))
    });
    by_memory.truncate(limit);

    TopProcesses { by_cpu, by_memory }
}

impl SystemSampler {
    /// Process CPU is a delta like the machine's: without a fresh previous refresh, this takes
    /// two refreshes a moment apart so the first call after a pause still reports CPU.
    pub fn top_processes(&mut self, limit: usize) -> TopProcesses {
        let kind = ProcessRefreshKind::nothing().with_cpu().with_memory();
        if fresh(self.last_processes, Instant::now()).is_none() {
            self.sys
                .refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
            std::thread::sleep(MINIMUM_CPU_UPDATE_INTERVAL);
        }
        self.sys
            .refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
        self.last_processes = Some(Instant::now());
        if self.sys.cpus().is_empty() {
            self.sys.refresh_cpu_usage();
        }
        let procs = self
            .sys
            .processes()
            .iter()
            // The idle process's "CPU" is the machine's idle time.
            .filter(|(pid, _)| **pid != Pid::from(0))
            .map(|(_, p)| {
                (
                    p.name().to_string_lossy().into_owned(),
                    p.cpu_usage(),
                    p.memory(),
                )
            });
        top_groups(procs, self.sys.cpus().len(), limit)
    }

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
                        mount: disk_label(d.mount_point())?,
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
pub async fn system_top_processes(
    state: State<'_, SystemState>,
    limit: usize,
) -> Result<TopProcesses, String> {
    let sampler = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut s = sampler.lock().map_err(|e| e.to_string())?;
        Ok(s.top_processes(limit))
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

    #[test]
    fn unix_volumes_are_the_root_and_user_mounts() {
        for keep in ["/", "/Volumes/Backup", "/mnt/data", "/media/usb", "/run/media/me/stick"] {
            assert_eq!(unix_volume(Path::new(keep)).as_deref(), Some(keep), "{keep}");
        }
        for skip in [
            "/System/Volumes/Data",
            "/System/Volumes/VM",
            "/boot",
            "/boot/efi",
            "/dev/shm",
            "/snap/core/1",
            "/Volumes/",
            "/mnt",
        ] {
            assert_eq!(unix_volume(Path::new(skip)), None, "{skip}");
        }
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
        let system = if cfg!(windows) { "C:" } else { "/" };
        assert!(rows.iter().any(|r| r.mount == system && r.total_bytes > 0), "{rows:?}");
        let mounts: Vec<_> = rows.iter().map(|r| r.mount.clone()).collect();
        let mut sorted = mounts.clone();
        sorted.sort();
        assert_eq!(mounts, sorted);
    }

    #[test]
    fn groups_by_name_and_ranks() {
        let procs = vec![
            ("chrome.exe".to_string(), 40.0, 300),
            ("Chrome.EXE".to_string(), 20.0, 200),
            ("code.exe".to_string(), 80.0, 100),
            ("idle-thing".to_string(), 0.0, 50),
        ];
        let top = top_groups(procs.into_iter(), 4, 5);
        let cpu: Vec<_> = top
            .by_cpu
            .iter()
            .map(|g| (g.name.as_str(), g.count, g.cpu_percent))
            .collect();
        assert_eq!(cpu, vec![("code", 1, 20.0), ("chrome", 2, 15.0)]);
        let mem: Vec<_> = top
            .by_memory
            .iter()
            .map(|g| (g.name.as_str(), g.memory_bytes))
            .collect();
        assert_eq!(
            mem,
            vec![("chrome", 500), ("code", 100), ("idle-thing", 50)]
        );
        assert_eq!(top_groups(Vec::new().into_iter(), 0, 5).by_memory.len(), 0);
        let one = top_groups(
            vec![("a".to_string(), 1.0, 2), ("b".to_string(), 2.0, 1)].into_iter(),
            1,
            1,
        );
        assert_eq!(one.by_cpu[0].name, "b");
        assert_eq!(one.by_memory[0].name, "a");
    }

    #[test]
    fn real_processes_report_cpu_and_memory() {
        let mut s = SystemSampler::default();
        let top = s.top_processes(5);
        assert!(!top.by_memory.is_empty() && top.by_memory.len() <= 5);
        assert!(top.by_memory[0].memory_bytes > 0);
        assert!(top.by_cpu.iter().all(|g| g.cpu_percent <= 100.5));
    }
}
