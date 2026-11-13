//! The branch size meter (docs/design/git.md section 3.25): lines and files a worktree changes
//! against the merge base with its comparison ref, counting uncommitted and untracked work and
//! leaving out tests, lockfiles, and generated files.

use std::{fs, io::Read, path::Path};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{
    files::display,
    git::{Git, run},
    git_worktrees::{comparison_for, configured_for},
    settings::SettingsState,
};

/// Untracked files larger than this count as a file with no lines.
const MAX_UNTRACKED_BYTES: u64 = 1024 * 1024;
/// How far into an untracked file to look for a NUL, as git does to call a file binary.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;

const TEST_SEGMENTS: [&str; 6] = ["test", "tests", "__tests__", "spec", "testdata", "fixtures"];
const LOCKFILES: [&str; 17] = [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "cargo.lock",
    "poetry.lock",
    "uv.lock",
    "pipfile.lock",
    "gemfile.lock",
    "go.sum",
    "composer.lock",
    "packages.lock.json",
    "package.resolved",
    "pubspec.lock",
    "mix.lock",
    "flake.lock",
];
/// Name suffixes of tool-generated sources: EF Core's model snapshot, and the `.Designer.cs`
/// files EF migrations, WinForms, and resx emit beside their hand-written halves.
const GENERATED_SUFFIXES: [&str; 2] = ["modelsnapshot.cs", ".designer.cs"];

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BranchSize {
    pub(crate) worktree: String,
    pub(crate) branch: Option<String>,
    pub(crate) comparison: Option<String>,
    pub(crate) lines: u64,
    pub(crate) added: u64,
    pub(crate) removed: u64,
    pub(crate) files: u64,
    pub(crate) excluded_lines: u64,
    pub(crate) excluded_files: u64,
}

/// One `--numstat` record; `None` counts are a binary file.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NumstatEntry {
    pub(crate) path: String,
    pub(crate) added: Option<u64>,
    pub(crate) removed: Option<u64>,
}

/// An untracked file and its line count; `None` is binary or too large to read.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Untracked {
    pub(crate) path: String,
    pub(crate) lines: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct Counts {
    pub(crate) added: u64,
    pub(crate) removed: u64,
    pub(crate) files: u64,
    pub(crate) excluded_lines: u64,
    pub(crate) excluded_files: u64,
}

/// Parses `diff --numstat -z`: `added\tremoved\tpath\0`, or for a rename an empty path field
/// followed by `old\0new\0`. Renames keep the new path.
pub(crate) fn parse_numstat(bytes: &[u8]) -> Vec<NumstatEntry> {
    let text = String::from_utf8_lossy(bytes);
    let mut fields = text.split('\0');
    let mut out = Vec::new();
    while let Some(rec) = fields.next() {
        let mut cols = rec.splitn(3, '\t');
        let (Some(a), Some(r), Some(path)) = (cols.next(), cols.next(), cols.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = fields.next();
            match fields.next() {
                Some(new) if !new.is_empty() => new.to_string(),
                _ => continue,
            }
        } else {
            path.to_string()
        };
        out.push(NumstatEntry {
            path,
            added: a.parse().ok(),
            removed: r.parse().ok(),
        });
    }
    out
}

/// Tests, lockfiles, and generated files, which the meter leaves out of the headline count.
pub(crate) fn is_excluded(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let segments: Vec<&str> = lower.split('/').filter(|s| !s.is_empty()).collect();
    let Some(name) = segments.last() else {
        return false;
    };
    if segments.iter().any(|s| TEST_SEGMENTS.contains(s)) || LOCKFILES.contains(name) {
        return true;
    }
    if GENERATED_SUFFIXES
        .iter()
        .any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
    {
        return true;
    }
    // `*.test.*` and friends need something after the marker, so `x.test` alone is not a test.
    let marked = |marker: &str| {
        name.find(marker)
            .is_some_and(|i| i > 0 && i + marker.len() < name.len())
    };
    marked(".test.")
        || marked(".spec.")
        || marked("_test.")
        || (name.starts_with("test_") && name.ends_with(".py"))
}

pub(crate) fn tally(entries: &[NumstatEntry], untracked: &[Untracked]) -> Counts {
    let mut c = Counts::default();
    let changes = entries
        .iter()
        .map(|e| {
            (
                e.path.as_str(),
                e.added.unwrap_or(0),
                e.removed.unwrap_or(0),
            )
        })
        .chain(
            untracked
                .iter()
                .map(|u| (u.path.as_str(), u.lines.unwrap_or(0), 0)),
        );
    for (path, added, removed) in changes {
        if is_excluded(path) {
            c.excluded_files += 1;
            c.excluded_lines += added + removed;
        } else {
            c.files += 1;
            c.added += added;
            c.removed += removed;
        }
    }
    c
}

/// Lines the way numstat counts them: a last line without a newline still counts.
fn count_lines(bytes: &[u8]) -> u64 {
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    newlines + u64::from(bytes.last().is_some_and(|&b| b != b'\n'))
}

fn untracked_lines(path: &Path) -> Option<u64> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_UNTRACKED_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    fs::File::open(path)
        .ok()?
        .take(MAX_UNTRACKED_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return None;
    }
    Some(count_lines(&bytes))
}

/// Untracked paths print relative to the folder git runs in, so `g` must run at the toplevel.
fn untracked(g: &Git) -> Result<Vec<Untracked>, String> {
    let out = g.read(["ls-files", "--others", "--exclude-standard", "-z"])?;
    if !out.ok {
        return Err(out.message());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(|p| Untracked {
            path: p.to_string(),
            lines: untracked_lines(&g.root().join(p)),
        })
        .collect())
}

fn toplevel(g: &Git) -> Result<Git, String> {
    let top = Git::ok(g.read(["rev-parse", "--show-toplevel"])?)?;
    // Git prints `C:/x`; keep native separators so `worktree` matches other commands' paths.
    let top = crate::files::normalize(&top).unwrap_or_else(|_| top.into());
    Ok(g.at(top))
}

/// `g` runs anywhere inside the worktree.
pub(crate) fn branch_size(g: &Git, configured: Option<&str>) -> Result<BranchSize, String> {
    let g = toplevel(g)?;
    let branch = {
        let out = g.read(["symbolic-ref", "-q", "--short", "HEAD"])?;
        out.ok.then(|| out.stdout()).filter(|b| !b.is_empty())
    };
    let (comparison, compare_ref) = comparison_for(&g, configured)?;
    let mut size = BranchSize {
        worktree: display(g.root()),
        branch,
        comparison,
        ..BranchSize::default()
    };
    let Some(compare_ref) = compare_ref else {
        return Ok(size);
    };
    // Unrelated histories and an unborn HEAD have no merge base; the meter reads zero.
    let base = {
        let out = g.read(["merge-base", "HEAD", &compare_ref])?;
        match out.ok.then(|| out.stdout()).filter(|b| !b.is_empty()) {
            Some(b) => b,
            None => return Ok(size),
        }
    };
    let diff = g.read([
        "diff",
        "--numstat",
        "-z",
        "-M",
        "--no-ext-diff",
        &base,
        "--",
    ])?;
    if !diff.ok {
        return Err(diff.message());
    }
    let c = tally(&parse_numstat(&diff.stdout), &untracked(&g)?);
    size.added = c.added;
    size.removed = c.removed;
    size.lines = c.added + c.removed;
    size.files = c.files;
    size.excluded_lines = c.excluded_lines;
    size.excluded_files = c.excluded_files;
    Ok(size)
}

#[tauri::command]
pub async fn git_branch_size(
    app: AppHandle,
    settings: State<'_, SettingsState>,
    path: String,
) -> Result<BranchSize, String> {
    run(settings, path, move |g| {
        let configured = configured_for(&app, g)?;
        branch_size(g, configured.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{Repo, commit_file, repo, sh, with_bare_remote};

    fn ns(path: &str, added: Option<u64>, removed: Option<u64>) -> NumstatEntry {
        NumstatEntry {
            path: path.into(),
            added,
            removed,
        }
    }

    #[test]
    fn git_branch_size_parse_numstat_plain_binary_and_rename() {
        let raw = concat!(
            "3\t1\tsrc/a.rs\0",
            "-\t-\timg.png\0",
            "2\t0\t\0old name.rs\0new name.rs\0",
            "0\t4\tdir/with\ttab.txt\0",
        );
        assert_eq!(
            parse_numstat(raw.as_bytes()),
            vec![
                ns("src/a.rs", Some(3), Some(1)),
                ns("img.png", None, None),
                ns("new name.rs", Some(2), Some(0)),
                ns("dir/with\ttab.txt", Some(0), Some(4)),
            ]
        );
        assert!(parse_numstat(b"").is_empty());
    }

    #[test]
    fn git_branch_size_exclusions() {
        for path in [
            "tests/a.rs",
            "src/test/x.ts",
            "a/__tests__/b.tsx",
            "spec/x.rb",
            "pkg/testdata/in.json",
            "e2e/fixtures/f.txt",
            "src/keys.test.ts",
            "src/a.spec.js",
            "pkg/x_test.go",
            "tools/test_thing.py",
            "pnpm-lock.yaml",
            "src-tauri/Cargo.lock",
            "web/package-lock.json",
            "yarn.lock",
            "poetry.lock",
            "uv.lock",
            "Gemfile.lock",
            "go.sum",
            "composer.lock",
            "bun.lock",
            "bun.lockb",
            "Pipfile.lock",
            "src/Api/packages.lock.json",
            "Package.resolved",
            "pubspec.lock",
            "mix.lock",
            "flake.lock",
            "src/Data/Migrations/AppDbContextModelSnapshot.cs",
            "src/Data/Migrations/20261112093000_AddOrders.Designer.cs",
            "src/Forms/MainForm.Designer.cs",
            "Properties/Resources.Designer.cs",
            "Tests/Upper.cs",
        ] {
            assert!(is_excluded(path), "{path}");
        }
        for path in [
            "src/main.rs",
            "src/testing.rs",
            "src/contest/a.rs",
            "latest.txt",
            "x.test",
            ".test.ts",
            "test_thing.rs",
            "docs/spec.md",
            "go.mod",
            "Cargo.toml",
            "src/Data/Migrations/20261112093000_AddOrders.cs",
            "src/Data/Migrations/ModelSnapshot.cs",
            "src/Designer.cs",
            "package.json",
        ] {
            assert!(!is_excluded(path), "{path}");
        }
    }

    #[test]
    fn git_branch_size_tally_applies_exclusions() {
        let entries = [
            ns("src/a.rs", Some(10), Some(2)),
            ns("img.png", None, None),
            ns("src/a.test.ts", Some(5), Some(5)),
            ns("pnpm-lock.yaml", Some(100), Some(50)),
        ];
        let untracked = [
            Untracked {
                path: "new.rs".into(),
                lines: Some(7),
            },
            Untracked {
                path: "big.bin".into(),
                lines: None,
            },
            Untracked {
                path: "tests/new.rs".into(),
                lines: Some(3),
            },
        ];
        assert_eq!(
            tally(&entries, &untracked),
            Counts {
                added: 17,
                removed: 2,
                files: 4,
                excluded_lines: 163,
                excluded_files: 3,
            }
        );
    }

    #[test]
    fn git_branch_size_count_lines_like_numstat() {
        assert_eq!(count_lines(b""), 0);
        assert_eq!(count_lines(b"a"), 1);
        assert_eq!(count_lines(b"a\n"), 1);
        assert_eq!(count_lines(b"a\nb"), 2);
        assert_eq!(count_lines(b"a\n\n"), 2);
    }

    #[test]
    fn git_branch_size_serializes_camel_case() {
        let v = serde_json::to_value(BranchSize::default()).unwrap();
        for key in [
            "worktree",
            "branch",
            "comparison",
            "lines",
            "added",
            "removed",
            "files",
            "excludedLines",
            "excludedFiles",
        ] {
            assert!(v.get(key).is_some(), "{key}");
        }
    }

    /// `main` pushed to origin, then a `feature` branch checked out.
    fn feature_repo(tag: &str) -> Repo {
        let g = repo(tag);
        with_bare_remote(&g);
        commit_file(&g, "base.txt", "1\n2\n3\n", "base");
        commit_file(&g, "moved.txt", "a\nb\nc\nd\ne\n", "to move");
        sh(g.root(), &["push", "-q", "-u", "origin", "main"]);
        sh(g.root(), &["switch", "-q", "-c", "feature"]);
        g
    }

    fn write(g: &Git, name: &str, bytes: &[u8]) {
        let path = g.root().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn git_branch_size_counts_committed_staged_unstaged_and_untracked() {
        let g = feature_repo("bs-count");
        let s = branch_size(&g, None).unwrap();
        assert_eq!(s.branch.as_deref(), Some("feature"));
        assert_eq!(s.comparison.as_deref(), Some("origin/main"));
        assert_eq!(s.worktree, display(g.root()));
        assert_eq!((s.lines, s.files, s.excluded_files), (0, 0, 0));

        // Committed: two lines added.
        commit_file(&g, "committed.txt", "x\ny\n", "committed");
        // Staged: one line changed in base.txt.
        write(&g, "base.txt", b"1\nTWO\n3\n");
        sh(g.root(), &["add", "--", "base.txt"]);
        // Unstaged on top of a staged file, and a fresh unstaged edit.
        write(&g, "committed.txt", b"x\ny\nz\n");
        // Untracked text, an untracked binary, and an oversized untracked file.
        write(&g, "new.txt", b"one\ntwo\nthree");
        write(&g, "blob.bin", b"ab\0cd\n");
        let big = vec![b'a'; (MAX_UNTRACKED_BYTES + 1) as usize];
        write(&g, "big.txt", &big);
        // Excluded: a test file and a lockfile.
        write(&g, "src/thing.test.ts", b"t\nt\n");
        commit_file(&g, "Cargo.lock", "l\nl\nl\n", "lock");

        let s = branch_size(&g, None).unwrap();
        // committed.txt +3, base.txt +1 -1, new.txt +3, blob.bin and big.txt 0.
        assert_eq!((s.added, s.removed, s.lines), (7, 1, 8));
        assert_eq!(s.files, 5);
        assert_eq!((s.excluded_lines, s.excluded_files), (5, 2));

        // From a subfolder the untracked paths still resolve against the toplevel.
        let sub = g.at(g.root().join("src"));
        let s2 = branch_size(&sub, None).unwrap();
        assert_eq!(s2, s);
    }

    #[test]
    fn git_branch_size_rename_counts_once_under_new_path() {
        let g = feature_repo("bs-rename");
        fs::create_dir_all(g.root().join("tests")).unwrap();
        sh(g.root(), &["mv", "moved.txt", "tests/moved.txt"]);
        let s = branch_size(&g, None).unwrap();
        assert_eq!((s.files, s.lines), (0, 0));
        assert_eq!((s.excluded_files, s.excluded_lines), (1, 0));

        sh(g.root(), &["mv", "tests/moved.txt", "renamed.txt"]);
        let s = branch_size(&g, None).unwrap();
        assert_eq!((s.files, s.lines, s.excluded_files), (1, 0, 0));
    }

    #[test]
    fn git_branch_size_detached_head() {
        let g = feature_repo("bs-detached");
        commit_file(&g, "c.txt", "c\n", "c");
        sh(g.root(), &["switch", "-q", "--detach"]);
        let s = branch_size(&g, None).unwrap();
        assert_eq!(s.branch, None);
        assert_eq!(s.comparison.as_deref(), Some("origin/main"));
        assert_eq!((s.files, s.lines), (1, 1));
    }

    #[test]
    fn git_branch_size_without_comparison_or_merge_base() {
        let lone = repo("bs-lone");
        commit_file(&lone, "a.txt", "1\n", "first");
        sh(lone.root(), &["branch", "-m", "trunk"]);
        fs::write(lone.root().join("b.txt"), "b\n").unwrap();
        let s = branch_size(&lone, None).unwrap();
        assert_eq!(s.branch.as_deref(), Some("trunk"));
        assert_eq!(s.comparison, None);
        assert_eq!((s.lines, s.files), (0, 0));

        // An orphan branch shares no history with main.
        let g = repo("bs-orphan");
        commit_file(&g, "a.txt", "1\n", "first");
        sh(g.root(), &["switch", "-q", "--orphan", "other"]);
        commit_file(&g, "o.txt", "o\n", "orphan");
        let s = branch_size(&g, None).unwrap();
        assert_eq!(s.comparison.as_deref(), Some("main"));
        assert_eq!((s.lines, s.files), (0, 0));
    }
}
