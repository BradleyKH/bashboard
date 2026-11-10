mod agents;
mod backdrop_image;
mod browser;
mod browser_files;
pub mod browser_policy;
mod browser_tls;
mod cli;
mod clipboard;
mod config_dir;
mod containers;
mod credential_store;
mod editors;
mod files;
mod fonts;
mod forge;
mod git;
mod git_branches;
mod git_fetch;
mod git_install;
mod git_watch;
mod git_worktrees;
mod hook_install;
mod hooks;
mod links;
mod login_path;
mod model_servers;
mod platform;
mod ports;
mod powershell_prompt;
mod profiles;
mod pty;
mod roster;
mod search;
mod second_instance;
mod settings;
mod settings_edit;
mod setup;
mod shell_integration;
mod system;
mod toast;
mod transcript;
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

/// The main window, from its `tauri.conf.json` entry (which has `create: false` so it is built
/// here). Debug builds give WebView2 its own data folder: the installed app shares the
/// identifier, and WebView2 refuses a second process on one folder with different browser
/// arguments, which is what `pnpm tauri:debug`'s remote debugging port adds.
fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .unwrap_or_default();
    let builder = tauri::WebviewWindowBuilder::from_config(app, &config)?;
    #[cfg(debug_assertions)]
    let builder = match app.path().app_local_data_dir() {
        Ok(dir) => builder.data_directory(dir.join("dev")),
        Err(_) => builder,
    };
    builder.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    login_path::adopt();
    let builder = tauri::Builder::default();
    // Release builds only: the lock is keyed on the app identifier, which debug builds share,
    // and a dev run has to start beside the installed app. Registered first so a second
    // launch exits before any other plugin starts.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        second_instance::on_second_launch(app, args, cwd)
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::Ptys::default())
        .manage(settings::SettingsState::default())
        .manage(hooks::Hooks::default())
        .manage(roster::Roster::default())
        .manage(workspace::WorkspaceState::default())
        .manage(files::FilesState::default())
        .manage(git_watch::GitWatches::default())
        .manage(git_fetch::GitFetches::default())
        .manage(containers::ContainersState::default())
        .manage(search::SearchState::default())
        .manage(system::SystemState::default())
        .manage(ports::PortsState::default())
        .manage(transcript::Transcripts::default())
        .manage(forge::ForgeState::default())
        .manage(browser::BrowserState::default())
        .manage(browser_files::FileServerState::default())
        .manage(second_instance::StartupFolder::from_args())
        .setup(|app| {
            let window = create_main_window(app.handle())?;
            settings::init(app.handle());
            git_fetch::init(app.handle());
            transcript::init(app.handle());
            hooks::init(app.handle());
            roster::init(app.handle());
            workspace::init(app.handle());
            pty::init_activity(app.handle());
            containers::init(app.handle());
            #[cfg(windows)]
            disable_browser_accelerators(&window);
            #[cfg(windows)]
            browser::init(&window);
            #[cfg(not(windows))]
            let _ = window;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            agents::agents_detected,
            backdrop_image::backdrop_image_read,
            backdrop_image::backdrop_image_list,
            backdrop_image::backdrop_image_pick,
            browser::browser_attach,
            browser::browser_detach,
            browser::browser_history,
            browser::browser_reload,
            browser::browser_replace,
            browser::browser_response_body,
            browser::browser_focus,
            browser::browser_chords,
            browser_files::browser_serve_file,
            browser_files::browser_unwatch_file,
            browser_tls::browser_probe_tls,
            browser_tls::browser_prefer_tls,
            clipboard::clipboard_read_text,
            platform::platform_info,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list,
            profiles::shell_profiles,
            close_window,
            second_instance::startup_folder_take,
            shell_integration::shell_integration_preview,
            shell_integration::shell_integration_install,
            git_install::git_install_status,
            git_install::git_install,
            links::open_url,
            links::open_folder,
            settings::settings_get,
            settings::settings_set,
            settings::settings_keybindings_edit,
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
            workspace::pins_load,
            workspace::pins_save,
            workspace::scratch_save,
            workspace::scratch_load,
            workspace::scratch_delete,
            workspace::scratch_save_as,
            workspace::scrollback_save_all,
            workspace::scrollback_load,
            toast::toast_show,
            files::repo_root,
            files::fs_list,
            files::fs_read_text,
            files::fs_read_bytes,
            files::fs_write_text,
            files::fs_move,
            files::fs_rename,
            files::fs_watch,
            files::fs_unwatch,
            editors::editors,
            editors::open_in_editor,
            editors::can_open_with_default_app,
            editors::open_with_default_app,
            fonts::fonts,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_diff,
            git::git_log,
            git::git_show,
            git::git_commit,
            git::git_undo_commit,
            git_branches::git_branches,
            git_branches::git_switch,
            git_branches::git_checkout_remote,
            git_branches::git_create_branch,
            git_branches::git_rename_branch,
            git_branches::git_delete_branch,
            git_branches::git_restore_branch,
            git_fetch::git_fetch,
            git_fetch::git_pull,
            git_fetch::git_push,
            git_fetch::git_last_fetch,
            git_fetch::git_fetch_roots,
            git_fetch::git_fetch_visible,
            git_watch::git_watch,
            git_watch::git_unwatch,
            git_worktrees::git_worktrees,
            git_worktrees::git_worktree_detail,
            git_worktrees::git_primary_branch,
            git_worktrees::git_worktree_remove,
            containers::containers_list,
            containers::containers_action,
            containers::containers_engine_start,
            containers::containers_engine_stop,
            containers::containers_logs,
            containers::containers_logs_stop,
            containers::containers_stats,
            search::search_start,
            search::search_cancel,
            setup::setup_repo_candidates,
            system::system_sample,
            system::system_top_processes,
            ports::ports_list,
            model_servers::model_servers_poll,
            model_servers::model_servers_ollama_models,
            ports::ports_stop,
            transcript::agent_context,
            transcript::agent_context_stop,
            forge::forge_repo,
            forge::forge_runs,
            forge::forge_jobs,
            forge::forge_log,
            forge::forge_rerun,
            forge::forge_cancel,
            forge::forge_pulls,
            forge::forge_pull_checks,
            forge::forge_overview_repo,
            forge::forge_set_account,
            forge::accounts::forge_auth_status,
            forge::accounts::forge_auth_test,
            forge::accounts::forge_set_token,
            forge::accounts::forge_clear_token,
            forge::accounts::forge_gh_switch,
            forge::accounts::forge_gh_logout,
            forge::accounts::forge_glab_logout,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                containers::shutdown(app);
            }
        });
}
