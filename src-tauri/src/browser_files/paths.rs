//! Mounts and request paths for the Local Browser's file server (docs/design/browser.md section
//! 3.21, Mounts and Requests). Pure apart from `canonicalize` and `metadata`.

use std::path::{Path, PathBuf};

/// A folder (or one file) the file server exposes. Every path here is canonical, so comparisons
/// between them are like for like (on Windows, all carry the `\\?\` verbatim prefix).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mount {
    /// The folder request paths are relative to: the opened file's parent.
    pub root: PathBuf,
    /// The file that was opened.
    pub file: PathBuf,
    /// True when the root is a drive root or the home folder, so only `file` is served.
    pub single_file: bool,
}

impl Mount {
    /// The request path (after `/<token>/`) that serves the opened file, percent-encoded.
    pub fn entry_path(&self) -> String {
        let name = self
            .file
            .file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default();
        percent_encode_segment(&name)
    }

    /// What names the mount, for its listeners, its ports, and its `allowedHosts` entry: the file
    /// on a single-file mount, since two single files in one folder share a root but not a mount;
    /// the root otherwise.
    pub fn key(&self) -> &Path {
        if self.single_file {
            &self.file
        } else {
            &self.root
        }
    }
}

/// Why a request path was not resolved to a file. The server answers each with 404, so a refused
/// path and a missing file look the same to the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Bad percent-encoding, a backslash or NUL, a `:`, or an empty, `.`, `..`, or dot-leading
    /// segment.
    BadPath,
    /// Resolves outside the mount root, or to anything but the file on a single-file mount.
    Outside,
    /// No such file.
    NotFound,
    /// A folder; there are no directory listings.
    Folder,
}

/// Mounts the folder of `file`, or the file alone when its folder is a drive root or `home`.
pub fn mount_for(file: &Path, home: &Path) -> Result<Mount, String> {
    if is_unc(file) {
        return Err("network (UNC) paths cannot be opened".into());
    }
    if !is_html(file) {
        return Err(format!("not an .html or .htm file: {}", file.display()));
    }
    let canonical =
        std::fs::canonicalize(file).map_err(|e| format!("cannot open {}: {e}", file.display()))?;
    // A link or a mapped network drive can canonicalize to a UNC path, or to a non-HTML target.
    if is_unc(&canonical) {
        return Err("network (UNC) paths cannot be opened".into());
    }
    if !is_html(&canonical) {
        return Err(format!(
            "not an .html or .htm file: {}",
            canonical.display()
        ));
    }
    if !canonical.is_file() {
        return Err(format!("not a file: {}", file.display()));
    }
    let root = canonical
        .parent()
        .ok_or_else(|| format!("no parent folder: {}", file.display()))?
        .to_path_buf();
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let single_file = mounts_single_file(&root, &home);
    Ok(Mount {
        root,
        file: canonical,
        single_file,
    })
}

/// True when `root` (canonical) is a drive root or the home folder itself.
fn mounts_single_file(root: &Path, home: &Path) -> bool {
    root.parent().is_none() || root == home
}

/// Resolves a request path (the part after `/<token>/`, query allowed) to a file on the mount.
pub fn resolve(mount: &Mount, url_path: &str) -> Result<PathBuf, Refusal> {
    let path = url_path.split(['?', '#']).next().unwrap_or("");
    let path = path.strip_prefix('/').unwrap_or(path);
    let decoded = percent_decode(path).ok_or(Refusal::BadPath)?;
    // A decoded backslash is a separator to Windows but not to the segment checks below.
    if decoded.contains(['\\', '\0', ':']) {
        return Err(Refusal::BadPath);
    }
    let mut joined = mount.root.clone();
    for segment in decoded.split('/') {
        if segment.is_empty() || segment.starts_with('.') {
            return Err(Refusal::BadPath);
        }
        joined.push(segment);
    }
    let canonical = std::fs::canonicalize(&joined).map_err(|_| Refusal::NotFound)?;
    if mount.single_file {
        return if canonical == mount.file {
            Ok(canonical)
        } else {
            Err(Refusal::Outside)
        };
    }
    if canonical == mount.root || !canonical.starts_with(&mount.root) {
        return Err(Refusal::Outside);
    }
    // Checked again on the long names: an 8.3 short name (`GIT~1`, `ENV~1`) passes the segment
    // check above but canonicalizes to the dot-leading entry it stands for.
    let dot_leading = canonical
        .strip_prefix(&mount.root)
        .map(|rel| rel.iter().any(|c| c.to_string_lossy().starts_with('.')))
        .unwrap_or(true);
    if dot_leading {
        return Err(Refusal::BadPath);
    }
    let meta = std::fs::metadata(&canonical).map_err(|_| Refusal::NotFound)?;
    if meta.is_dir() {
        return Err(Refusal::Folder);
    }
    if !meta.is_file() {
        return Err(Refusal::NotFound);
    }
    Ok(canonical)
}

/// The `Content-Type` for a served file, by extension. HTML carries no charset so a page's own
/// `<meta charset>` decides, as it would opened from disk.
pub fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "text/javascript",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "xml" => "application/xml",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn is_html(path: &Path) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"))
        .unwrap_or(false)
}

/// UNC and device paths, verbatim or not. `\\?\C:\` (what canonicalize returns) is not one.
#[cfg(windows)]
fn is_unc(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    match path.components().next() {
        Some(Component::Prefix(p)) => {
            matches!(
                p.kind(),
                Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(..)
            )
        }
        _ => false,
    }
}

#[cfg(not(windows))]
fn is_unc(_path: &Path) -> bool {
    false
}

/// Decodes `%XX` escapes; `None` for a malformed escape or a result that is not UTF-8.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-browser-files-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A folder `site/` with `index.html`, `css/a.css`, `.git/config`, and a sibling `secret.txt`.
    fn site(tag: &str) -> (PathBuf, Mount) {
        let dir = temp(tag);
        let site = dir.join("site");
        fs::create_dir_all(site.join("css")).unwrap();
        fs::create_dir_all(site.join(".git")).unwrap();
        fs::write(site.join("index.html"), "<p>hi</p>").unwrap();
        fs::write(site.join("css").join("a.css"), "p{}").unwrap();
        fs::write(site.join(".git").join("config"), "[core]").unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        let mount = mount_for(&site.join("index.html"), &dir.join("elsewhere")).unwrap();
        (dir, mount)
    }

    #[test]
    fn mounts_the_parent_folder() {
        let (dir, mount) = site("parent");
        assert!(!mount.single_file);
        assert_eq!(mount.root, fs::canonicalize(dir.join("site")).unwrap());
        assert_eq!(
            mount.file,
            fs::canonicalize(dir.join("site").join("index.html")).unwrap()
        );
        assert_eq!(mount.entry_path(), "index.html");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolves_files_under_the_root() {
        let (dir, mount) = site("ok");
        let css = fs::canonicalize(dir.join("site").join("css").join("a.css")).unwrap();
        assert_eq!(resolve(&mount, "css/a.css"), Ok(css.clone()));
        assert_eq!(resolve(&mount, "/css/a.css?v=2"), Ok(css.clone()));
        assert_eq!(resolve(&mount, "css%2Fa.css"), Ok(css));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_bad_segments() {
        let (dir, mount) = site("refuse");
        for path in [
            "",
            "/",
            "css//a.css",
            "./index.html",
            "css/./a.css",
            "../secret.txt",
            "css/../../secret.txt",
            "%2e%2e/secret.txt",
            "%2E%2E%2Fsecret.txt",
            "..%5csecret.txt",
            "css%5c..%5c..%5csecret.txt",
            ".git/config",
            "%2egit/config",
            "index.html:Zone.Identifier",
            "a:stream",
            "index.html%3a%24DATA",
            "bad%zz",
            "trunc%2",
            "nul%00.html",
        ] {
            assert_eq!(resolve(&mount, path), Err(Refusal::BadPath), "{path}");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_folders_and_missing_files() {
        let (dir, mount) = site("folder");
        assert_eq!(resolve(&mount, "css"), Err(Refusal::Folder));
        assert_eq!(resolve(&mount, "css/"), Err(Refusal::BadPath));
        assert_eq!(resolve(&mount, "missing.html"), Err(Refusal::NotFound));
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn refuses_a_junction_out_of_the_root() {
        let (dir, mount) = site("junction");
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("loot.txt"), "loot").unwrap();
        let link = dir.join("site").join("escape");
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(status.status.success(), "mklink failed: {status:?}");
        assert!(dir.join("site").join("escape").join("loot.txt").is_file());
        assert_eq!(resolve(&mount, "escape/loot.txt"), Err(Refusal::Outside));
        let _ = fs::remove_dir(&link);
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn refuses_short_names_of_dot_entries() {
        let (dir, mount) = site("short");
        fs::write(dir.join("site").join(".env"), "SECRET=1").unwrap();
        let mut probed = 0;
        for path in ["GIT~1/config", "ENV~1"] {
            // Volumes with 8.3 names turned off have no short name to probe.
            if dir.join("site").join(path).exists() {
                probed += 1;
                assert_eq!(resolve(&mount, path), Err(Refusal::BadPath), "{path}");
            }
        }
        if probed == 0 {
            eprintln!("8.3 names are off on this volume; nothing to probe");
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn home_folder_mounts_the_file_alone() {
        let dir = temp("home");
        fs::write(dir.join("report.html"), "<p>r</p>").unwrap();
        fs::write(dir.join("other.html"), "<p>o</p>").unwrap();
        let mount = mount_for(&dir.join("report.html"), &dir).unwrap();
        assert!(mount.single_file);
        assert_eq!(resolve(&mount, &mount.entry_path()), Ok(mount.file.clone()));
        assert_eq!(resolve(&mount, "other.html"), Err(Refusal::Outside));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn drive_root_mounts_the_file_alone() {
        let root = fs::canonicalize(if cfg!(windows) { r"C:\" } else { "/" }).unwrap();
        assert!(mounts_single_file(&root, Path::new("/nowhere")));
        assert!(!mounts_single_file(
            &root.join("Users"),
            Path::new("/nowhere")
        ));
    }

    #[test]
    fn refuses_non_html() {
        let dir = temp("nonhtml");
        fs::write(dir.join("notes.txt"), "x").unwrap();
        assert!(mount_for(&dir.join("notes.txt"), Path::new("/nowhere")).is_err());
        fs::write(dir.join("PAGE.HTM"), "x").unwrap();
        assert!(mount_for(&dir.join("PAGE.HTM"), Path::new("/nowhere")).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn refuses_unc_but_not_verbatim_disk_paths() {
        for unc in [
            r"\\server\share\page.html",
            r"\\?\UNC\server\share\page.html",
            r"\\.\pipe\page.html",
        ] {
            let err = mount_for(Path::new(unc), Path::new(r"C:\nowhere")).unwrap_err();
            assert!(err.contains("UNC"), "{unc}: {err}");
        }
        let dir = temp("verbatim");
        fs::write(dir.join("v.html"), "x").unwrap();
        let verbatim = fs::canonicalize(dir.join("v.html")).unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
        assert!(mount_for(&verbatim, Path::new(r"C:\nowhere")).is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn content_types() {
        assert_eq!(content_type(Path::new("a.HTML")), "text/html");
        assert_eq!(content_type(Path::new("a.mjs")), "text/javascript");
        assert_eq!(content_type(Path::new("a.woff2")), "font/woff2");
        assert_eq!(content_type(Path::new("a.exe")), "application/octet-stream");
        assert_eq!(
            content_type(Path::new("Makefile")),
            "application/octet-stream"
        );
    }

    #[test]
    fn entry_path_encodes_the_name() {
        let mount = Mount {
            root: PathBuf::from("/r"),
            file: PathBuf::from("/r/my report#1.html"),
            single_file: false,
        };
        assert_eq!(mount.entry_path(), "my%20report%231.html");
    }
}
