/// Clipboard text, or None when the clipboard holds no text (an image, or nothing).
/// Read natively because WebView2 gates navigator.clipboard.readText behind a permission prompt.
#[tauri::command]
pub fn clipboard_read_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
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
#[tauri::command]
pub fn clipboard_write_files(paths: Vec<String>, cut: bool) -> Result<(), String> {
    write_files(&paths, cut)
}

/// The clipboard's file list, from this app or another (File Explorer's Copy or Cut); None when
/// it holds no files.
#[tauri::command]
pub fn clipboard_read_files() -> Option<ClipboardFiles> {
    read_files().filter(|f| !f.paths.is_empty())
}

/// Empties the clipboard, after a cut is pasted, as File Explorer does, so a second paste does
/// not look for files that moved.
#[tauri::command]
pub fn clipboard_clear() {
    if let Ok(mut c) = arboard::Clipboard::new() {
        let _ = c.clear();
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

#[cfg(not(windows))]
fn write_files(paths: &[String], _cut: bool) -> Result<(), String> {
    let mut c = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    c.set().file_list(paths).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
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
