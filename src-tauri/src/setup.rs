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

/// The direct subfolders of `dir` that are repo roots, sorted by name without regard to case.
/// Unreadable entries are skipped.
fn list_repos(dir: &Path) -> Vec<Repo> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut repos: Vec<Repo> = entries
        .filter_map(|e| e.ok())
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
    let home = std::env::var_os("USERPROFILE")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|h| !h.is_empty()))?;
    let dir = PathBuf::from(home).join("source").join("repos");
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
    Ok(RepoCandidates {
        repos: list_repos(&dir),
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
