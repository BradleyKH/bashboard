use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Debug, PartialEq)]
pub struct Repo {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoCandidates {
    pub dir: Option<String>,
    pub repos: Vec<Repo>,
}

/// True when the folder itself holds `.git`, as a directory or as a worktree's file. It does not
/// walk up, so a plain subfolder of a repo is not a candidate.
fn is_repo_root(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok()
}

/// Home subfolders macOS guards with a privacy prompt. Looking for `.git` inside each one asks
/// the user for access to it, and a denial sticks to every shell in the app's panes, so a scan
/// of the home folder passes over them. None is a repo root itself, and the scan is one level
/// deep, so a repo kept under Documents is found by scanning its parent folder instead.
const MAC_PROTECTED: &[&str] = &["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"];

/// The subfolder names `list_repos` must not look inside.
fn skipped_names(dir: &Path, home: Option<&Path>, macos: bool) -> &'static [&'static str] {
    if macos && home == Some(dir) {
        MAC_PROTECTED
    } else {
        &[]
    }
}

/// The direct subfolders of `dir` that are repo roots, sorted by name without regard to case.
/// Unreadable entries and those named in `skip` are skipped.
fn list_repos(dir: &Path, skip: &[&str]) -> Vec<Repo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut repos: Vec<Repo> = entries
        .filter_map(|e| e.ok())
        .filter(|e| !skip.iter().any(|s| e.file_name() == *s))
        .map(|e| e.path())
        .filter(|p| p.is_dir() && is_repo_root(p))
        .filter_map(|p| {
            let name = p.file_name()?.to_string_lossy().into_owned();
            Some(Repo {
                name,
                path: p.to_string_lossy().into_owned(),
            })
        })
        .collect();
    repos.sort_by_key(|r| r.name.to_lowercase());
    repos
}

fn default_dir() -> Option<PathBuf> {
    let dir = crate::platform::user_home()?.join("source").join("repos");
    dir.is_dir().then_some(dir)
}

fn candidates(dir: Option<String>) -> Result<RepoCandidates, String> {
    let dir = match dir {
        None => match default_dir() {
            Some(d) => d,
            None => {
                return Ok(RepoCandidates {
                    dir: None,
                    repos: Vec::new(),
                })
            }
        },
        Some(d) => {
            let expanded = PathBuf::from(crate::settings::expand_env(d.trim()));
            if !expanded.is_absolute() || !expanded.is_dir() {
                return Err(format!("not a folder: {}", expanded.display()));
            }
            expanded
        }
    };
    let skip = skipped_names(&dir, crate::platform::user_home().as_deref(), cfg!(target_os = "macos"));
    Ok(RepoCandidates {
        repos: list_repos(&dir, skip),
        dir: Some(dir.to_string_lossy().into_owned()),
    })
}

/// Lists the git repos directly under a folder for the setup wizard's Favorites step. The scan
/// runs on a blocking thread so a slow or network folder never stalls the UI.
#[tauri::command]
pub async fn setup_repo_candidates(dir: Option<String>) -> Result<RepoCandidates, String> {
    tauri::async_runtime::spawn_blocking(move || candidates(dir))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-setup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_only_repo_roots_sorted() {
        let dir = temp_dir("list");
        std::fs::create_dir_all(dir.join("zeta").join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("Alpha")).unwrap();
        std::fs::create_dir_all(dir.join("Alpha").join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("beta")).unwrap();
        std::fs::create_dir_all(dir.join("worktree")).unwrap();
        std::fs::write(dir.join("worktree").join(".git"), "gitdir: elsewhere").unwrap();
        std::fs::create_dir_all(dir.join("plain")).unwrap();
        std::fs::write(dir.join("file.txt"), "x").unwrap();

        let result = candidates(Some(dir.to_string_lossy().into_owned())).unwrap();
        let names: Vec<&str> = result.repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "worktree", "zeta"]);
        assert_eq!(result.dir.as_deref(), Some(dir.to_string_lossy().as_ref()));
        assert!(result.repos[0].path.ends_with("Alpha"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_mac_home_scan_skips_the_protected_folders() {
        let dir = temp_dir("home");
        std::fs::create_dir_all(dir.join("Music").join(".git")).unwrap();
        std::fs::create_dir_all(dir.join("code").join(".git")).unwrap();

        let skip = skipped_names(&dir, Some(&dir), true);
        let names: Vec<String> = list_repos(&dir, skip).into_iter().map(|r| r.name).collect();
        assert_eq!(names, ["code"]);
        // Only the home folder itself, and only on macOS.
        assert!(skipped_names(&dir.join("code"), Some(&dir), true).is_empty());
        assert!(skipped_names(&dir, Some(&dir), false).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_relative_dir_is_an_error() {
        let dir = temp_dir("err");
        let missing = dir.join("nope");
        let err = candidates(Some(missing.to_string_lossy().into_owned())).unwrap_err();
        assert!(err.starts_with("not a folder:"));
        assert!(candidates(Some("relative/path".into())).is_err());
        std::fs::write(dir.join("f"), "x").unwrap();
        assert!(candidates(Some(dir.join("f").to_string_lossy().into_owned())).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn serializes_camel_case() {
        let json = serde_json::to_value(RepoCandidates {
            dir: None,
            repos: vec![Repo {
                name: "a".into(),
                path: "p".into(),
            }],
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "dir": null, "repos": [{ "name": "a", "path": "p" }] })
        );
    }
}
