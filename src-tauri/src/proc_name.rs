//! A process's program name. sysinfo's `name()` is the executable's name on Windows and macOS,
//! but on Linux it is the kernel's `comm`: cut to 15 bytes, and renamed whenever a program names
//! its main thread (Node 24 calls its main thread `MainThread`, so every Node process reads
//! `MainThread`). On Linux the command line settles the name.

use sysinfo::{Process, ProcessRefreshKind, UpdateKind};

/// The refresh a process list needs before `name` can see past `comm`. A command line is read
/// once per process, since sysinfo keeps it. Threads are left out: on Linux sysinfo otherwise
/// lists every thread as a process of its own (elsewhere this changes nothing).
pub fn refresh_kind() -> ProcessRefreshKind {
    if cfg!(target_os = "linux") {
        ProcessRefreshKind::nothing().without_tasks().with_cmd(UpdateKind::OnlyIfNotSet)
    } else {
        ProcessRefreshKind::nothing().without_tasks()
    }
}

/// `p`'s program name: sysinfo's name, corrected on Linux from the command line when it was
/// read (`refresh_kind`).
pub fn name(p: &Process) -> String {
    let comm = p.name().to_string_lossy();
    if !cfg!(target_os = "linux") {
        return comm.into_owned();
    }
    let args: Vec<String> = p.cmd().iter().take(2).map(|a| a.to_string_lossy().into_owned()).collect();
    from_comm(&comm, &args)
}

/// The name from `comm` and the first two arguments. `argv[0]`'s base name wins when `comm` is
/// a cut-off copy of it, or when `comm` matches neither it nor the script it runs (a renamed
/// thread). A script started by its shebang keeps `comm`, which the kernel sets to the script's
/// name, and an `argv[0]` rewritten into a title (`sshd: user@pts/0`) is ignored.
fn from_comm(comm: &str, args: &[String]) -> String {
    let base = |s: &str| s.rsplit('/').next().unwrap_or_default().to_string();
    let Some(first) = args.first() else {
        return comm.to_string();
    };
    if first.contains(|c: char| c.is_whitespace() || c == ':') {
        return comm.to_string();
    }
    let argv0 = base(first).trim_start_matches('-').to_string();
    if argv0.is_empty() {
        return comm.to_string();
    }
    if comm.is_empty() || argv0.starts_with(comm) {
        return argv0;
    }
    match args.get(1) {
        Some(script) if base(script).starts_with(comm) => comm.to_string(),
        _ => argv0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name_of(comm: &str, args: &[&str]) -> String {
        from_comm(comm, &args.iter().map(|a| a.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn a_renamed_main_thread_takes_argv0() {
        assert_eq!(name_of("MainThread", &["node", "/repo/node_modules/vite/bin/vite.js"]), "node");
        assert_eq!(name_of("MainThread", &["/usr/bin/node", "/usr/lib/node_modules/@github/copilot/index.js"]), "node");
    }

    #[test]
    fn a_cut_off_comm_takes_the_full_name() {
        assert_eq!(name_of("WebKitWebProces", &["/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess", "9"]), "WebKitWebProcess");
    }

    #[test]
    fn matching_names_and_login_shells_stay() {
        assert_eq!(name_of("claude", &["claude"]), "claude");
        assert_eq!(name_of("bash", &["-bash"]), "bash");
        assert_eq!(name_of("python3", &["python3", "-m", "http.server"]), "python3");
    }

    #[test]
    fn a_shebang_script_keeps_its_name() {
        assert_eq!(name_of("deploy.py", &["/usr/bin/python3", "./deploy.py"]), "deploy.py");
    }

    #[test]
    fn titles_and_missing_command_lines_keep_comm() {
        assert_eq!(name_of("sshd", &["sshd: bradley@pts/0"]), "sshd");
        assert_eq!(name_of("kworker/0:1", &[]), "kworker/0:1");
        assert_eq!(name_of("bash", &[""]), "bash");
    }
}
