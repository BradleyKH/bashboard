//! Recovery from a dead or hung WebView2 (docs/design/app.md section 3.22). The core and its
//! ptys outlive the page, so a crash of the browser process otherwise leaves a live app behind
//! a black window whose close button waits on a front end that will never answer.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

use crate::app_log::stamp;

const MAIN: &str = "main";

/// How long the front end's close handler gets to save before the window is closed without it.
/// Saving flushes scrollback for every pane, which takes well under a second in practice.
const CLOSE_GRACE: Duration = Duration::from_secs(8);

/// Set from the moment a dead WebView is noticed until its replacement is built, so the old
/// window's teardown does not end the app.
static REBUILDING: AtomicBool = AtomicBool::new(false);

/// Bumped per rebuilt window, so a close fallback armed on an old window cannot close its
/// replacement, which shares the `main` label.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Run-loop events: holds the app open and rebuilds the window after a crash, and closes a
/// window whose front end cannot finish its close handler.
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { .. }, .. } if label == MAIN => {
            arm_close_fallback(app)
        }
        RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. }
            if label == MAIN && REBUILDING.load(Ordering::SeqCst) =>
        {
            schedule_rebuild(app)
        }
        // Destroying the only window asks the app to exit right after the Destroyed event above.
        RunEvent::ExitRequested { code: None, api, .. } if REBUILDING.load(Ordering::SeqCst) => api.prevent_exit(),
        _ => {}
    }
}

/// The front end destroys the window itself once its close handler has saved the workspace,
/// so a window still open after the grace period has a page that is hung or gone.
fn arm_close_fallback(app: &AppHandle) {
    let generation = GENERATION.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLOSE_GRACE);
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(window) = app.get_webview_window(MAIN) {
            eprintln!("{} the page did not finish closing; closing the window without it", stamp());
            let _ = window.destroy();
        }
    });
}

/// Starts a rebuild by destroying the dead window; `on_run_event` builds the replacement once
/// the runtime has let go of it, since the new window needs the same label.
#[cfg_attr(not(windows), allow(dead_code))]
fn begin_rebuild(window: &tauri::WebviewWindow) {
    if REBUILDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let window = window.clone();
    // Off the WebView2 callback's stack: destroying the window from inside it re-enters WebView2.
    std::thread::spawn(move || {
        if let Err(e) = window.destroy() {
            eprintln!("{} could not close the dead window: {e}", stamp());
            REBUILDING.store(false, Ordering::SeqCst);
        }
    });
}

fn schedule_rebuild(app: &AppHandle) {
    let app = app.clone();
    // From another thread so the task queues behind the current event: run on the main thread
    // directly, it would build the new window while the runtime still holds the old one.
    std::thread::spawn(move || {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            GENERATION.fetch_add(1, Ordering::SeqCst);
            handle.state::<crate::browser::BrowserState>().reset();
            let built = crate::create_main_window(&handle);
            REBUILDING.store(false, Ordering::SeqCst);
            match built {
                Ok(window) => {
                    eprintln!("{} rebuilt the window", stamp());
                    crate::setup_main_window(&window);
                }
                Err(e) => {
                    // No window is left to show anything, so a live process would only hide
                    // the failure from the next launch.
                    eprintln!("{} could not rebuild the window, exiting: {e}", stamp());
                    handle.exit(1);
                }
            }
        });
    });
}

/// Watches the main window's WebView2 for failed processes. A dead browser process takes the
/// whole WebView with it, so the window is rebuilt; a dead page renderer only needs a reload.
/// Either way the front end starts over and restores the saved workspace.
#[cfg(windows)]
pub fn watch(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2ProcessFailedEventArgs2, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_REASON,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;

    let target = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(e) => return eprintln!("crash recovery: WebView2 core unavailable: {e}"),
        };
        let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            args.ProcessFailedKind(&mut kind)?;
            let (mut reason, mut exit_code) = (COREWEBVIEW2_PROCESS_FAILED_REASON::default(), 0i32);
            if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                let _ = args2.Reason(&mut reason);
                let _ = args2.ExitCode(&mut exit_code);
            }
            eprintln!(
                "{} WebView2 {} (reason {}, exit code {exit_code:#x})",
                stamp(),
                kind_name(kind.0),
                reason.0
            );
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                begin_rebuild(&target);
            } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                target.state::<crate::browser::BrowserState>().reset();
                if let Some(core) = sender {
                    core.Reload()?;
                }
            }
            // An unresponsive renderer can still recover, and reloading would kill every
            // pane's shell; the close fallback is the way out if it never does.
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
            eprintln!("crash recovery: could not watch WebView2 processes: {e}");
        }
    });
}

#[cfg(not(windows))]
pub fn watch(_window: &tauri::WebviewWindow) {}

/// The `COREWEBVIEW2_PROCESS_FAILED_KIND` values, for the log.
#[cfg_attr(not(windows), allow(dead_code))]
fn kind_name(kind: i32) -> &'static str {
    match kind {
        0 => "browser process exited",
        1 => "page renderer exited",
        2 => "page renderer unresponsive",
        3 => "frame renderer exited",
        4 => "utility process exited",
        5 => "sandbox helper exited",
        6 => "GPU process exited",
        7 => "PPAPI plugin exited",
        8 => "PPAPI broker exited",
        _ => "unknown process exited",
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::kind_name;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;

    #[test]
    fn kind_names_match_the_webview2_values() {
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED.0), "browser process exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0), "page renderer exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE.0), "page renderer unresponsive");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED.0), "frame renderer exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED.0), "utility process exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED.0), "sandbox helper exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED.0), "GPU process exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED.0), "PPAPI plugin exited");
        assert_eq!(kind_name(COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED.0), "PPAPI broker exited");
    }
}
