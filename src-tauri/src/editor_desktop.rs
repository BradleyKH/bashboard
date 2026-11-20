//! Editors found from Linux desktop entries rather than a fixed table (docs/design/files.md
//! section 3.12). Every desktop (GNOME, KDE, Xfce, Cinnamon) and every package format (distro
//! packages, Flatpak and Snap exports, JetBrains Toolbox, AppImage menu entries) installs a
//! `.desktop` file into the XDG `applications` folders, so an entry that says it is a text editor
//! or IDE is one the user can pick. Its id in settings is `desktop:<desktop id>`.
//!
//! The editors `editors.rs` knows by name are skipped here, since its table also knows how to
//! jump to a line; these open the file only.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::desktop_entry::{self, Entry};

/// What a discovered editor's settings id starts with.
pub const ID_PREFIX: &str = "desktop:";

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub id: String,
    pub name: String,
}

/// Whether `id` is a well-formed discovered editor id: the prefix and a desktop id (letters,
/// digits, `.`, `_`, `-`) without the `.desktop` suffix.
pub fn is_id(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|d| {
        !d.is_empty()
            && d.len() <= 200
            && !d.contains("..")
            && d.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    })
}

/// Whether the entry declares itself an editor: the `TextEditor` or `IDE` category, or a
/// development tool that opens plain text. The plain-text handlers alone would also bring in word
/// processors and viewers.
pub fn is_editor(e: &Entry) -> bool {
    let has = |c: &str| e.categories.iter().any(|x| x == c);
    has("TextEditor") || has("IDE") || (has("Development") && e.mime_types.iter().any(|m| m == "text/plain"))
}

/// Whether `program` names an existing file: as a path, or by name in one of `path_dirs`.
fn resolves(program: &str, path_dirs: &[PathBuf]) -> bool {
    if program.contains('/') {
        return Path::new(program).is_file();
    }
    path_dirs.iter().any(|d| d.join(program).is_file())
}

/// Whether the entry's `TryExec` and `Exec` programs are installed, as GLib checks before it
/// offers an app.
pub fn runnable(e: &Entry, path_dirs: &[PathBuf]) -> bool {
    (e.try_exec.is_empty() || resolves(&e.try_exec, path_dirs))
        && desktop_entry::exec_program(e).is_some_and(|p| resolves(&p, path_dirs))
}

/// Every desktop id under `dirs` with its file, the first folder winning, as the spec resolves
/// ids. A subfolder's files take the folder name as an id prefix (`kde/foo.desktop` is
/// `kde-foo.desktop`); one level is enough for what packages install.
fn entries(dirs: &[PathBuf]) -> Vec<(String, PathBuf)> {
    fn collect(dir: &Path, prefix: &str, top: bool, seen: &mut HashSet<String>, out: &mut Vec<(String, PathBuf)>) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<(String, PathBuf)> = read
            .flatten()
            .filter_map(|e| Some((e.file_name().into_string().ok()?, e.path())))
            .collect();
        items.sort();
        for (name, path) in items {
            if path.is_dir() {
                if top {
                    collect(&path, &format!("{prefix}{name}-"), false, seen, out);
                }
            } else if name.ends_with(".desktop") {
                let id = format!("{prefix}{name}");
                if seen.insert(id.clone()) {
                    out.push((id, path));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        collect(dir, "", true, &mut seen, &mut out);
    }
    out
}

/// The editors under `dirs`, by name. `skip` takes a desktop id (`code.desktop`) the fixed table
/// already covers; `runnable` says whether an entry's programs are installed.
pub fn discover(dirs: &[PathBuf], skip: impl Fn(&str) -> bool, runnable: impl Fn(&Entry) -> bool) -> Vec<Found> {
    let mut found: Vec<Found> = entries(dirs)
        .into_iter()
        .filter(|(id, _)| !skip(id))
        .filter_map(|(id, path)| {
            let e = desktop_entry::parse(&std::fs::read_to_string(&path).ok()?)?;
            if e.hidden || !is_editor(&e) || !runnable(&e) {
                return None;
            }
            let stem = id.trim_end_matches(".desktop").to_string();
            let name = if e.name.is_empty() { stem.clone() } else { e.name.clone() };
            Some(Found { id: format!("{ID_PREFIX}{stem}"), name })
        })
        .filter(|f| is_id(&f.id))
        .collect();
    found.sort_by_key(|f| f.name.to_lowercase());
    found
}

/// The entry and its file for discovered editor `id`; `None` when it is gone or hidden.
pub fn find(id: &str, dirs: &[PathBuf]) -> Option<(Entry, PathBuf)> {
    if !is_id(id) {
        return None;
    }
    let desktop_id = format!("{}.desktop", id.strip_prefix(ID_PREFIX)?);
    let path = desktop_entry::find_in(&desktop_id, dirs, Path::is_file)?;
    let entry = desktop_entry::parse(&std::fs::read_to_string(&path).ok()?)?;
    (!entry.hidden).then_some((entry, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-editor-desktop-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn desktop(name: &str, exec: &str, extra: &str) -> String {
        format!("[Desktop Entry]\nType=Application\nName={name}\nExec={exec}\n{extra}")
    }

    #[test]
    fn editors_are_text_editors_ides_and_development_tools_for_plain_text() {
        let e = |extra: &str| desktop_entry::parse(&desktop("X", "x", extra)).unwrap();
        assert!(is_editor(&e("Categories=Utility;TextEditor;")));
        assert!(is_editor(&e("Categories=Development;IDE;")));
        assert!(is_editor(&e("Categories=Development;\nMimeType=text/plain;")));
        assert!(!is_editor(&e("Categories=Office;WordProcessor;\nMimeType=text/plain;")));
        assert!(!is_editor(&e("Categories=GTK;Development;")));
    }

    #[test]
    fn ids_are_checked() {
        assert!(is_id("desktop:org.gnome.TextEditor"));
        assert!(is_id("desktop:kde-org.kde.kate"));
        for bad in ["org.gnome.TextEditor", "desktop:", "desktop:a/b", "desktop:..x", "desktop:a b"] {
            assert!(!is_id(bad), "{bad}");
        }
    }

    #[test]
    fn discovers_by_name_with_the_first_folder_winning() {
        let root = temp_dir("discover");
        let user = root.join("user/applications");
        let system = root.join("system/applications");
        write(&user.join("micro.desktop"), &desktop("Micro", "micro %F", "Categories=TextEditor;\nTerminal=true\n"));
        // A user entry with Hidden hides the system one of the same id.
        write(&user.join("gedit.desktop"), "[Desktop Entry]\nHidden=true\nExec=gedit\n");
        write(&system.join("gedit.desktop"), &desktop("Gedit", "gedit %U", "Categories=TextEditor;\n"));
        write(&system.join("org.gnome.TextEditor.desktop"), &desktop("Text Editor", "gnome-text-editor %U", "Categories=GNOME;TextEditor;\n"));
        write(&system.join("code.desktop"), &desktop("Visual Studio Code", "/usr/bin/code %F", "Categories=TextEditor;IDE;\n"));
        write(&system.join("missing.desktop"), &desktop("Missing", "nothere %F", "Categories=TextEditor;\n"));
        write(&system.join("firefox.desktop"), &desktop("Firefox", "firefox %u", "Categories=Network;WebBrowser;\n"));
        write(&system.join("kde/kate.desktop"), &desktop("Kate", "kate -b %U", "Categories=Qt;KDE;Utility;TextEditor;\n"));

        let dirs = [user.clone(), system.clone()];
        let found = discover(&dirs, |id| id == "code.desktop", |e| !e.exec.starts_with("nothere"));
        let pairs: Vec<(&str, &str)> = found.iter().map(|f| (f.id.as_str(), f.name.as_str())).collect();
        assert_eq!(
            pairs,
            [("desktop:kde-kate", "Kate"), ("desktop:micro", "Micro"), ("desktop:org.gnome.TextEditor", "Text Editor")]
        );

        let (entry, path) = find("desktop:kde-kate", &dirs).unwrap();
        assert_eq!(entry.exec, "kate -b %U");
        assert_eq!(path, system.join("kde/kate.desktop"));
        assert!(find("desktop:gedit", &dirs).is_none(), "hidden by the user entry");
        assert!(find("desktop:../x", &dirs).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn runnable_needs_try_exec_and_exec_programs() {
        let root = temp_dir("runnable");
        let bin = root.join("bin");
        write(&bin.join("ed"), "");
        let path = [bin.clone()];
        let e = |extra: &str, exec: &str| desktop_entry::parse(&desktop("E", exec, extra)).unwrap();
        assert!(runnable(&e("", "ed %F"), &path));
        assert!(runnable(&e("", &format!("{} %F", bin.join("ed").display())), &path));
        assert!(!runnable(&e("", "gone %F"), &path));
        assert!(!runnable(&e("TryExec=gone\n", "ed %F"), &path));
        let _ = std::fs::remove_dir_all(&root);
    }
}
