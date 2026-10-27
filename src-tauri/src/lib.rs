mod cli;
mod clipboard;
mod config_dir;
mod containers;
mod editors;
mod files;
mod git;
mod git_watch;
mod hook_install;
mod hooks;
mod links;
mod profiles;
mod pty;
mod roster;
mod search;
mod settings;
mod settings_edit;
mod setup;
mod workspace;

use tauri::Manager;

/// WebView2 claims browser shortcuts (Ctrl+F find, Ctrl+R reload, Ctrl+P print, zoom, ...)
/// before the page sees them; a terminal needs those keys delivered to the shell instead.
#[cfg(windows)]
fn disable_browser_accelerators(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let _ = window.with_webview(|webview| unsafe {
        let settings = webview
            .controller()
            .CoreWebView2()
            .and_then(|core| core.Settings())
            .and_then(|s| s.cast::<ICoreWebView2Settings3>());
        match settings {
            Ok(s) => {
                if let Err(e) = s.SetAreBrowserAcceleratorKeysEnabled(false) {
                    eprintln!("could not disable browser accelerator keys: {e}");
                }
            }
            Err(e) => eprintln!("WebView2 settings unavailable: {e}"),
        }
    });
    close_on_alt_f4(window);
}

/// With WebView2 focused, Alt+F4 never reaches the host window's default system-key handling,
/// so the window ignores it. Catch it as an accelerator and close the window ourselves; this
/// goes through CloseRequested, so the front end still saves the workspace first.
#[cfg(windows)]
fn close_on_alt_f4(window: &tauri::WebviewWindow) {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN;

    const VK_F4: u32 = 0x73;
    let target = window.clone();
    let _ = window.with_webview(move |webview| unsafe {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = Default::default();
            let mut key = 0u32;
            args.KeyEventKind(&mut kind)?;
            args.VirtualKey(&mut key)?;
            // A system key down for F4 means Alt is held.
            if kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN && key == VK_F4 {
                args.SetHandled(true)?;
                // Close from another thread so the close never runs inside this WebView2 callback.
                let w = target.clone();
                std::thread::spawn(move || {
                    let _ = w.close();
                });
            }
            Ok(())
        }));
        let mut token = 0i64;
        if let Err(e) = webview.controller().add_AcceleratorKeyPressed(&handler, &mut token) {
            eprintln!("could not register the Alt+F4 handler: {e}");
        }
    });
}

/// Closes the invoking window, used when its last pane closes.
#[tauri::command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::Ptys::default())
        .manage(settings::SettingsState::default())
        .manage(hooks::Hooks::default())
        .manage(roster::Roster::default())
        .manage(workspace::WorkspaceState::default())
        .manage(files::FilesState::default())
        .manage(git_watch::GitWatches::default())
        .manage(containers::ContainersState::default())
        .manage(search::SearchState::default())
        .setup(|app| {
            settings::init(app.handle());
            hooks::init(app.handle());
            roster::init(app.handle());
            workspace::init(app.handle());
            pty::init_activity(app.handle());
            containers::init(app.handle());
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                disable_browser_accelerators(&window);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            clipboard::clipboard_read_text,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            profiles::shell_profiles,
            close_window,
            links::open_url,
            links::open_folder,
            settings::settings_get,
            settings::settings_set,
            settings::settings_open_file,
            roster::sessions_get,
            hook_install::hooks_install_preview,
            hook_install::hooks_install,
            workspace::workspace_load,
            workspace::workspace_save,
            workspace::favorites_load,
            workspace::favorites_save,
            workspace::layouts_load,
            workspace::layouts_save,
            workspace::repos_load,
            workspace::repos_save,
            workspace::scratch_save,
            workspace::scratch_load,
            workspace::scratch_delete,
            workspace::scratch_save_as,
            files::repo_root,
            files::fs_list,
            files::fs_read_text,
            files::fs_write_text,
            files::fs_move,
            files::fs_watch,
            files::fs_unwatch,
            editors::editors,
            editors::open_in_editor,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_diff,
            git::git_log,
            git::git_show,
            git::git_commit,
            git::git_undo_commit,
            git_watch::git_watch,
            git_watch::git_unwatch,
            containers::containers_list,
            containers::containers_action,
            containers::containers_logs,
            containers::containers_logs_stop,
            containers::containers_stats,
            search::search_start,
            search::search_cancel,
            setup::setup_repo_candidates,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                containers::shutdown(app);
            }
        });
}
