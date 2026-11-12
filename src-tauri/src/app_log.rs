//! The release build's log file (docs/design/app.md section 3.22). A GUI-subsystem process has
//! no stderr, so every `eprintln!` in the core is dropped; pointing the stderr handle at a file
//! keeps them. Rust's stderr looks the handle up on every write, so redirecting it once at
//! startup covers every later `eprintln!` without touching the call sites.

use std::time::{SystemTime, UNIX_EPOCH};

/// The current UTC time as `2026-11-11 17:43:05Z`, to prefix the lines that mark an event.
pub fn stamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format_utc(secs)
}

fn format_utc(secs: u64) -> String {
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Logs each panic as one stamped line naming its thread. Release builds unwind, so a panic
/// ends only its own thread and the app keeps running; this line is the only trace it leaves.
/// Debug builds keep the default hook, which honors `RUST_BACKTRACE`.
pub fn install_panic_hook() {
    if cfg!(debug_assertions) {
        return;
    }
    std::panic::set_hook(Box::new(|info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        eprintln!("{} panic on thread '{name}': {info}", stamp());
    }));
}

/// An uncaught error the page reports. The page caps how often it sends; the length is capped
/// here too, since the page is the less trusted side.
#[tauri::command]
pub fn frontend_error(text: String) {
    let text: String = text.chars().take(4000).collect();
    eprintln!("{} page: {text}", stamp());
}

/// Debug builds keep stderr on the terminal that ran `pnpm tauri dev`, so only release builds
/// redirect it.
#[cfg(all(windows, not(debug_assertions)))]
pub fn init(app: &tauri::AppHandle) {
    use std::fs::{self, OpenOptions};
    use std::os::windows::io::IntoRawHandle;
    use tauri::Manager;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE};

    /// Past this size the file is set aside as `bashboard.old.log` at startup, so the log keeps
    /// at most two sessions' worth of growth without a rotation scheme.
    const MAX_BYTES: u64 = 1024 * 1024;

    let Ok(dir) = app.path().app_log_dir() else { return };
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("bashboard.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(&path, dir.join("bashboard.old.log"));
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(&path) else { return };
    // The handle stays open for the life of the process, as a real stderr would.
    let handle = HANDLE(file.into_raw_handle());
    if unsafe { SetStdHandle(STD_ERROR_HANDLE, handle) }.is_ok() {
        eprintln!("{} Bashboard {} started", stamp(), app.package_info().version);
    }
}

#[cfg(not(all(windows, not(debug_assertions))))]
pub fn init(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_times() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00Z");
        assert_eq!(format_utc(951_782_400), "2000-02-29 00:00:00Z");
        assert_eq!(format_utc(1_794_418_985), "2026-11-11 17:43:05Z");
    }
}
