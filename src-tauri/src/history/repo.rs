//! The main repository a session's folder belongs to, so sessions in a repo's linked worktrees
//! group under the repo itself. Reads `.git` entries directly and never runs git.

use std::path::{Path, PathBuf};

use crate::files::{display, normalize};
use crate::git_watch::resolve_dirs;

/// The working tree root of the main repository holding `cwd`, or `None` outside git. A linked
/// worktree's `.git` file leads through its `commondir` to the main repo's `.git` folder, whose
/// parent is returned. When the common dir is not named `.git` (a submodule's
/// `.git/modules/<name>`, or a bare repo), the folder holding the `.git` entry is the answer.
pub fn main_repo_root(cwd: &Path) -> Option<PathBuf> {
    let start = normalize(&display(cwd)).ok()?;
    let dir = start
        .ancestors()
        .find(|d| std::fs::symlink_metadata(d.join(".git")).is_ok())?;
    let dirs = resolve_dirs(dir).ok()?;
    // commondir is usually relative (`../..`), so resolve its `..` segments before asking for
    // the parent.
    let common = normalize(&display(&dirs.common_dir)).ok()?;
    if common.file_name().is_some_and(|n| n == ".git") {
        common.parent().map(Path::to_path_buf)
    } else {
        Some(dir.to_path_buf())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-history-repo-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        normalize(&display(&dir)).unwrap()
    }

    #[test]
    fn plain_repo_from_a_subfolder() {
        let base = temp_dir("plain");
        let repo = base.join("repo");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("src").join("deep")).unwrap();
        assert_eq!(
            main_repo_root(&repo.join("src").join("deep")),
            Some(repo.clone())
        );
        assert_eq!(main_repo_root(&repo), Some(repo));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn worktree_resolves_to_the_main_repo() {
        let base = temp_dir("worktree");
        let main = base.join("main");
        let wt_git = main.join(".git").join("worktrees").join("wt");
        fs::create_dir_all(&wt_git).unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(wt.join("sub")).unwrap();
        fs::write(wt.join(".git"), "gitdir: ../main/.git/worktrees/wt\n").unwrap();
        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        assert_eq!(main_repo_root(&wt.join("sub")), Some(main.clone()));
        // An absolute gitdir works the same.
        fs::write(wt.join(".git"), format!("gitdir: {}\n", display(&wt_git))).unwrap();
        assert_eq!(main_repo_root(&wt), Some(main));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn submodule_is_its_own_root() {
        let base = temp_dir("submodule");
        let modules = base.join("super").join(".git").join("modules").join("lib");
        fs::create_dir_all(&modules).unwrap();
        let lib = base.join("super").join("lib");
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join(".git"), "gitdir: ../.git/modules/lib\n").unwrap();
        assert_eq!(main_repo_root(&lib), Some(lib));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn outside_git_is_none() {
        let base = temp_dir("none");
        // The temp folder itself could sit inside a repo on some machines; only a missing or
        // broken `.git` below it is checked here.
        let broken = base.join("broken");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join(".git"), "gitdir: missing\n").unwrap();
        assert_eq!(main_repo_root(&broken), None);
        assert_eq!(main_repo_root(Path::new("relative/path")), None);
        let _ = fs::remove_dir_all(&base);
    }
}
