//! The clipboard on Linux, through GTK's own clipboard on the window's display connection.
//!
//! arboard speaks X11 only (it is built without its Wayland feature), and on a Wayland session
//! the window is a native Wayland client. Wayland lets only the focused client read the
//! clipboard, and KWin copies it into XWayland's selection only while an X11 window has focus,
//! so arboard's X11 window saw an empty or stale clipboard and a paste did nothing. GTK uses the
//! connection the window already holds: Wayland's data device on GNOME and KDE alike (Mutter has
//! no data-control protocol, so arboard's Wayland feature would not cover GNOME), and the X11
//! selection under X.
//!
//! GTK's clipboard lives on the main thread. The commands run off it and hand each request over
//! with `run_on_main_thread`, then wait for GTK's callback. The request itself is asynchronous,
//! so the main loop keeps running and can serve a selection Bashboard owns while it waits.

use std::sync::mpsc;
use std::time::Duration;

use gtk::glib;

/// How long a read waits for the clipboard's owner to answer.
const READ_TIMEOUT: Duration = Duration::from_secs(3);

/// The file list targets a file manager reads: `text/uri-list` (Dolphin, and the standard), and
/// GNOME's `x-special/gnome-copied-files` (Nautilus, Nemo), whose first line says copy or cut.
const URI_LIST: &str = "text/uri-list";
const GNOME_FILES: &str = "x-special/gnome-copied-files";
const PLAIN_TEXT: &str = "text/plain;charset=utf-8";

fn clipboard() -> gtk::Clipboard {
    gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD)
}

/// Runs `request` on the main thread with a sender for its answer, and waits for that answer.
fn ask<T: Send + 'static>(
    app: &tauri::AppHandle,
    request: impl FnOnce(mpsc::Sender<T>) + Send + 'static,
) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || request(tx)).ok()?;
    rx.recv_timeout(READ_TIMEOUT).ok()
}

pub fn read_text(app: &tauri::AppHandle) -> Option<String> {
    ask(app, |tx| {
        clipboard().request_text(move |_, text| {
            let _ = tx.send(text.map(str::to_owned));
        })
    })
    .flatten()
}

/// Local paths from the clipboard's URI list; None when it holds no `file:` URIs.
pub fn read_files(app: &tauri::AppHandle) -> Option<Vec<String>> {
    let uris = ask(app, |tx| {
        clipboard().request_uris(move |_, uris| {
            let _ = tx.send(uris.iter().map(|u| u.to_string()).collect::<Vec<_>>());
        })
    })?;
    let paths: Vec<String> = uris
        .iter()
        .filter_map(|u| glib::filename_from_uri(u).ok())
        .map(|(path, _)| path.to_string_lossy().into_owned())
        .collect();
    (!paths.is_empty()).then_some(paths)
}

/// Offers `paths` as a file list in each target a file manager reads, plus plain text (one path
/// per line) for a text field. GTK serves them for as long as Bashboard owns the clipboard.
pub fn write_files(app: &tauri::AppHandle, paths: &[String]) -> Result<(), String> {
    let uris: Vec<String> = paths
        .iter()
        .map(|p| glib::filename_to_uri(p, None).map(|u| u.to_string()))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let text = paths.join("\n");
    let set = ask(app, move |tx| {
        let flags = gtk::TargetFlags::empty();
        let targets = [
            gtk::TargetEntry::new(URI_LIST, flags, 0),
            gtk::TargetEntry::new(GNOME_FILES, flags, 1),
            gtk::TargetEntry::new(PLAIN_TEXT, flags, 2),
            gtk::TargetEntry::new("UTF8_STRING", flags, 2),
        ];
        let ok = clipboard().set_with_data(&targets, move |_, data, info| match info {
            0 => {
                let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                data.set_uris(&refs);
            }
            1 => {
                let body = gnome_copied_files(&uris);
                data.set(&data.target(), 8, body.as_bytes());
            }
            _ => {
                data.set_text(&text);
            }
        });
        let _ = tx.send(ok);
    });
    match set {
        Some(true) => Ok(()),
        _ => Err("could not take the clipboard".into()),
    }
}

pub fn clear(app: &tauri::AppHandle) {
    let _ = app.run_on_main_thread(|| clipboard().clear());
}

/// The `x-special/gnome-copied-files` body: the operation, then one URI per line.
fn gnome_copied_files(uris: &[String]) -> String {
    let mut body = String::from("copy");
    for uri in uris {
        body.push('\n');
        body.push_str(uri);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gnome_copied_files_starts_with_the_operation() {
        let uris = ["file:///home/a/x.txt".to_string(), "file:///home/a/My%20Dir".to_string()];
        assert_eq!(
            gnome_copied_files(&uris),
            "copy\nfile:///home/a/x.txt\nfile:///home/a/My%20Dir"
        );
    }

    #[test]
    fn paths_round_trip_through_file_uris() {
        let uri = glib::filename_to_uri("/home/a/My Dir/ü.txt", None).unwrap();
        assert_eq!(uri, "file:///home/a/My%20Dir/%C3%BC.txt");
        let (path, _) = glib::filename_from_uri(&uri).unwrap();
        assert_eq!(path.to_str(), Some("/home/a/My Dir/ü.txt"));
    }
}
