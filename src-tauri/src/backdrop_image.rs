//! Local image files for the Image and Slideshow backdrop styles (docs/design.md section 6.5).
//!
//! The webview's CSP allows images only from the app itself, so the front end never loads a path
//! directly: it asks for the bytes here and decodes them with `createImageBitmap`. Only files with
//! an image extension are served, which keeps these commands from reading arbitrary files.
use std::path::{Path, PathBuf};

use crate::settings::expand_env;

/// Extensions WebView2 can decode; matched case-insensitively.
pub const IMAGE_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "avif", "bmp", "gif"];

/// Larger files are refused rather than read into memory whole.
const MAX_BYTES: u64 = 100 * 1024 * 1024;
/// A folder listing stops here, so pointing the slideshow at a drive root stays bounded.
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 16;

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| IMAGE_EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn read_image(path: &Path) -> Result<Vec<u8>, String> {
    if !is_image(path) {
        return Err(format!("{} is not a supported image ({})", path.display(), IMAGE_EXTENSIONS.join(", ")));
    }
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_BYTES {
        return Err(format!("{} is larger than {} MB", path.display(), MAX_BYTES / (1024 * 1024)));
    }
    std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Image files under `root`, sorted case-insensitively by full path.
fn list_images(root: &Path, recursive: bool) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut found = Vec::new();
    let mut pending: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = pending.pop() {
        // An unreadable subfolder is skipped; only the root itself must be readable.
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(e) if depth == 0 => return Err(format!("{}: {e}", dir.display())),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                // file_type does not follow links, so a junction or symlinked folder is never
                // entered and a link loop cannot run the walk forever.
                if recursive && depth < MAX_DEPTH {
                    pending.push((path, depth + 1));
                }
            } else if is_image(&path) {
                found.push(path.to_string_lossy().into_owned());
                if found.len() >= MAX_FILES {
                    pending.clear();
                    break;
                }
            }
        }
    }
    found.sort_by_key(|p| p.to_lowercase());
    Ok(found)
}

/// The image's bytes, sent as a raw binary response (an `ArrayBuffer` in the front end).
#[tauri::command]
pub async fn backdrop_image_read(path: String) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || read_image(Path::new(&expand_env(&path))))
        .await
        .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn backdrop_image_list(folder: String, include_subfolders: bool) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_images(Path::new(&expand_env(&folder)), include_subfolders))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens the native picker for an image file, or for a folder when `folder` is true. `None` means
/// the dialog was cancelled.
#[tauri::command]
pub async fn backdrop_image_pick(app: tauri::AppHandle, folder: bool, current: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // The blocking dialog call must stay off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        let current = PathBuf::from(expand_env(&current));
        let start = if folder { Some(current.as_path()) } else { current.parent() };
        if let Some(start) = start.filter(|p| p.is_dir()) {
            dialog = dialog.set_directory(start);
        }
        let picked = if folder {
            dialog.blocking_pick_folder()
        } else {
            dialog.add_filter("Images", &IMAGE_EXTENSIONS).blocking_pick_file()
        };
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-backdrop-image-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recognizes_image_extensions_case_insensitively() {
        assert!(is_image(Path::new("a.PNG")));
        assert!(is_image(Path::new("C:/x/b.jpeg")));
        assert!(!is_image(Path::new("notes.txt")));
        assert!(!is_image(Path::new("png")));
    }

    #[test]
    fn lists_images_sorted_and_only_recurses_when_asked() {
        let dir = temp("list");
        std::fs::write(dir.join("b.jpg"), b"x").unwrap();
        std::fs::write(dir.join("A.png"), b"x").unwrap();
        std::fs::write(dir.join("readme.txt"), b"x").unwrap();
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("c.webp"), b"x").unwrap();

        let names = |v: Vec<String>| -> Vec<String> {
            v.into_iter().map(|p| Path::new(&p).file_name().unwrap().to_string_lossy().into_owned()).collect()
        };
        assert_eq!(names(list_images(&dir, false).unwrap()), ["A.png", "b.jpg"]);
        assert_eq!(names(list_images(&dir, true).unwrap()), ["A.png", "b.jpg", "c.webp"]);
        assert!(list_images(&dir.join("missing"), false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reads_only_image_files() {
        let dir = temp("read");
        std::fs::write(dir.join("a.png"), b"bytes").unwrap();
        std::fs::write(dir.join("a.txt"), b"bytes").unwrap();
        assert_eq!(read_image(&dir.join("a.png")).unwrap(), b"bytes");
        assert!(read_image(&dir.join("a.txt")).is_err());
        assert!(read_image(&dir.join("missing.png")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
