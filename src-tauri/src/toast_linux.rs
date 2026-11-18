//! Linux notifications for terminals that need the user (docs/design/sessions.md section 4.7),
//! over the freedesktop `org.freedesktop.Notifications` D-Bus interface. Same contract as the
//! Windows toast: clicking one brings the window forward and emits `toast://activated` with the
//! pane id. The daemon sends an activation token before the click, and the window comes forward
//! with it, since KWin and Mutter refuse a raise without one (focus-stealing prevention).

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;

use notify_rust::Notification;
use tauri::{AppHandle, Emitter, Manager};
use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type as MessageType;
use zbus::MatchRule;

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

/// A notification daemon signal, reduced to what `click_outcome` reads.
#[derive(Debug, PartialEq)]
enum Signal {
    Token(u32, String),
    Action(u32, String),
    Closed(u32),
}

fn signal(msg: &zbus::Message) -> Option<Signal> {
    let header = msg.header();
    let body = msg.body();
    match header.member()?.as_str() {
        "ActivationToken" => body.deserialize::<(u32, String)>().ok().map(|(id, t)| Signal::Token(id, t)),
        "ActionInvoked" => body.deserialize::<(u32, String)>().ok().map(|(id, a)| Signal::Action(id, a)),
        "NotificationClosed" => body.deserialize::<(u32, u32)>().ok().map(|(id, _)| Signal::Closed(id)),
        _ => None,
    }
}

/// How notification `id` ended, from the daemon's signals in order: `Some` when its body was
/// clicked, holding the activation token the daemon sent just before the click (if it sent one),
/// or `None` when it closed without a click.
fn click_outcome(id: u32, signals: impl IntoIterator<Item = Signal>) -> Option<Option<String>> {
    let mut token = None;
    for s in signals {
        match s {
            Signal::Token(n, t) if n == id => token = Some(t),
            Signal::Action(n, a) if n == id && a == "default" => return Some(token),
            Signal::Closed(n) if n == id => return None,
            _ => {}
        }
    }
    None
}

/// The daemon's signals, subscribed before the notification shows so a quick click is not
/// missed. The connection is returned too, since the iterator reads from it.
fn subscribe() -> zbus::Result<(Connection, MessageIterator)> {
    let conn = Connection::session()?;
    let rule = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .interface("org.freedesktop.Notifications")?
        .path("/org/freedesktop/Notifications")?
        .build();
    let signals = MessageIterator::for_match_rule(rule, &conn, Some(16))?;
    Ok((conn, signals))
}

/// Sends a notification and returns at once; the send and the wait for a click both happen on a
/// background thread, which `on_default` runs on, with the daemon's activation token, when the
/// user clicks the notification body. No session bus or no notification daemon is logged once and
/// otherwise ignored.
pub fn send(
    title: &str,
    body: &str,
    on_default: impl FnOnce(Option<String>) + Send + 'static,
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
        let subscribed = subscribe();
        let handle = match notification.show() {
            Ok(handle) => handle,
            Err(err) => {
                if !WARNED_UNAVAILABLE.swap(true, Ordering::Relaxed) {
                    eprintln!("{} notifications not shown: {err}", stamp());
                }
                return;
            }
        };
        let (_conn, signals) = match subscribed {
            Ok(s) => s,
            Err(err) => {
                eprintln!("{} notification clicks not watched: {err}", stamp());
                return;
            }
        };
        let Some(_slot) = take_slot() else { return };
        let events = signals.filter_map(Result::ok).filter_map(|m| signal(&m));
        if let Some(token) = click_outcome(handle.id(), events) {
            on_default(token);
        }
    })
}

/// Posts a notification for a pane; clicking it brings the main window forward and focuses it.
pub fn show(app: &AppHandle, title: &str, body: &str, pane_id: &str) {
    let app = app.clone();
    let pane_id = pane_id.to_string();
    let result = send(title, body, move |token| {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = handle.get_webview_window("main") {
                if let (Some(token), Ok(gtk_window)) = (token, window.gtk_window()) {
                    // GTK reads the click's timestamp from the token on X11 and passes the token
                    // to xdg-activation on Wayland, then activates the mapped window.
                    use gtk::prelude::GtkWindowExt;
                    gtk_window.set_startup_id(&token);
                }
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
    fn a_click_carries_the_token_sent_before_it() {
        let signals = vec![
            Signal::Token(7, "other".into()),
            Signal::Token(6, "quarky;1;2;3_TIME42".into()),
            Signal::Action(6, "default".into()),
            Signal::Closed(6),
        ];
        assert_eq!(click_outcome(6, signals), Some(Some("quarky;1;2;3_TIME42".into())));
    }

    #[test]
    fn a_click_without_a_token_still_counts() {
        let signals = vec![Signal::Action(3, "default".into()), Signal::Closed(3)];
        assert_eq!(click_outcome(3, signals), Some(None));
    }

    #[test]
    fn a_close_or_another_notification_is_not_a_click() {
        let signals = vec![Signal::Action(9, "default".into()), Signal::Closed(4)];
        assert_eq!(click_outcome(4, signals), None);
        assert_eq!(click_outcome(4, vec![Signal::Action(4, "other".into())]), None);
    }

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
        let thread = send("Bashboard test", "A pane is waiting", |_| {}).expect("thread");
        // Without a notification daemon the send fails and the thread ends; with one it waits
        // for a click, so give the call time to go out and leave the thread behind.
        std::thread::sleep(std::time::Duration::from_secs(2));
        if thread.is_finished() {
            thread.join().expect("the thread must not panic");
        }
    }
}
