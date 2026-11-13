//! Approved worktree setup scripts (docs/design/git.md section 3.27). A repo's
//! `.bashboard/setup.sh` runs in a new worktree only after the user approves it, and the
//! approval is kept in the app's config folder, not the repo, keyed by the main worktree root.
//! The store holds the exact approved text rather than a hash: comparing the text cannot be
//! fooled by a crafted collision, and a changed script asks again.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::{
    git::Git,
    git_worktrees::main_worktree_path,
    lock::LockExt,
    settings::SettingsState,
    workspace::same_root,
    worktree_new::{read_setup_script, repo_root},
};

pub(crate) const FILE_NAME: &str = "worktree-trust.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    approved: Vec<Approval>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Approval {
    root: String,
    script: String,
}

/// Serializes read-modify-write of the store.
static STORE_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn store_path(app: &AppHandle) -> Option<PathBuf> {
    crate::config_dir::config_dir(app).map(|d| d.join(FILE_NAME))
}

/// A missing or unreadable store approves nothing.
fn load(file: &Path) -> Store {
    fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub(crate) fn is_trusted(file: &Path, main_root: &str, script: &str) -> bool {
    let _guard = STORE_LOCK.lock_or_recover();
    load(file)
        .approved
        .iter()
        .any(|a| same_root(&a.root, main_root) && a.script == script)
}

/// Records `script` as the approved setup script for `main_root`, replacing an earlier one.
pub(crate) fn trust(file: &Path, main_root: &str, script: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock_or_recover();
    let mut store = load(file);
    store.approved.retain(|a| !same_root(&a.root, main_root));
    store.approved.push(Approval {
        root: main_root.to_string(),
        script: script.to_string(),
    });
    let json = serde_json::to_vec_pretty(&store).map_err(|e| e.to_string())?;
    crate::atomic_file::write_atomic(file, json)
}

/// Approves the setup script of the worktree at `path`. The core reads the script itself, so
/// the approved text is exactly what will run, and checks that `main_root` is that worktree's
/// main worktree, so an approval cannot be filed under another repo.
#[tauri::command]
pub async fn worktree_trust_setup(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    main_root: String,
    path: String,
) -> Result<(), String> {
    let root = repo_root(&path)?;
    let file = store_path(&app).ok_or("no config directory")?;
    crate::git::run(settings, root, move |g: &Git| {
        let actual = main_worktree_path(g)?;
        if !same_root(&actual, &main_root) {
            return Err(format!("{path} is not a worktree of {main_root}"));
        }
        let dir = crate::files::normalize(&path)?;
        let script =
            read_setup_script(&dir)?.ok_or_else(|| format!("{path} has no .bashboard/setup.sh"))?;
        trust(&file, &actual, &script)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::temp_dir;

    #[test]
    fn worktree_trust_round_trip_and_content_change() {
        let dir = temp_dir("wt-trust-store");
        let file = dir.join("nested").join(FILE_NAME);
        assert!(!is_trusted(&file, "C:\\r", "echo 1\n"));
        trust(&file, "C:\\r", "echo 1\n").unwrap();
        assert!(is_trusted(&file, "C:\\r", "echo 1\n"));
        assert!(is_trusted(&file, "c:/R/", "echo 1\n"));
        assert!(!is_trusted(&file, "C:\\r", "echo 1\r\n"));
        assert!(!is_trusted(&file, "C:\\other", "echo 1\n"));
        trust(&file, "C:\\other", "x").unwrap();
        trust(&file, "c:/r", "echo 2\n").unwrap();
        assert!(!is_trusted(&file, "C:\\r", "echo 1\n"));
        assert!(is_trusted(&file, "C:\\r", "echo 2\n"));
        assert!(is_trusted(&file, "C:\\other", "x"));
        let stored: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
        assert_eq!(stored["approved"].as_array().unwrap().len(), 2);
        assert!(!crate::atomic_file::with_suffix(&file, ".tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn worktree_trust_ignores_a_corrupt_store() {
        let dir = temp_dir("wt-trust-corrupt");
        let file = dir.join(FILE_NAME);
        fs::write(&file, "not json").unwrap();
        assert!(!is_trusted(&file, "/r", "x"));
        trust(&file, "/r", "x").unwrap();
        assert!(is_trusted(&file, "/r", "x"));
        let _ = fs::remove_dir_all(&dir);
    }
}
