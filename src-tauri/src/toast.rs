//! Windows toast notifications for terminals that need the user (design section 4.7). Clicking
//! a toast brings the window forward and emits `toast://activated` with the pane id, so the
//! front end can focus that pane.

use tauri::{AppHandle, Emitter, Manager};

/// The AppUserModelID toasts are sent under. The installer's Start menu shortcut registers the
/// bundle identifier, so an installed build uses it; a debug build has no such shortcut, and
/// Windows drops toasts from an unregistered id, so it borrows PowerShell's.
#[cfg(windows)]
fn app_id(app: &AppHandle) -> String {
    if cfg!(debug_assertions) {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

#[cfg(windows)]
fn bring_forward(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
pub fn toast_show(app: AppHandle, title: String, body: String, pane_id: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{Duration, Toast};
        let id = app_id(&app);
        let handle = app.clone();
        Toast::new(&id)
            .title(&title)
            .text1(&body)
            .duration(Duration::Short)
            .on_activated(move |_| {
                bring_forward(&handle);
                let _ = handle.emit("toast://activated", pane_id.clone());
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body, pane_id);
        Ok(())
    }
}
