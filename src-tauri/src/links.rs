use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// True only for absolute http(s) URLs with a host. Anything else (file:, javascript:,
/// custom protocol handlers, bare paths) must never reach the OS shell.
fn is_openable(url: &str) -> bool {
    let url = url.trim();
    let Some((scheme, rest)) = url.split_once("://") else {
        return false;
    };
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return false;
    }
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.starts_with('@') && !url.chars().any(char::is_control)
}

/// Opens an http(s) URL in the default browser; rejects every other scheme. An http loopback
/// URL on a port that speaks TLS opens as https, since http could never load it.
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !is_openable(&url) {
        return Err("only http and https links can be opened".into());
    }
    let url = tauri::async_runtime::spawn_blocking(move || {
        crate::browser_tls::prefer_tls(url.trim())
    })
    .await
    .map_err(|e| e.to_string())?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// True only for an absolute path to an existing directory. A file path would make Explorer
/// launch the file, and a relative one could start with `/`, which Explorer reads as a switch.
fn is_folder(path: &Path) -> bool {
    path.is_absolute() && path.is_dir()
}

/// Opens a folder in File Explorer (Finder on macOS).
#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    let dir = PathBuf::from(path.trim());
    if !is_folder(&dir) {
        return Err(format!("{} is not a folder", dir.display()));
    }
    let program = if cfg!(windows) { "explorer.exe" } else { "open" };
    // Explorer exits with 1 even on success, so spawn without waiting on its status.
    std::process::Command::new(program)
        .arg(&dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_folder, is_openable};
    use std::path::Path;

    #[test]
    fn accepts_http_and_https() {
        assert!(is_openable("http://example.com"));
        assert!(is_openable("https://example.com/a?b=c#d"));
        assert!(is_openable("HTTPS://EXAMPLE.COM"));
        assert!(is_openable("Http://localhost:1420/"));
    }

    #[test]
    fn rejects_other_schemes_and_junk() {
        assert!(!is_openable("file:///C:/Windows/notepad.exe"));
        assert!(!is_openable("javascript:alert(1)"));
        assert!(!is_openable("ms-settings:display"));
        assert!(!is_openable(r"C:\Windows"));
        assert!(!is_openable(""));
        assert!(!is_openable("http://"));
        assert!(!is_openable("https:///path"));
        assert!(!is_openable("example.com"));
        assert!(!is_openable("http://exa\nmple.com"));
    }

    #[test]
    fn opens_only_existing_absolute_folders() {
        let dir = std::env::temp_dir();
        assert!(is_folder(&dir));
        let file = dir.join("bashboard-open-folder-test.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(!is_folder(&file));
        std::fs::remove_file(&file).unwrap();
        assert!(!is_folder(Path::new(".")));
        assert!(!is_folder(Path::new(r"/select,C:\Windows")));
        assert!(!is_folder(&dir.join("bashboard-missing-folder")));
    }
}
