//! Adds Bashboard to the applications menu from a running AppImage (docs/design/app.md section
//! 3.32). An AppImage is a single file nothing registers, so it has no menu entry, no icon, and no
//! Open with Bashboard for folders until it writes them itself. The front end offers once; this
//! module decides whether the offer applies and, on acceptance, writes the `.desktop` file and
//! copies the icon out of the AppImage's mount into the user's XDG data folder.
//!
//! The text, the quoting, the decision, and the file writes take their inputs as parameters, so
//! tests run on every OS against temporary folders; only the two commands read the environment,
//! and only Linux can say yes.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// The icon name the packages and the desktop file share.
const ICON_NAME: &str = "bashboard";
const DESKTOP_FILE: &str = "bashboard.desktop";
/// Where a bare `.DirIcon` or top-level icon with no recognizable size is filed.
const FALLBACK_SIZE: &str = "256x256";

/// An `Exec` argument quoted per the Desktop Entry Specification, then escaped as a string value
/// (the spec applies the string escape first, so each backslash the quoting adds is doubled).
/// Arguments with no reserved character stay bare. `%` is doubled so it is not a field code.
fn exec_arg(arg: &str) -> String {
    const RESERVED: &str = " \t\n\"'\\><~|&;$*?#()`";
    let arg = arg.replace('%', "%%");
    if !arg.chars().any(|c| RESERVED.contains(c)) {
        return arg;
    }
    let mut out = String::from("\"");
    for c in arg.chars() {
        match c {
            // `\\` is the quoting rule's escape; the string escape doubles it in the file.
            '"' | '`' | '$' => {
                out.push_str("\\\\");
                out.push(c);
            }
            '\\' => out.push_str("\\\\\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The `.desktop` file for an AppImage at `appimage_path`: the same keys the packages' file has,
/// except that `Exec` and `TryExec` name the AppImage instead of a binary on the path.
pub fn desktop_entry(appimage_path: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Bashboard\n\
         Comment=A terminal workspace for developers running AI coding agents.\n\
         Exec={} %F\n\
         TryExec={}\n\
         Icon={ICON_NAME}\n\
         Terminal=false\n\
         Categories=Development;System;TerminalEmulator;\n\
         Keywords=terminal;claude;agent;\n\
         MimeType=inode/directory;\n\
         StartupWMClass=bashboard\n",
        exec_arg(appimage_path),
        appimage_path.replace('\n', " "),
    )
}

/// Whether to offer: Linux, running from an AppImage (`APPIMAGE` names its file), and no entry of
/// ours in the user's applications folder yet, which also covers an entry made by hand or by an
/// earlier acceptance.
pub fn should_offer(linux: bool, appimage: Option<&str>, entry_exists: bool) -> bool {
    linux && appimage.is_some_and(|p| !p.is_empty()) && !entry_exists
}

/// `$XDG_DATA_HOME` when it is an absolute path (the spec says to ignore a relative one), else
/// `~/.local/share`.
pub fn data_home(xdg: Option<&str>, home: Option<&Path>) -> Option<PathBuf> {
    match xdg.map(Path::new).filter(|p| p.is_absolute()) {
        Some(p) => Some(p.to_path_buf()),
        None => home.map(|h| h.join(".local/share")),
    }
}

fn entry_path(data_home: &Path) -> PathBuf {
    data_home.join("applications").join(DESKTOP_FILE)
}

/// The width and height a PNG's header declares, `None` for anything that is not a PNG.
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || !bytes.starts_with(SIGNATURE) || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let word = |at: usize| u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    Some((word(16), word(20)))
}

/// The icons to copy as `(size folder, file)`: every `hicolor/<W>x<H>/apps/bashboard.png` in the
/// mount (a `256x256@2` folder is not a valid size and is skipped), else the top-level
/// `bashboard.png`, else `.DirIcon`, filed under the size their header declares.
fn icons_in(appdir: &Path) -> Vec<(String, PathBuf)> {
    let mut found = Vec::new();
    let hicolor = appdir.join("usr/share/icons/hicolor");
    if let Ok(dirs) = std::fs::read_dir(&hicolor) {
        for dir in dirs.flatten() {
            let size = dir.file_name().to_string_lossy().into_owned();
            let valid = size.split_once('x').is_some_and(|(w, h)| {
                !w.is_empty() && !h.is_empty() && w.bytes().all(|b| b.is_ascii_digit()) && h.bytes().all(|b| b.is_ascii_digit())
            });
            let file = dir.path().join("apps").join(format!("{ICON_NAME}.png"));
            if valid && file.is_file() {
                found.push((size, file));
            }
        }
    }
    if found.is_empty() {
        let top = [appdir.join(format!("{ICON_NAME}.png")), appdir.join(".DirIcon")];
        if let Some(file) = top.into_iter().find(|f| f.is_file()) {
            let size = std::fs::read(&file)
                .ok()
                .and_then(|b| png_size(&b))
                .map_or_else(|| FALLBACK_SIZE.to_string(), |(w, h)| format!("{w}x{h}"));
            found.push((size, file));
        }
    }
    found.sort();
    found
}

/// Writes the desktop file and copies the icons under `data_home`; returns the files written,
/// desktop file first. The icons go first, so a failure on the way never leaves a menu entry
/// whose icon is missing.
pub fn install(appimage: &str, appdir: Option<&Path>, data_home: &Path) -> Result<Vec<PathBuf>, String> {
    let mut written = Vec::new();
    for (size, from) in appdir.map(icons_in).unwrap_or_default() {
        let to = data_home.join("icons/hicolor").join(size).join("apps").join(format!("{ICON_NAME}.png"));
        if let Some(dir) = to.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        }
        std::fs::copy(&from, &to).map_err(|e| format!("could not copy the icon to {}: {e}", to.display()))?;
        written.push(to);
    }
    let entry = entry_path(data_home);
    crate::atomic_file::write_atomic(&entry, desktop_entry(appimage))
        .map_err(|e| format!("could not write {}: {e}", entry.display()))?;
    written.insert(0, entry);
    Ok(written)
}

#[cfg(target_os = "linux")]
fn env_data_home() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    data_home(std::env::var("XDG_DATA_HOME").ok().as_deref(), home.as_deref())
}

/// Whether the front end should offer the menu entry: running from an AppImage that has none.
#[tauri::command]
pub fn appimage_entry_status() -> bool {
    #[cfg(target_os = "linux")]
    {
        let Some(home) = env_data_home() else { return false };
        should_offer(true, std::env::var("APPIMAGE").ok().as_deref(), entry_path(&home).exists())
    }
    #[cfg(not(target_os = "linux"))]
    {
        should_offer(false, None, false)
    }
}

/// Writes the menu entry and its icons, then refreshes the desktop database when the tool is
/// there (a menu that does not watch the folder needs it for the folder association; a failure
/// only delays that).
#[tauri::command]
pub fn appimage_entry_install() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let appimage = std::env::var("APPIMAGE").map_err(|_| "Bashboard is not running from an AppImage.".to_string())?;
        let home = env_data_home().ok_or("The home folder is unknown.")?;
        let appdir = std::env::var_os("APPDIR").map(PathBuf::from);
        install(&appimage, appdir.as_deref(), &home)?;
        let mut cmd = std::process::Command::new("update-desktop-database");
        cmd.arg(home.join("applications")).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        crate::child_process::prepare(&mut cmd);
        let _ = cmd.status();
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("Only an AppImage on Linux has a menu entry to add.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::desktop_entry::{command_for_file, exec_program, parse};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bb-appimage-entry-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b
    }

    #[test]
    fn a_plain_path_is_left_bare_and_one_with_spaces_is_quoted() {
        assert_eq!(exec_arg("/home/me/Bashboard.AppImage"), "/home/me/Bashboard.AppImage");
        assert_eq!(exec_arg("/home/me/My Apps/Bashboard.AppImage"), "\"/home/me/My Apps/Bashboard.AppImage\"");
        assert_eq!(exec_arg("/a/100%/b"), "/a/100%%/b");
    }

    #[test]
    fn the_entry_has_the_packages_keys() {
        let text = desktop_entry("/home/me/Bashboard.AppImage");
        for line in [
            "Exec=/home/me/Bashboard.AppImage %F",
            "TryExec=/home/me/Bashboard.AppImage",
            "Icon=bashboard",
            "MimeType=inode/directory;",
            "Categories=Development;System;TerminalEmulator;",
            "Keywords=terminal;claude;agent;",
            "StartupWMClass=bashboard",
        ] {
            assert!(text.lines().any(|l| l == line), "missing {line}");
        }
    }

    #[test]
    fn a_path_with_awkward_characters_reads_back_as_one_program() {
        for path in ["/home/me/My Apps/Bashboard.AppImage", "/o/$HOME/\"q\"/b\\s `x`/App.AppImage", "/a/100%/App.AppImage"] {
            let text = desktop_entry(path);
            let entry = parse(&text).unwrap();
            // exec_program leaves `%%` unexpanded; command_for_file below reads it as one percent.
            if !path.contains('%') {
                assert_eq!(exec_program(&entry).as_deref(), Some(path), "{text}");
            }
            let argv = command_for_file(&entry, Path::new("/work/dir"), Path::new("/x.desktop")).unwrap();
            assert_eq!(argv, vec![path.to_string(), "/work/dir".to_string()]);
        }
    }

    #[test]
    fn offers_only_on_linux_from_an_appimage_with_no_entry() {
        let app = Some("/home/me/Bashboard.AppImage");
        assert!(should_offer(true, app, false));
        assert!(!should_offer(true, app, true));
        assert!(!should_offer(true, None, false));
        assert!(!should_offer(true, Some(""), false));
        assert!(!should_offer(false, app, false));
    }

    #[test]
    fn data_home_ignores_a_relative_xdg_value() {
        let home = Path::new("/home/me");
        let abs = std::env::temp_dir();
        assert_eq!(data_home(abs.to_str(), Some(home)), Some(abs));
        assert_eq!(data_home(Some("rel"), Some(home)), Some(home.join(".local/share")));
        assert_eq!(data_home(None, Some(home)), Some(home.join(".local/share")));
        assert_eq!(data_home(None, None), None);
    }

    #[test]
    fn reads_a_png_header() {
        assert_eq!(png_size(&png(256, 128)), Some((256, 128)));
        assert_eq!(png_size(b"<svg/>"), None);
    }

    #[test]
    fn install_writes_the_entry_and_copies_every_valid_icon_size() {
        let root = temp("install");
        let appdir = root.join("mnt");
        for size in ["32x32", "128x128", "256x256@2"] {
            let dir = appdir.join("usr/share/icons/hicolor").join(size).join("apps");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("bashboard.png"), size).unwrap();
        }
        let data = root.join("data");
        let written = install("/opt/My Apps/Bashboard.AppImage", Some(&appdir), &data).unwrap();
        let entry = data.join("applications/bashboard.desktop");
        assert_eq!(written[0], entry);
        assert!(std::fs::read_to_string(&entry).unwrap().contains("Exec=\"/opt/My Apps/Bashboard.AppImage\" %F"));
        for size in ["32x32", "128x128"] {
            let icon = data.join("icons/hicolor").join(size).join("apps/bashboard.png");
            assert_eq!(std::fs::read_to_string(icon).unwrap(), size);
        }
        assert!(!data.join("icons/hicolor/256x256@2").exists());
        assert_eq!(written.len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_falls_back_to_the_top_level_icon_filed_by_its_size() {
        let root = temp("fallback");
        let appdir = root.join("mnt");
        std::fs::create_dir_all(&appdir).unwrap();
        std::fs::write(appdir.join(".DirIcon"), png(512, 512)).unwrap();
        let data = root.join("data");
        install("/opt/Bashboard.AppImage", Some(&appdir), &data).unwrap();
        assert!(data.join("icons/hicolor/512x512/apps/bashboard.png").is_file());
        std::fs::write(appdir.join("bashboard.png"), png(64, 64)).unwrap();
        let data = root.join("data2");
        install("/opt/Bashboard.AppImage", Some(&appdir), &data).unwrap();
        assert!(data.join("icons/hicolor/64x64/apps/bashboard.png").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn install_without_a_mount_still_writes_the_entry() {
        let root = temp("nomount");
        let written = install("/opt/Bashboard.AppImage", None, &root).unwrap();
        assert_eq!(written, vec![root.join("applications/bashboard.desktop")]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
