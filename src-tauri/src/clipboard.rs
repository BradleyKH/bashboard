/// Clipboard text, or None when the clipboard holds no text (an image, or nothing).
/// Read natively because WebView2 gates navigator.clipboard.readText behind a permission prompt.
/// Reads run off the main thread (`async`); on Linux they go through GTK's clipboard
/// (`clipboard_linux.rs`), which hands each request back to the main thread and waits.
#[tauri::command(async)]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Option<String> {
    #[cfg(target_os = "linux")]
    return crate::clipboard_linux::read_text(&app);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        arboard::Clipboard::new().ok()?.get_text().ok()
    }
}

/// Files on the clipboard; `cut` when the app that put them there asked for a move.
#[derive(serde::Serialize)]
pub struct ClipboardFiles {
    paths: Vec<String>,
    cut: bool,
}

/// Puts a file list on the clipboard, where File Explorer pastes it too. Windows also gets
/// Explorer's "Preferred DropEffect", so a cut pastes as a move there; elsewhere the front end
/// remembers its own cut.
#[tauri::command(async)]
pub fn clipboard_write_files(
    app: tauri::AppHandle,
    paths: Vec<String>,
    cut: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = cut;
        crate::clipboard_linux::write_files(&app, &paths)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        write_files(&paths, cut)
    }
}

/// The clipboard's file list, from this app or another (File Explorer's Copy or Cut); None when
/// it holds no files. Off the main thread, as `clipboard_read_text` explains.
#[tauri::command(async)]
pub fn clipboard_read_files(app: tauri::AppHandle) -> Option<ClipboardFiles> {
    #[cfg(target_os = "linux")]
    let files =
        crate::clipboard_linux::read_files(&app).map(|paths| ClipboardFiles { paths, cut: false });
    #[cfg(not(target_os = "linux"))]
    let files = {
        let _ = app;
        read_files()
    };
    files.filter(|f| !f.paths.is_empty())
}

/// Empties the clipboard, after a cut is pasted, as File Explorer does, so a second paste does
/// not look for files that moved.
#[tauri::command]
pub fn clipboard_clear(app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    crate::clipboard_linux::clear(&app);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        if let Ok(mut c) = arboard::Clipboard::new() {
            let _ = c.clear();
        }
    }
}

#[cfg(windows)]
const DROPEFFECT_COPY: u32 = 1;
#[cfg(windows)]
const DROPEFFECT_MOVE: u32 = 2;
#[cfg(windows)]
const DROPEFFECT_LINK: u32 = 4;

#[cfg(windows)]
fn write_files(paths: &[String], cut: bool) -> Result<(), String> {
    use clipboard_win::{Clipboard, options::DoClear, raw, register_format};
    let _open = Clipboard::new_attempts(10).map_err(|e| format!("clipboard busy: {e}"))?;
    raw::set_file_list_with(paths, DoClear).map_err(|e| e.to_string())?;
    let effect = if cut {
        DROPEFFECT_MOVE
    } else {
        DROPEFFECT_COPY | DROPEFFECT_LINK
    };
    if let Some(format) = register_format("Preferred DropEffect") {
        raw::set_without_clear(format.get(), &effect.to_le_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn read_files() -> Option<ClipboardFiles> {
    use clipboard_win::{Clipboard, raw, register_format};
    let _open = Clipboard::new_attempts(10).ok()?;
    let mut paths = Vec::new();
    raw::get_file_list(&mut paths).ok()?;
    let mut effect = Vec::new();
    let cut = register_format("Preferred DropEffect")
        .is_some_and(|f| raw::get_vec(f.get(), &mut effect).is_ok())
        && effect.len() >= 4
        && u32::from_le_bytes([effect[0], effect[1], effect[2], effect[3]])
            & (DROPEFFECT_MOVE | DROPEFFECT_COPY)
            == DROPEFFECT_MOVE;
    Some(ClipboardFiles { paths, cut })
}

#[cfg(target_os = "macos")]
fn write_files(paths: &[String], _cut: bool) -> Result<(), String> {
    let mut c = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    c.set().file_list(paths).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn read_files() -> Option<ClipboardFiles> {
    let paths = arboard::Clipboard::new().ok()?.get().file_list().ok()?;
    Some(ClipboardFiles {
        paths: paths
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        cut: false,
    })
}
