//! Brings the main window forward when nothing hands the app a launch token (docs/design/app.md
//! section 3.18). A second launch from a file manager's Open in Bashboard reaches the running
//! instance with only its arguments: Dolphin passes no `DESKTOP_STARTUP_ID` or
//! `XDG_ACTIVATION_TOKEN`, so GTK's own raise carries no user timestamp and KWin's focus-stealing
//! prevention refuses it, leaving the new tab behind the file manager. On X11 the window asks the
//! window manager directly with `_NET_ACTIVE_WINDOW` from a pager (EWMH source indication 2), which
//! window managers honor as the user's own request, as when a taskbar entry is clicked. Wayland has
//! no such request; there the GDK window is not an X11 one and this does nothing.

use gtk::glib::Cast;
use gtk::prelude::WidgetExt;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ClientMessageEvent, ConnectionExt, EventMask};

/// EWMH's source indication for a pager or taskbar, which window managers do not second-guess.
const SOURCE_PAGER: u32 = 2;

/// Asks the window manager to activate `window` when it is an X11 window; a no-op otherwise. Must
/// run on the main thread, like every GTK call.
pub fn activate(window: &tauri::WebviewWindow) {
    let Ok(gtk_window) = window.gtk_window() else { return };
    let Some(gdk_window) = gtk_window.window() else { return };
    let Ok(x11_window) = gdk_window.downcast::<gdkx11::X11Window>() else { return };
    if let Err(err) = send_active_window(x11_window.xid() as u32) {
        eprintln!("{} could not ask the window manager to raise the window: {err}", crate::app_log::stamp());
    }
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
    #[ignore]
    fn raises_the_named_window() {
        let xid: u32 = std::env::var("RAISE_XID").expect("RAISE_XID").parse().expect("a window id");
        super::send_active_window(xid).expect("the request is sent");
    }
}
