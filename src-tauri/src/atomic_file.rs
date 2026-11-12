//! Crash-safe file writes (docs/design/app.md section 3.22).

use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
};

/// Writes `<name>.tmp`, flushes it to disk, then renames it over the target. The rename alone
/// keeps a crash of this process from leaving a torn file, but after a power cut or a Windows
/// crash NTFS can keep the rename while losing the unflushed data, which leaves the target
/// empty or zero-filled; `sync_all` before the rename closes that window.
pub(crate) fn write_atomic(path: &Path, bytes: impl AsRef<[u8]>) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = with_suffix(path, ".tmp");
    let written = File::create(&tmp).and_then(|mut f| {
        f.write_all(bytes.as_ref())?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// `path` with `suffix` appended to its file name (`a.json` to `a.json.bak`).
pub(crate) fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_replaces_and_leaves_no_tmp() {
        let dir = std::env::temp_dir().join(format!("bashboard-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("a.txt");
        write_atomic(&path, "one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "two");
        assert!(!with_suffix(&path, ".tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
