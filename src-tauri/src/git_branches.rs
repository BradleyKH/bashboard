//! The Git pane's branch commands (design section 3.9), run through `git.rs`'s runner.
//!
//! Every name from the pane is checked before it reaches git: a local name must pass
//! `check-ref-format --branch` and may not start with `-`, so git never reads it as an option.

use std::collections::HashSet;

use serde::Serialize;
use tauri::State;

use crate::{
    git::{Git, run},
    settings::SettingsState,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    name: String,
    /// Whether this worktree has it checked out.
    head: bool,
    upstream: Option<String>,
    /// The upstream is configured but its remote-tracking branch no longer exists.
    gone: bool,
    ahead: u32,
    behind: u32,
    /// Epoch ms of the tip commit.
    time: i64,
    subject: String,
    /// The worktree that has it checked out, when that is another worktree.
    worktree: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranch {
    /// `origin/feature/x`.
    name: String,
    remote: String,
    /// The part after the remote, which a local copy would be named.
    branch: String,
    time: i64,
    subject: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    local: Vec<LocalBranch>,
    /// Only remote branches no local branch tracks or shares a name with.
    remote: Vec<RemoteBranch>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    deleted: bool,
    /// The tip the branch pointed at, so the pane can offer to restore it.
    hash: String,
    /// Set when `branch -d` refused because the branch is not merged: its commits on no other ref.
    unmerged: Option<u32>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    /// The upstream was cleared, since git keeps it pointing at the old remote name.
    upstream_cleared: bool,
}

const SEP: char = '\u{1f}';

/// Parses `%(upstream:track)`: `[ahead 1, behind 2]`, `[gone]`, or empty.
pub(crate) fn parse_track(track: &str) -> (u32, u32, bool) {
    let inner = track.trim().trim_start_matches('[').trim_end_matches(']');
    if inner == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in inner.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

const LOCAL_FORMAT: &str = "--format=%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(worktreepath)%1f%(subject)";
const REMOTE_FORMAT: &str = "--format=%(refname)%1f%(symref)%1f%(committerdate:unix)%1f%(subject)";

/// Parses `for-each-ref refs/heads` in `LOCAL_FORMAT`, sorted current first, then newest first.
pub(crate) fn parse_local(text: &str) -> Vec<LocalBranch> {
    let mut out: Vec<LocalBranch> = text
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(7, SEP).collect();
            if f.len() < 7 || f[0].is_empty() {
                return None;
            }
            let head = f[1] == "*";
            let (ahead, behind, gone) = parse_track(f[3]);
            Some(LocalBranch {
                name: f[0].to_string(),
                head,
                upstream: (!f[2].is_empty()).then(|| f[2].to_string()),
                gone,
                ahead,
                behind,
                time: f[4].parse::<i64>().unwrap_or(0) * 1000,
                // %(worktreepath) also names this worktree for the current branch.
                worktree: (!head && !f[5].is_empty()).then(|| f[5].to_string()),
                subject: f[6].to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.head.cmp(&a.head).then(b.time.cmp(&a.time)));
    out
}

/// Parses `for-each-ref refs/remotes` in `REMOTE_FORMAT`, dropping `<remote>/HEAD` and every
/// branch a local branch already tracks or shares a name with. A remote name can hold `/`, so
/// the longest known remote that prefixes the ref wins.
pub(crate) fn parse_remote(
    text: &str,
    remotes: &[String],
    local: &[LocalBranch],
) -> Vec<RemoteBranch> {
    let tracked: HashSet<&str> = local.iter().filter_map(|b| b.upstream.as_deref()).collect();
    let names: HashSet<&str> = local.iter().map(|b| b.name.as_str()).collect();
    let mut out: Vec<RemoteBranch> = text
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(4, SEP).collect();
            if f.len() < 4 || !f[1].is_empty() {
                return None;
            }
            let name = f[0].strip_prefix("refs/remotes/")?;
            let remote = remotes
                .iter()
                .filter(|r| {
                    name.len() > r.len()
                        && name.starts_with(r.as_str())
                        && name.as_bytes()[r.len()] == b'/'
                })
                .max_by_key(|r| r.len())?;
            let branch = &name[remote.len() + 1..];
            if branch == "HEAD" || tracked.contains(name) || names.contains(branch) {
                return None;
            }
            Some(RemoteBranch {
                name: name.to_string(),
                remote: remote.clone(),
                branch: branch.to_string(),
                time: f[2].parse::<i64>().unwrap_or(0) * 1000,
                subject: f[3].to_string(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time).then(a.name.cmp(&b.name)));
    out
}

fn check_name(g: &Git, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.contains("@{") {
        return Err(format!("not a valid branch name: {name}"));
    }
    if !g.read(["check-ref-format", "--branch", name])?.ok {
        return Err(format!("not a valid branch name: {name}"));
    }
    Ok(())
}

/// The tip of an existing local branch, checking the name first.
fn local_tip(g: &Git, name: &str) -> Result<String, String> {
    check_name(g, name)?;
    let out = g.read(["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")])?;
    if out.ok {
        Ok(out.stdout())
    } else {
        Err(format!("There is no branch named {name}"))
    }
}

fn remotes(g: &Git) -> Result<Vec<String>, String> {
    Ok(Git::ok(g.read(["remote"])?)?
        .lines()
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect())
}

pub(crate) fn branches(g: &Git) -> Result<BranchList, String> {
    let local = parse_local(&Git::ok(g.read([
        "for-each-ref",
        LOCAL_FORMAT,
        "refs/heads",
    ])?)?);
    let remote_text = Git::ok(g.read(["for-each-ref", REMOTE_FORMAT, "refs/remotes"])?)?;
    let remote = parse_remote(&remote_text, &remotes(g)?, &local);
    Ok(BranchList { local, remote })
}

pub(crate) fn switch(g: &Git, name: &str) -> Result<(), String> {
    local_tip(g, name)?;
    Git::ok(g.write(["switch", "--no-guess", name])?).map(|_| ())
}

/// Creates a local branch tracking a remote branch and switches to it.
pub(crate) fn checkout_remote(g: &Git, name: &str) -> Result<(), String> {
    if name.starts_with('-') || name.contains("@{") {
        return Err(format!("not a remote branch: {name}"));
    }
    let full = format!("refs/remotes/{name}");
    if !g.read(["check-ref-format", &full])?.ok
        || !g.read(["rev-parse", "--verify", "-q", &full])?.ok
    {
        return Err(format!("There is no remote branch named {name}"));
    }
    Git::ok(g.write(["switch", "--track", name])?).map(|_| ())
}

/// `base` is a local branch, or HEAD when absent. The new branch never tracks anything, so the
/// pane's Publish button applies to it.
pub(crate) fn create(
    g: &Git,
    name: &str,
    base: Option<&str>,
    switch_to: bool,
) -> Result<(), String> {
    check_name(g, name)?;
    let start = match base {
        Some(b) => {
            local_tip(g, b)?;
            format!("refs/heads/{b}")
        }
        None => "HEAD".to_string(),
    };
    let out = if switch_to {
        g.write(["switch", "--no-track", "-c", name, &start])?
    } else {
        g.write(["branch", "--no-track", name, &start])?
    };
    Git::ok(out).map(|_| ())
}

pub(crate) fn rename(g: &Git, from: &str, to: &str) -> Result<RenameOutcome, String> {
    local_tip(g, from)?;
    check_name(g, to)?;
    let had_upstream = g
        .read(["rev-parse", "--abbrev-ref", &format!("{from}@{{upstream}}")])?
        .ok
        || g.read(["config", "--get", &format!("branch.{from}.merge")])?
            .ok;
    Git::ok(g.write(["branch", "-m", from, to])?)?;
    if had_upstream {
        Git::ok(g.write(["branch", "--unset-upstream", to])?)?;
    }
    Ok(RenameOutcome {
        upstream_cleared: had_upstream,
    })
}

/// `force` runs `branch -D`; otherwise a branch git calls not merged is left alone and reported.
pub(crate) fn delete(g: &Git, name: &str, force: bool) -> Result<DeleteOutcome, String> {
    let hash = local_tip(g, name)?;
    let out = g.write(["branch", if force { "-D" } else { "-d" }, name])?;
    if out.ok {
        return Ok(DeleteOutcome {
            deleted: true,
            hash,
            unmerged: None,
        });
    }
    let message = out.message();
    if force || !message.contains("not fully merged") {
        return Err(message);
    }
    // The commits only this branch holds: what a forced delete would leave unreachable by name.
    let count = Git::ok(g.read([
        "rev-list",
        "--count",
        &hash,
        "--not",
        &format!("--exclude={name}"),
        "--branches",
        "--remotes",
        "--tags",
    ])?)?;
    Ok(DeleteOutcome {
        deleted: false,
        hash,
        unmerged: Some(count.parse().unwrap_or(0)),
    })
}

/// Recreates a deleted branch at the tip it had.
pub(crate) fn restore(g: &Git, name: &str, hash: &str) -> Result<(), String> {
    check_name(g, name)?;
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("not a full commit hash: {hash}"));
    }
    Git::ok(g.write(["branch", name, hash])?).map(|_| ())
}

#[tauri::command]
pub async fn git_branches(
    settings: State<'_, SettingsState>,
    root: String,
) -> Result<BranchList, String> {
    run(settings, root, |g| branches(g)).await
}

#[tauri::command]
pub async fn git_switch(
    settings: State<'_, SettingsState>,
    root: String,
    name: String,
) -> Result<(), String> {
    run(settings, root, move |g| switch(g, &name)).await
}

#[tauri::command]
pub async fn git_checkout_remote(
    settings: State<'_, SettingsState>,
    root: String,
    name: String,
) -> Result<(), String> {
    run(settings, root, move |g| checkout_remote(g, &name)).await
}

#[tauri::command]
pub async fn git_create_branch(
    settings: State<'_, SettingsState>,
    root: String,
    name: String,
    base: Option<String>,
    switch_to: bool,
) -> Result<(), String> {
    run(settings, root, move |g| {
        create(g, &name, base.as_deref(), switch_to)
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(
    settings: State<'_, SettingsState>,
    root: String,
    from: String,
    to: String,
) -> Result<RenameOutcome, String> {
    run(settings, root, move |g| rename(g, &from, &to)).await
}

#[tauri::command]
pub async fn git_delete_branch(
    settings: State<'_, SettingsState>,
    root: String,
    name: String,
    force: bool,
) -> Result<DeleteOutcome, String> {
    run(settings, root, move |g| delete(g, &name, force)).await
}

#[tauri::command]
pub async fn git_restore_branch(
    settings: State<'_, SettingsState>,
    root: String,
    name: String,
    hash: String,
) -> Result<(), String> {
    run(settings, root, move |g| restore(g, &name, &hash)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{commit_file, repo, sh, temp_dir, with_bare_remote};
    use std::fs;

    fn names(list: &[LocalBranch]) -> Vec<&str> {
        list.iter().map(|b| b.name.as_str()).collect()
    }

    #[test]
    fn git_branches_parse_track() {
        assert_eq!(parse_track(""), (0, 0, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
        assert_eq!(parse_track("[ahead 3]"), (3, 0, false));
        assert_eq!(parse_track("[behind 2]"), (0, 2, false));
        assert_eq!(parse_track("[ahead 1, behind 4]"), (1, 4, false));
    }

    #[test]
    fn git_branches_parse_local_sorts_current_first_then_newest() {
        let text = [
            "old\u{1f} \u{1f}\u{1f}\u{1f}100\u{1f}\u{1f}Old work",
            "main\u{1f}*\u{1f}origin/main\u{1f}[behind 1]\u{1f}200\u{1f}C:/r\u{1f}Tip",
            "wt\u{1f} \u{1f}origin/wt\u{1f}[gone]\u{1f}300\u{1f}C:/r-wt\u{1f}Has: a colon",
        ]
        .join("\n");
        let list = parse_local(&text);
        assert_eq!(names(&list), ["main", "wt", "old"]);
        assert!(list[0].head);
        assert_eq!(list[0].worktree, None, "this worktree is not another one");
        assert_eq!(
            (list[0].behind, list[0].upstream.as_deref()),
            (1, Some("origin/main"))
        );
        assert!(list[1].gone);
        assert_eq!(list[1].worktree.as_deref(), Some("C:/r-wt"));
        assert_eq!(list[1].time, 300_000);
        assert_eq!(list[1].subject, "Has: a colon");
        assert_eq!(list[2].upstream, None);
    }

    #[test]
    fn git_branches_parse_remote_drops_head_tracked_and_shadowed() {
        let local = parse_local(
            "main\u{1f}*\u{1f}origin/main\u{1f}\u{1f}1\u{1f}\u{1f}m\nfix\u{1f} \u{1f}\u{1f}\u{1f}1\u{1f}\u{1f}f",
        );
        let text = [
            "refs/remotes/origin/HEAD\u{1f}refs/remotes/origin/main\u{1f}1\u{1f}m",
            "refs/remotes/origin/main\u{1f}\u{1f}1\u{1f}m",
            "refs/remotes/origin/fix\u{1f}\u{1f}1\u{1f}f",
            "refs/remotes/origin/feature/x\u{1f}\u{1f}5\u{1f}x",
            "refs/remotes/my/fork/y\u{1f}\u{1f}9\u{1f}y",
        ]
        .join("\n");
        let remotes = vec![
            "origin".to_string(),
            "my".to_string(),
            "my/fork".to_string(),
        ];
        let list = parse_remote(&text, &remotes, &local);
        let got: Vec<(&str, &str, &str)> = list
            .iter()
            .map(|b| (b.name.as_str(), b.remote.as_str(), b.branch.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("my/fork/y", "my/fork", "y"),
                ("origin/feature/x", "origin", "feature/x")
            ]
        );
    }

    #[test]
    fn git_branches_create_switch_rename_delete_restore() {
        let g = repo("branches");
        commit_file(&g, "a.txt", "one\n", "first");
        create(&g, "topic", None, false).unwrap();
        create(&g, "work", Some("topic"), true).unwrap();
        let list = branches(&g).unwrap();
        assert_eq!(names(&list.local)[0], "work");
        assert!(list.local[0].head);
        assert!(list.local.iter().all(|b| b.upstream.is_none()));

        switch(&g, "main").unwrap();
        commit_file(&g, "b.txt", "two\n", "only on main");
        switch(&g, "work").unwrap();
        commit_file(&g, "c.txt", "three\n", "only on work");
        switch(&g, "main").unwrap();

        rename(&g, "topic", "topic2").unwrap();
        assert!(local_tip(&g, "topic").is_err());
        assert!(local_tip(&g, "topic2").is_ok());

        // `topic2` is an ancestor of main, so -d deletes it.
        let out = delete(&g, "topic2", false).unwrap();
        assert!(out.deleted);
        restore(&g, "topic2", &out.hash).unwrap();
        assert_eq!(local_tip(&g, "topic2").unwrap(), out.hash);

        let out = delete(&g, "work", false).unwrap();
        assert_eq!((out.deleted, out.unmerged), (false, Some(1)));
        assert!(local_tip(&g, "work").is_ok());
        assert!(delete(&g, "work", true).unwrap().deleted);

        assert!(delete(&g, "main", true).is_err(), "the current branch");
    }

    #[test]
    fn git_branches_reject_option_like_and_invalid_names() {
        let g = repo("branch-names");
        commit_file(&g, "a.txt", "one\n", "first");
        for bad in [
            "", "-D", "--force", "a..b", "a b", "x.lock", "@{-1}", "a/", "~x",
        ] {
            assert!(create(&g, bad, None, false).is_err(), "{bad}");
        }
        assert!(switch(&g, "nope").is_err());
        assert!(checkout_remote(&g, "--all").is_err());
        assert!(restore(&g, "x", "abc").is_err());
    }

    #[test]
    fn git_branches_rename_clears_upstream_and_remote_checkout_tracks() {
        let g = repo("branch-remote");
        with_bare_remote(&g);
        commit_file(&g, "a.txt", "one\n", "first");
        sh(&g.root(), &["push", "-q", "-u", "origin", "main"]);
        sh(&g.root(), &["branch", "feat"]);
        sh(&g.root(), &["push", "-q", "-u", "origin", "feat"]);

        assert!(rename(&g, "feat", "feat2").unwrap().upstream_cleared);
        let list = branches(&g).unwrap();
        let feat2 = list.local.iter().find(|b| b.name == "feat2").unwrap();
        assert_eq!(feat2.upstream, None);
        assert_eq!(
            list.remote
                .iter()
                .map(|b| b.name.as_str())
                .collect::<Vec<_>>(),
            ["origin/feat"]
        );
        assert!(!rename(&g, "feat2", "feat3").unwrap().upstream_cleared);

        checkout_remote(&g, "origin/feat").unwrap();
        let list = branches(&g).unwrap();
        let feat = list.local.iter().find(|b| b.name == "feat").unwrap();
        assert!(feat.head);
        assert_eq!(feat.upstream.as_deref(), Some("origin/feat"));
        assert!(list.remote.is_empty());
    }

    #[test]
    fn git_branches_marks_other_worktrees() {
        let g = repo("branch-wt");
        commit_file(&g, "a.txt", "one\n", "first");
        let wt = temp_dir("branch-wt-2");
        fs::remove_dir_all(&wt).unwrap();
        sh(
            &g.root(),
            &["worktree", "add", "-q", "-b", "side", &wt.to_string_lossy()],
        );
        let list = branches(&g).unwrap();
        let side = list.local.iter().find(|b| b.name == "side").unwrap();
        assert!(side.worktree.is_some());
        assert!(switch(&g, "side").is_err());
        assert!(delete(&g, "side", true).is_err());
        sh(
            &g.root(),
            &["worktree", "remove", "--force", &wt.to_string_lossy()],
        );
    }
}
