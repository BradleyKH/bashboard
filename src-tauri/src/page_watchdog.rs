//! Hung-page watchdog (docs/design/app.md section 3.22). `crash_recovery` handles a page whose
//! process died; this handles one that is alive but stuck, such as a script in a loop, which
//! WebView2 reports as unresponsive and then leaves alone. The core pings the page every few
//! seconds as an event, which a hidden page still runs promptly (only its timers are throttled),
//! and the page answers with `page_pong`. Once answers stop, the user is asked whether to
//! reload; ptys outlive the page, so a reload loses only what the stuck page could not save.

use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

use crate::app_log::stamp;

const PING_EVERY: Duration = Duration::from_secs(5);
/// Long enough for a heavy restore or a big paste; a page this late is not coming back.
const HUNG_AFTER: Duration = Duration::from_secs(30);

/// When the page last answered, in ms since the epoch. 0 means no page has answered since the
/// last load began, so a page still starting up is never taken for a hung one.
static LAST_PONG: AtomicU64 = AtomicU64::new(0);
/// When the watchdog last reloaded the page, or 0. A page still silent `HUNG_AFTER` after that
/// is rebuilt along with its WebView.
static RELOADED_AT: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn page_pong() {
    LAST_PONG.store(now_ms(), Ordering::SeqCst);
    RELOADED_AT.store(0, Ordering::SeqCst);
}

/// Stops judging the current page, for a reload or rebuild started elsewhere; the next page's
/// first answer arms the watchdog again.
pub fn disarm() {
    LAST_PONG.store(0, Ordering::SeqCst);
    RELOADED_AT.store(0, Ordering::SeqCst);
}

/// Debug builds skip the watchdog, since a page paused at a DevTools breakpoint looks hung;
/// `BASHBOARD_WATCHDOG=1` turns it on to test it.
pub fn start(app: &AppHandle) {
    if cfg!(debug_assertions) && std::env::var_os("BASHBOARD_WATCHDOG").is_none() {
        return;
    }
    let app = app.clone();
    let spawned = thread::Builder::new()
        .name("page-watchdog".into())
        .spawn(move || {
            loop {
                thread::sleep(PING_EVERY);
                let Some(window) = app.get_webview_window("main") else {
                    continue;
                };
                let _ = window.emit("watchdog://ping", ());
                let last = LAST_PONG.load(Ordering::SeqCst);
                if last == 0 {
                    continue;
                }
                // Time spent minimized does not count against the page.
                if window.is_minimized().unwrap_or(false) {
                    LAST_PONG.store(now_ms(), Ordering::SeqCst);
                    continue;
                }
                if now_ms().saturating_sub(last) > HUNG_AFTER.as_millis() as u64 {
                    recover(&app, &window);
                }
            }
        });
    if let Err(e) = spawned {
        eprintln!("page watchdog: could not start: {e}");
    }
}

fn recover(app: &AppHandle, window: &tauri::WebviewWindow) {
    if RELOADED_AT.load(Ordering::SeqCst) != 0 {
        eprintln!(
            "{} the page did not come back after a reload; rebuilding the window",
            stamp()
        );
        disarm();
        crate::crash_recovery::begin_rebuild(window);
        return;
    }
    eprintln!(
        "{} the page has not answered for {}s",
        stamp(),
        HUNG_AFTER.as_secs()
    );
    let reload = app
        .dialog()
        .message(
            "Bashboard's window has stopped responding. Reloading it keeps your shells running, \
             but unsaved text in editors may be lost.",
        )
        .title("Bashboard is not responding")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Reload".into(),
            "Wait".into(),
        ))
        .parent(window)
        .blocking_show_with_result();
    eprintln!(
        "{} watchdog dialog answered: {choice:?}",
        stamp(),
        choice = reload
    );
    let reload = matches!(reload, MessageDialogResult::Custom(ref s) if s == "Reload");
    let now = now_ms();
    // The page may have answered while the dialog was up, and waiting buys another full period.
    let recovered =
        now.saturating_sub(LAST_PONG.load(Ordering::SeqCst)) <= HUNG_AFTER.as_millis() as u64;
    if !reload || recovered {
        if !recovered {
            LAST_PONG.store(now, Ordering::SeqCst);
        }
        return;
    }
    eprintln!("{} reloading the unresponsive page", stamp());
    LAST_PONG.store(now, Ordering::SeqCst);
    RELOADED_AT.store(now, Ordering::SeqCst);
    app.state::<crate::browser::BrowserState>().reset();
    if let Err(e) = window.reload() {
        eprintln!("{} could not reload the page: {e}", stamp());
    }
}
