//! Brings the main window forward when nothing hands the app a launch token (docs/design/app.md
//! section 3.18). A second launch from a file manager's Open in Bashboard reaches the running
//! instance with only its arguments: Dolphin passes no `DESKTOP_STARTUP_ID` or
//! `XDG_ACTIVATION_TOKEN`, so GTK's own raise carries no user timestamp and KWin's focus-stealing
//! prevention refuses it, leaving the new tab behind the file manager. On X11 the window asks the
//! window manager directly with `_NET_ACTIVE_WINDOW` from a pager (EWMH source indication 2), which
//! window managers honor as the user's own request, as when a taskbar entry is clicked.
//!
//! Wayland has no such request: a client raises itself only with an xdg-activation token, and
//! Dolphin's service menu passes none on Plasma 5.27 Wayland either. KWin's scripting interface on
//! the session bus is the way left: a one-line script that makes the window active runs inside the
//! compositor, which focus-stealing prevention does not apply to (kdotool works the same way).
//! Other Wayland compositors (Mutter) offer nothing comparable, so there the tab opens behind.

use gtk::glib::Cast;
use gtk::prelude::WidgetExt;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ClientMessageEvent, ConnectionExt, EventMask};

/// EWMH's source indication for a pager or taskbar, which window managers do not second-guess.
const SOURCE_PAGER: u32 = 2;

/// Asks the window manager to activate `window`: through `_NET_ACTIVE_WINDOW` when it is an X11
/// window, else through a KWin script. Must run on the main thread, like every GTK call; the KWin
/// calls move to a thread of their own.
pub fn activate(window: &tauri::WebviewWindow) {
    let Ok(gtk_window) = window.gtk_window() else { return };
    let Some(gdk_window) = gtk_window.window() else { return };
    let result = match gdk_window.downcast::<gdkx11::X11Window>() {
        Ok(x11_window) => send_active_window(x11_window.xid() as u32),
        Err(_) => {
            let spawned = std::thread::Builder::new()
                .name("kwin-raise".into())
                .spawn(|| {
                    if let Err(err) = kwin_activate(std::process::id()) {
                        let stamp = crate::app_log::stamp();
                        eprintln!("{stamp} could not ask KWin to raise the window: {err}");
                    }
                });
            spawned.map(drop).map_err(Into::into)
        }
    };
    if let Err(err) = result {
        let stamp = crate::app_log::stamp();
        eprintln!("{stamp} could not ask the window manager to raise the window: {err}");
    }
}

const KWIN: &str = "org.kde.KWin";
const SCRIPT_NAME: &str = "bashboard-raise";

/// A KWin script that activates the normal windows of process `pid`. Plasma 6 names the list
/// and the active window `windowList` and `activeWindow`, Plasma 5 `clientList` and
/// `activeClient`.
fn kwin_script(pid: u32) -> String {
    const SCRIPT: &str = r#"const list = workspace.windowList
  ? workspace.windowList()
  : workspace.clientList();
for (const w of list) {
  if (w.pid === PID && w.normalWindow) {
    if ("activeWindow" in workspace) workspace.activeWindow = w; else workspace.activeClient = w;
  }
}
"#;
    SCRIPT.replace("PID", &pid.to_string())
}

/// Loads, runs, and unloads `kwin_script`. KWin reads the script from a file, so it is written
/// to the runtime folder first. Fails without KWin on the session bus.
fn kwin_activate(pid: u32) -> Result<(), Box<dyn std::error::Error>> {
    let conn = zbus::blocking::Connection::session()?;
    let scripting = Some("org.kde.kwin.Scripting");
    let unload = || {
        conn.call_method(Some(KWIN), "/Scripting", scripting, "unloadScript", &(SCRIPT_NAME,))
    };
    let dir = std::env::var_os("XDG_RUNTIME_DIR").map_or_else(std::env::temp_dir, Into::into);
    let file = dir.join(format!("{SCRIPT_NAME}-{pid}.js"));
    std::fs::write(&file, kwin_script(pid))?;
    // A script left loaded by an earlier failure would make the load return -1.
    let _ = unload();
    let path = file.to_string_lossy().into_owned();
    let loaded = conn.call_method(
        Some(KWIN),
        "/Scripting",
        scripting,
        "loadScript",
        &(path.as_str(), SCRIPT_NAME),
    );
    // KWin reads the file when the script runs, so it stays until then.
    let ran = loaded
        .map_err(Into::into)
        .and_then(|reply| -> Result<(), Box<dyn std::error::Error>> {
            let id: i32 = reply.body().deserialize()?;
            if id < 0 {
                return Err("KWin did not load the script".into());
            }
            let object = format!("/{id}");
            conn.call_method(Some(KWIN), object.as_str(), Some("org.kde.kwin.Script"), "run", &())?;
            Ok(())
        });
    let _ = unload();
    let _ = std::fs::remove_file(&file);
    ran
}

fn send_active_window(xid: u32) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let atom = conn.intern_atom(false, b"_NET_ACTIVE_WINDOW")?.reply()?.atom;
    // data: source indication, timestamp (0, current), the requestor's active window (none).
    let event = ClientMessageEvent::new(32, xid, atom, [SOURCE_PAGER, 0, 0, 0, 0]);
    // Checked, so the server has taken the request before the connection closes.
    conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event)?.check()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    /// Needs an X11 session, so it runs by hand: with another window active,
    /// `RAISE_XID=<id> cargo test -- --ignored raises_the_named_window` brings window `<id>`
    /// (from `xdotool search`) to the front.
    #[test]
    fn the_kwin_script_names_the_process() {
        let script = super::kwin_script(4242);
        assert!(script.contains("w.pid === 4242 && w.normalWindow"));
        assert!(!script.contains("PID"));
    }

    /// Needs a KWin session, so it runs by hand: with another window active,
    /// `RAISE_PID=<pid> cargo test -- --ignored kwin_raises_the_process` brings that process's
    /// window to the front.
    #[test]
    #[ignore]
    fn kwin_raises_the_process() {
        let pid: u32 = std::env::var("RAISE_PID").expect("RAISE_PID").parse().expect("a pid");
        super::kwin_activate(pid).expect("KWin ran the script");
    }

    #[test]
    #[ignore]
    fn raises_the_named_window() {
        let xid: u32 = std::env::var("RAISE_XID").expect("RAISE_XID").parse().expect("a window id");
        super::send_active_window(xid).expect("the request is sent");
    }
}
