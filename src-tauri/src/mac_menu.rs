//! The macOS menu bar (docs/design/keys.md section 4.5). It replaces Tauri's default menu, whose
//! Close Window item would take Cmd+W from the keymap and whose Quit would end the app without
//! the front end saving the workspace.
//!
//! WKWebView offers a Cmd chord to the page before the menu, so a chord the keymap handles never
//! reaches these items. The Edit items are still needed: without them Cmd+C, Cmd+V, Cmd+A, and
//! Cmd+Z do nothing in text fields. The default keymap stays off the Edit chords other than Cmd+C
//! and Cmd+V, which `keys.ts` handles in terminals before the menu would.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, Runtime};

const QUIT: &str = "quit";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let quit = MenuItem::with_id(app, QUIT, "Quit Bashboard", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Bashboard",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &window])
}

/// Quit closes the main window rather than exiting, so CloseRequested runs and the front end
/// saves the workspace and scrollback first; the app exits when its last window closes.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id() == QUIT {
        match app.get_webview_window("main") {
            Some(w) => {
                let _ = w.close();
            }
            None => app.exit(0),
        }
    }
}
