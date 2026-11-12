//! The Files pane's delete, copy, and paste (docs/design/files.md section 3.8).
//!
//! Paths follow `files.rs`: absolute, normalized, and shown with `display`. Nothing here deletes
//! permanently except the source of a finished cross-drive move.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::Serialize;

use crate::files::{display, normalize};

/// One paste's outcome: the new paths, and a `name: reason` line for each entry that failed.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct PasteReport {
    pub pasted: Vec<String>,
    pub failed: Vec<String>,
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| display(path))
}

/// Whether `inner` is `outer` or lies inside it; case-insensitive on Windows, where names are.
fn within(inner: &Path, outer: &Path) -> bool {
    if cfg!(windows) {
        let lower = |p: &Path| PathBuf::from(display(p).to_lowercase());
        lower(inner).starts_with(lower(outer))
    } else {
        inner.starts_with(outer)
    }
}

fn same(a: &Path, b: &Path) -> bool {
    within(a, b) && within(b, a)
}

/// The first free name for a copy beside its original, as File Explorer names one:
/// `notes - Copy.txt`, then `notes - Copy (2).txt`. A folder or a dotfile keeps its whole name.
fn copy_name(dir: &Path, name: &str, is_dir: bool) -> PathBuf {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && !is_dir => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 1;
    loop {
        let candidate = if n == 1 {
            format!("{stem} - Copy{ext}")
        } else {
            format!("{stem} - Copy ({n}){ext}")
        };
        let path = dir.join(candidate);
        if fs::symlink_metadata(&path).is_err() {
            return path;
        }
        n += 1;
    }
}

/// Copies a file, or a folder and everything in it, to `to`, which must not exist. Links are
/// refused rather than followed, since following one copies whatever it points at (a pnpm
/// `node_modules` is mostly junctions into a shared store).
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(from)?;
    if meta.file_type().is_symlink() {
        return Err(io::Error::other(format!("{} is a link", display(from))));
    }
    if meta.is_dir() {
        fs::create_dir(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else {
        fs::copy(from, to)?;
    }
    Ok(())
}

/// Copies `from` into `to_dir`, under a "- Copy" name when that is its own folder.
fn copy_entry(from: &Path, to_dir: &Path) -> Result<PathBuf, String> {
    let meta = fs::symlink_metadata(from).map_err(|_| format!("not found: {}", display(from)))?;
    let name = file_name(from);
    if meta.is_dir() && within(to_dir, from) {
        return Err("a folder cannot be copied into itself".into());
    }
    let to = match from.parent() {
        Some(parent) if same(parent, to_dir) => copy_name(to_dir, &name, meta.is_dir()),
        _ => to_dir.join(&name),
    };
    if fs::symlink_metadata(&to).is_ok() {
        return Err(format!("exists: {name} already exists"));
    }
    if let Err(e) = copy_tree(from, &to) {
        // A half-copied folder is worse than none; `to` did not exist, so all of it is ours.
        let _ = if meta.is_dir() {
            fs::remove_dir_all(&to)
        } else {
            fs::remove_file(&to)
        };
        return Err(e.to_string());
    }
    Ok(to)
}

/// Moves a file or folder into `to_dir`. Already there is a no-op, as File Explorer treats it.
fn move_entry(from: &Path, to_dir: &Path) -> Result<PathBuf, String> {
    let meta = fs::symlink_metadata(from).map_err(|_| format!("not found: {}", display(from)))?;
    if from.parent().is_some_and(|p| same(p, to_dir)) {
        return Ok(from.to_path_buf());
    }
    if meta.is_dir() && within(to_dir, from) {
        return Err("a folder cannot be moved into itself".into());
    }
    let name = file_name(from);
    let to = to_dir.join(&name);
    if fs::symlink_metadata(&to).is_ok() {
        return Err(format!("exists: {name} already exists"));
    }
    match fs::rename(from, &to) {
        Ok(()) => Ok(to),
        // A rename cannot cross drives; copy, then remove the original only once the copy is whole.
        Err(e) if e.kind() == io::ErrorKind::CrossesDevices => {
            copy_entry(from, to_dir)?;
            let removed = if meta.is_dir() {
                fs::remove_dir_all(from)
            } else {
                fs::remove_file(from)
            };
            removed.map_err(|e| format!("copied, but the original stayed: {e}"))?;
            Ok(to)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn paste(paths: &[String], to_dir: &str, cut: bool) -> Result<PasteReport, String> {
    let to_dir = normalize(to_dir)?;
    if !to_dir.is_dir() {
        return Err(format!("not a folder: {}", display(&to_dir)));
    }
    let mut report = PasteReport::default();
    for p in paths {
        let result = normalize(p).and_then(|from| {
            if cut {
                move_entry(&from, &to_dir)
            } else {
                copy_entry(&from, &to_dir)
            }
        });
        match result {
            Ok(to) => report.pasted.push(display(&to)),
            Err(e) => report
                .failed
                .push(format!("{}: {e}", file_name(Path::new(p)))),
        }
    }
    Ok(report)
}

fn trash_paths(paths: &[String]) -> Result<(), String> {
    let paths = paths
        .iter()
        .map(|p| normalize(p))
        .collect::<Result<Vec<_>, _>>()?;
    trash::delete_all(&paths).map_err(|e| e.to_string())
}

/// Copies, or moves when `cut`, each path into `to_dir`. Runs off the async runtime, since a
/// large folder copy takes a while.
#[tauri::command]
pub async fn fs_paste(
    paths: Vec<String>,
    to_dir: String,
    cut: bool,
) -> Result<PasteReport, String> {
    tauri::async_runtime::spawn_blocking(move || paste(&paths, &to_dir, cut))
        .await
        .map_err(|e| e.to_string())?
}

/// Sends files and folders to the Recycle Bin (the Trash on macOS and Linux). An entry the bin
/// refuses, such as one on a network drive, fails rather than being deleted permanently.
#[tauri::command]
pub async fn fs_trash(paths: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || trash_paths(&paths))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-fileops-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn s(p: &Path) -> String {
        display(p)
    }

    #[test]
    fn copy_into_its_own_folder_takes_a_copy_name() {
        let dir = temp_dir("copyname");
        fs::write(dir.join("notes.txt"), "a").unwrap();
        fs::write(dir.join(".env"), "b").unwrap();
        fs::create_dir(dir.join("src.d")).unwrap();
        let paths = [dir.join("notes.txt"), dir.join(".env"), dir.join("src.d")].map(|p| s(&p));
        let r = paste(&paths, &s(&dir), false).unwrap();
        assert_eq!(r.failed, Vec::<String>::new());
        assert!(dir.join("notes - Copy.txt").is_file());
        assert!(dir.join(".env - Copy").is_file());
        assert!(dir.join("src.d - Copy").is_dir());
        let r = paste(&[s(&dir.join("notes.txt"))], &s(&dir), false).unwrap();
        assert_eq!(r.pasted, vec![s(&dir.join("notes - Copy (2).txt"))]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copy_brings_a_folder_tree_and_refuses_a_clash() {
        let dir = temp_dir("copytree");
        fs::create_dir_all(dir.join("a").join("deep")).unwrap();
        fs::write(dir.join("a").join("deep").join("f.txt"), "x").unwrap();
        fs::create_dir(dir.join("b")).unwrap();
        let r = paste(&[s(&dir.join("a"))], &s(&dir.join("b")), false).unwrap();
        assert_eq!(r.failed, Vec::<String>::new());
        assert_eq!(
            fs::read_to_string(dir.join("b").join("a").join("deep").join("f.txt")).unwrap(),
            "x"
        );
        assert!(
            dir.join("a").join("deep").join("f.txt").is_file(),
            "the original stays"
        );
        let r = paste(&[s(&dir.join("a"))], &s(&dir.join("b")), false).unwrap();
        assert_eq!(r.failed, vec!["a: exists: a already exists".to_string()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_folder_is_not_copied_or_moved_into_itself() {
        let dir = temp_dir("intoself");
        fs::create_dir_all(dir.join("a").join("inner")).unwrap();
        let inner = s(&dir.join("a").join("inner"));
        let r = paste(&[s(&dir.join("a"))], &inner, false).unwrap();
        assert_eq!(
            r.failed,
            vec!["a: a folder cannot be copied into itself".to_string()]
        );
        let r = paste(&[s(&dir.join("a"))], &inner, true).unwrap();
        assert_eq!(
            r.failed,
            vec!["a: a folder cannot be moved into itself".to_string()]
        );
        assert!(!dir.join("a").join("inner").join("a").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn cut_moves_files_and_folders_and_is_a_no_op_in_place() {
        let dir = temp_dir("cut");
        fs::write(dir.join("f.txt"), "x").unwrap();
        fs::create_dir_all(dir.join("d").join("deep")).unwrap();
        fs::create_dir(dir.join("to")).unwrap();
        let r = paste(
            &[s(&dir.join("f.txt")), s(&dir.join("d"))],
            &s(&dir.join("to")),
            true,
        )
        .unwrap();
        assert_eq!(r.failed, Vec::<String>::new());
        assert!(dir.join("to").join("f.txt").is_file() && !dir.join("f.txt").exists());
        assert!(dir.join("to").join("d").join("deep").is_dir() && !dir.join("d").exists());
        let moved = s(&dir.join("to").join("f.txt"));
        let r = paste(&[moved.clone()], &s(&dir.join("to")), true).unwrap();
        assert_eq!(r.pasted, vec![moved]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_missing_source_fails_alone() {
        let dir = temp_dir("missing");
        fs::write(dir.join("here.txt"), "x").unwrap();
        fs::create_dir(dir.join("to")).unwrap();
        let r = paste(
            &[s(&dir.join("gone.txt")), s(&dir.join("here.txt"))],
            &s(&dir.join("to")),
            false,
        )
        .unwrap();
        assert_eq!(r.pasted, vec![s(&dir.join("to").join("here.txt"))]);
        assert_eq!(r.failed.len(), 1);
        assert!(r.failed[0].starts_with("gone.txt: not found"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
