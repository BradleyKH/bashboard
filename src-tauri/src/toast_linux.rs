//! Linux notifications for terminals that need the user (docs/design/sessions.md section 4.7),
//! over the freedesktop `org.freedesktop.Notifications` D-Bus interface. Same contract as the
//! Windows toast: clicking one brings the window forward and emits `toast://activated` with the
//! pane id.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;

use notify_rust::Notification;
use tauri::{AppHandle, Emitter, Manager};

use crate::app_log::stamp;

/// Notifications still waiting for a click or a close. Each one parks a thread on the session bus
/// until the daemon reports the notification gone, and a daemon that drops it silently would hold
/// that thread for the rest of the process, so past this many a notification is shown without
/// waiting (it appears, but clicking it does nothing).
const MAX_WAITERS: usize = 32;

static WAITERS: AtomicUsize = AtomicUsize::new(0);
static WARNED_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

/// Frees a waiter slot when the thread ends, however it ends.
struct Slot;

impl Drop for Slot {
    fn drop(&mut self) {
        WAITERS.fetch_sub(1, Ordering::Relaxed);
    }
}

fn take_slot() -> Option<Slot> {
    let taken = WAITERS.fetch_add(1, Ordering::Relaxed);
    if taken >= MAX_WAITERS {
        WAITERS.fetch_sub(1, Ordering::Relaxed);
        return None;
    }
    Some(Slot)
}

/// Sends a notification and returns at once; the send and the wait for a click both happen on a
/// background thread, which `on_default` runs on when the user clicks the notification body.
/// No session bus or no notification daemon is logged once and otherwise ignored.
pub fn send(
    title: &str,
    body: &str,
    on_default: impl FnOnce() + Send + 'static,
) -> std::io::Result<JoinHandle<()>> {
    let mut notification = Notification::new();
    // "bashboard" is the icon name the .deb installs under hicolor; a build with no installed
    // icon (AppImage, dev) falls back to the daemon's generic one. The "default" action is the
    // one daemons trigger on a click of the notification body.
    notification
        .appname("Bashboard")
        .icon("bashboard")
        .summary(title)
        .body(body)
        .action("default", "Open");
    std::thread::Builder::new().name("toast-linux".into()).spawn(move || {
        let handle = match notification.show() {
            Ok(handle) => handle,
            Err(err) => {
                if !WARNED_UNAVAILABLE.swap(true, Ordering::Relaxed) {
                    eprintln!("{} notifications not shown: {err}", stamp());
                }
                return;
            }
        };
        let Some(_slot) = take_slot() else { return };
        // The closure also runs with "__closed" when the daemon reports the notification closed
        // without a click, which ends the wait.
        handle.wait_for_action(|action| {
            if action == "default" {
                on_default();
            }
        });
    })
}

/// Posts a notification for a pane; clicking it brings the main window forward and focuses it.
pub fn show(app: &AppHandle, title: &str, body: &str, pane_id: &str) {
    let app = app.clone();
    let pane_id = pane_id.to_string();
    let result = send(title, body, move || {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = handle.emit("toast://activated", pane_id);
        });
    });
    if let Err(err) = result {
        eprintln!("{} notification thread not started: {err}", stamp());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waiter_slots_are_capped_and_released() {
        let slots: Vec<Slot> = (0..MAX_WAITERS).map(|_| take_slot().expect("slot")).collect();
        assert!(take_slot().is_none());
        drop(slots);
        assert!(take_slot().is_some());
    }

    /// Needs a session bus, so it runs by hand: under `dbus-run-session` with `dbus-monitor` the
    /// Notify call shows with the summary and a "default" action; without a bus it returns.
    #[test]
    #[ignore]
    fn sends_a_notification_without_panicking() {
        let thread = send("Bashboard test", "A pane is waiting", || {}).expect("thread");
        // Without a notification daemon the send fails and the thread ends; with one it waits
        // for a click, so give the call time to go out and leave the thread behind.
        std::thread::sleep(std::time::Duration::from_secs(2));
        if thread.is_finished() {
            thread.join().expect("the thread must not panic");
        }
    }
}
