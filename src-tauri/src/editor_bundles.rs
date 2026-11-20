//! Editors found from macOS app bundles rather than a fixed table (docs/design/files.md section
//! 3.12). An app declares the documents it opens in its `Info.plist` (`CFBundleDocumentTypes`),
//! and Launch Services builds its handler lists from those same declarations; an app that edits
//! plain text or source code there is one the user can pick. Its id in settings is
//! `app:<bundle identifier>`, and it opens files through `open -a`.
//!
//! The editors `editors.rs` knows by name are skipped here, since its table also knows how to
//! jump to a line; these open the file only. Pure apart from reading the folders and plists, so it
//! is tested on every OS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use plist::Value;

/// What a discovered editor's settings id starts with.
pub const ID_PREFIX: &str = "app:";

#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

/// Content types that mean text a person edits. `public.data` and `public.item` are left out:
/// apps that open any file declare those.
const TEXT_TYPES: &[&str] = &[
    "public.plain-text",
    "public.text",
    "public.utf8-plain-text",
    "public.source-code",
    "public.script",
    "public.shell-script",
];

/// Extensions older apps declare instead of content types.
const TEXT_EXTENSIONS: &[&str] = &["txt", "text"];

/// Whether `id` is a well-formed discovered editor id.
pub fn is_id(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|b| {
        !b.is_empty() && b.len() <= 200 && b.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    })
}

fn strings(v: Option<&Value>) -> Vec<&str> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_string).collect()).unwrap_or_default()
}

/// Whether the app's `Info.plist` declares the Editor role for a text type at any rank but None.
pub fn edits_text(info: &Value) -> bool {
    let Some(types) = info.as_dictionary().and_then(|d| d.get("CFBundleDocumentTypes")).and_then(Value::as_array) else {
        return false;
    };
    types.iter().filter_map(Value::as_dictionary).any(|doc| {
        let role = doc.get("CFBundleTypeRole").and_then(Value::as_string);
        let rank = doc.get("LSHandlerRank").and_then(Value::as_string);
        role == Some("Editor")
            && rank != Some("None")
            && (strings(doc.get("LSItemContentTypes")).iter().any(|t| TEXT_TYPES.contains(t))
                || strings(doc.get("CFBundleTypeExtensions"))
                    .iter()
                    .any(|e| TEXT_EXTENSIONS.iter().any(|t| e.eq_ignore_ascii_case(t))))
    })
}

/// The bundle identifier and the name to show, falling back to the bundle's file name.
fn identity(info: &Value, app: &Path) -> Option<(String, String)> {
    let d = info.as_dictionary()?;
    let id = d.get("CFBundleIdentifier")?.as_string()?.to_string();
    let name = ["CFBundleDisplayName", "CFBundleName"]
        .iter()
        .find_map(|k| d.get(k).and_then(Value::as_string).filter(|s| !s.is_empty()))
        .map(String::from)
        .or_else(|| app.file_stem().map(|s| s.to_string_lossy().into_owned()))?;
    Some((id, name))
}

/// The `.app` bundles in `dirs`, and one folder down (`/Applications/Utilities`, Setapp), in
/// folder order.
fn bundles(dirs: &[PathBuf]) -> Vec<PathBuf> {
    fn collect(dir: &Path, top: bool, out: &mut Vec<PathBuf>) {
        let Ok(read) = std::fs::read_dir(dir) else { return };
        let mut items: Vec<PathBuf> = read.flatten().map(|e| e.path()).collect();
        items.sort();
        for path in items {
            if path.extension().is_some_and(|e| e == "app") {
                out.push(path);
            } else if top && path.is_dir() {
                collect(&path, false, out);
            }
        }
    }
    let mut out = Vec::new();
    for dir in dirs {
        collect(dir, true, &mut out);
    }
    out
}

/// The editors in `dirs`, by name; the first bundle with an identifier wins. `skip` takes a
/// bundle's file name (`Visual Studio Code.app`) the fixed table already covers.
pub fn discover(dirs: &[PathBuf], skip: impl Fn(&str) -> bool) -> Vec<Found> {
    let mut seen = HashSet::new();
    let mut found: Vec<Found> = bundles(dirs)
        .into_iter()
        .filter(|app| !app.file_name().and_then(|n| n.to_str()).is_some_and(&skip))
        .filter_map(|app| {
            let info = Value::from_file(app.join("Contents/Info.plist")).ok()?;
            if !edits_text(&info) {
                return None;
            }
            let (bundle, name) = identity(&info, &app)?;
            let id = format!("{ID_PREFIX}{bundle}");
            (is_id(&id) && seen.insert(id.clone())).then_some(Found { id, name, path: app })
        })
        .collect();
    found.sort_by_key(|f| f.name.to_lowercase());
    found
}

/// The bundle for discovered editor `id`, if it is still installed.
pub fn find(id: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if !is_id(id) {
        return None;
    }
    let bundle = id.strip_prefix(ID_PREFIX)?;
    bundles(dirs).into_iter().find(|app| {
        Value::from_file(app.join("Contents/Info.plist"))
            .ok()
            .and_then(|info| identity(&info, app))
            .is_some_and(|(b, _)| b == bundle)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-editor-bundles-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn info(id: &str, name: &str, doc_types: &str) -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>{id}</string>
<key>CFBundleName</key><string>{name}</string>
<key>CFBundleDocumentTypes</key><array>{doc_types}</array>
</dict></plist>"#
        )
    }

    fn doc(role: &str, types: &[&str]) -> String {
        let types: String = types.iter().map(|t| format!("<string>{t}</string>")).collect();
        format!("<dict><key>CFBundleTypeRole</key><string>{role}</string><key>LSItemContentTypes</key><array>{types}</array></dict>")
    }

    fn app(dir: &Path, file: &str, plist: &str) {
        let contents = dir.join(file).join("Contents");
        std::fs::create_dir_all(&contents).unwrap();
        std::fs::write(contents.join("Info.plist"), plist).unwrap();
    }

    fn parse(text: &str) -> Value {
        Value::from_reader_xml(text.as_bytes()).unwrap()
    }

    #[test]
    fn text_editors_declare_the_editor_role_for_a_text_type() {
        assert!(edits_text(&parse(&info("a", "A", &doc("Editor", &["public.plain-text"])))));
        assert!(edits_text(&parse(&info("a", "A", &doc("Editor", &["com.example.doc", "public.source-code"])))));
        assert!(!edits_text(&parse(&info("a", "A", &doc("Viewer", &["public.plain-text"])))));
        assert!(!edits_text(&parse(&info("a", "A", &doc("Editor", &["public.data"])))));
        assert!(!edits_text(&parse(&info("a", "A", ""))));
        let old = "<dict><key>CFBundleTypeRole</key><string>Editor</string><key>CFBundleTypeExtensions</key><array><string>TXT</string></array></dict>";
        assert!(edits_text(&parse(&info("a", "A", old))));
        let unranked = "<dict><key>CFBundleTypeRole</key><string>Editor</string><key>LSHandlerRank</key><string>None</string><key>LSItemContentTypes</key><array><string>public.text</string></array></dict>";
        assert!(!edits_text(&parse(&info("a", "A", unranked))));
    }

    #[test]
    fn ids_are_checked() {
        assert!(is_id("app:com.apple.TextEdit"));
        for bad in ["com.apple.TextEdit", "app:", "app:a/b", "app:a b"] {
            assert!(!is_id(bad), "{bad}");
        }
    }

    #[test]
    fn discovers_bundles_by_name_and_finds_them_again() {
        let root = temp_dir("discover");
        let system = root.join("System/Applications");
        let apps = root.join("Applications");
        app(&system, "TextEdit.app", &info("com.apple.TextEdit", "TextEdit", &doc("Editor", &["public.plain-text"])));
        app(&apps.join("Utilities"), "BBEdit.app", &info("com.barebones.bbedit", "BBEdit", &doc("Editor", &["public.text"])));
        app(&apps, "Visual Studio Code.app", &info("com.microsoft.VSCode", "Code", &doc("Editor", &["public.plain-text"])));
        app(&apps, "Preview.app", &info("com.apple.Preview", "Preview", &doc("Viewer", &["public.plain-text"])));

        let dirs = [apps.clone(), system.clone()];
        let found = discover(&dirs, |name| name == "Visual Studio Code.app");
        let pairs: Vec<(&str, &str)> = found.iter().map(|f| (f.id.as_str(), f.name.as_str())).collect();
        assert_eq!(pairs, [("app:com.barebones.bbedit", "BBEdit"), ("app:com.apple.TextEdit", "TextEdit")]);
        assert_eq!(find("app:com.apple.TextEdit", &dirs), Some(system.join("TextEdit.app")));
        assert_eq!(find("app:com.example.gone", &dirs), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
