//! The Local Browser's file server (docs/design/browser.md section 3.21): mounts, request path
//! resolution, trust levels, the loopback listeners, and the commands a pane calls. The threat
//! model these serve is docs/design/security.md section 9.1.

pub mod paths;
pub mod server;
pub mod trust;
pub mod watch;

use std::sync::OnceLock;

use tauri::{AppHandle, Manager, State};

use crate::browser::BrowserState;
use crate::settings::SettingsState;
use server::{Config, Env, FileServer, Served};

/// The app's file server, started on the first file a pane opens.
#[derive(Default)]
pub struct FileServerState(OnceLock<FileServer>);

impl FileServerState {
    /// Revokes a closed pane's tokens, if the server has started.
    pub fn detach(&self, pane_id: &str) {
        if let Some(server) = self.0.get() {
            server.detach(pane_id);
        }
    }

    /// See `FileServer::downloaded_scope`; `None` before the server starts.
    pub fn downloaded_scope(&self, url: &str) -> Option<String> {
        self.0.get()?.downloaded_scope(url)
    }
}

fn start(app: &AppHandle, home: std::path::PathBuf) -> FileServer {
    // The navigation policy refuses the dev server's port on every loopback host (4.21), so
    // a mount must never listen there. Release builds are not served over loopback.
    let reserved_port = if cfg!(debug_assertions) {
        app.config()
            .build
            .dev_url
            .as_ref()
            .and_then(|u| u.port_or_known_default())
    } else {
        None
    };
    let emit_app = app.clone();
    let settings_app = app.clone();
    FileServer::new(
        Config {
            home,
            mounts_file: crate::config_dir::config_dir(app).map(|d| d.join(server::MOUNTS_FILE)),
            reserved_port,
        },
        Env {
            emit: Box::new(move |pane, event| emit_app.state::<BrowserState>().emit(pane, event)),
            settings: Box::new(move || {
                settings_app
                    .state::<SettingsState>()
                    .current()
                    .local_browser
            }),
        },
    )
}

/// Serves the `file:///` URL `file_url` to the pane, reusing its live token for the file's mount
/// and listener when it holds one.
#[tauri::command]
pub fn browser_serve_file(
    app: AppHandle,
    state: State<'_, FileServerState>,
    pane_id: String,
    file_url: String,
) -> Result<Served, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home folder: {e}"))?;
    let file = server::file_url_to_path(&file_url)?;
    state
        .0
        .get_or_init(|| start(&app, home))
        .serve_file(&pane_id, &file)
}

/// Stops watching the pane's file once its frame shows something else; its tokens stay live.
#[tauri::command]
pub fn browser_unwatch_file(state: State<'_, FileServerState>, pane_id: String) {
    if let Some(server) = state.0.get() {
        server.unwatch(&pane_id);
    }
}
