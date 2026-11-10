//! Parsing and resolution of `POST /cli` requests from `bb` (docs/design/app.md section 3.13).
//!
//! Pure: no Tauri types. The hook receiver passes the body and the calling pty id to [`parse`]
//! and emits the resolved [`CliCommand`] as `cli://command`; an `Err` becomes a 400.

use crate::files::{display, find_repo, normalize};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A request resolved to absolute paths and a repo root, so the front end needs no lookups.
/// `pty_id` is the core's pty id (`BASHBOARD_PANE_ID`), not a front end `p<n>` pane id.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliCommand {
    pub pty_id: u32,
    pub collapsed: bool,
    /// Opens the pane as the only pane of a new tab instead of a split of the calling pane.
    pub tab: bool,
    pub action: CliAction,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CliAction {
    #[serde(rename_all = "camelCase")]
    Open {
        path: String,
        is_dir: bool,
        root: String,
    },
    Edit {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
    },
    Git {
        root: String,
    },
    Search {
        root: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<String>,
    },
    Scratch {
        text: String,
    },
    /// The working directory's repo root, or none for the Overview outside a repo.
    Ship {
        #[serde(skip_serializing_if = "Option::is_none")]
        root: Option<String>,
    },
    Ports,
    Containers,
    /// A Local Browser pane; `url` is a normalized loopback http URL or a `file:///` URL of a local
    /// HTML file, or none for its start page.
    Browse {
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
    Term {
        cwd: String,
        /// Typed into the new shell followed by Enter, as text, so it follows that shell's syntax.
        #[serde(skip_serializing_if = "Option::is_none")]
        command: Option<String>,
    },
}

#[derive(Deserialize)]
struct Request {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    cwd: String,
    stdin: Option<String>,
}

pub fn parse(body: &[u8], pty_id: u32) -> Result<CliCommand, String> {
    let req: Request =
        serde_json::from_slice(body).map_err(|e| format!("invalid request body: {e}"))?;

    let cwd = normalize(&req.cwd)?;
    if !cwd.is_dir() {
        return Err(format!("working directory does not exist: {}", req.cwd));
    }

    let mut collapsed = false;
    let mut tab = false;
    let mut args = Vec::new();
    // Everything after `--` is an argument, so `bb term -- npm test -- --watch` keeps its flags.
    let mut rest: Option<Vec<String>> = None;
    let mut iter = req.args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--collapsed" => collapsed = true,
            "--tab" | "-t" => tab = true,
            "--" => {
                rest = Some(iter.collect());
                break;
            }
            _ if arg.starts_with("--") => return Err(format!("unknown option: {arg}")),
            _ => args.push(arg),
        }
    }
    if collapsed && tab {
        return Err("--collapsed and --tab cannot be combined".into());
    }
    // Only `term` tells its own arguments from the command after `--`; the others take both.
    let command_words = if req.command == "term" {
        rest
    } else {
        args.extend(rest.unwrap_or_default());
        None
    };

    let action = match req.command.as_str() {
        "open" => open(&cwd, &args)?,
        "edit" => edit(&cwd, &args)?,
        "git" => git(&cwd, &args)?,
        "search" => CliAction::Search {
            root: find_repo(&display(&cwd))?.root,
            query: (!args.is_empty()).then(|| args.join(" ")),
        },
        "scratch" => CliAction::Scratch {
            text: if args.is_empty() {
                req.stdin.unwrap_or_default()
            } else {
                args.join(" ")
            },
        },
        "term" => term(&cwd, &args, command_words)?,
        "ship" => {
            no_args("ship", &args)?;
            let info = find_repo(&display(&cwd))?;
            CliAction::Ship {
                root: info.is_git.then_some(info.root),
            }
        }
        "ports" => {
            no_args("ports", &args)?;
            CliAction::Ports
        }
        "containers" => {
            no_args("containers", &args)?;
            CliAction::Containers
        }
        "browse" => browse(&cwd, &args)?,
        other => return Err(format!("unknown command: {other}")),
    };
    // These show the app's existing pane wherever it is, or open a tab of their own, as the
    // keyboard does; they never split the calling pane, so there is nothing to collapse.
    let app_wide = matches!(
        action,
        CliAction::Ship { .. } | CliAction::Ports | CliAction::Containers
    );
    if collapsed && app_wide {
        return Err(format!("--collapsed does not apply to bb {}", req.command));
    }

    Ok(CliCommand {
        pty_id,
        collapsed,
        tab,
        action,
    })
}

/// Resolves `arg` against `cwd` and requires that it exists.
fn resolve_existing(cwd: &Path, arg: &str) -> Result<PathBuf, String> {
    let path = normalize(&display(&cwd.join(arg)))?;
    if !path.exists() {
        return Err(format!("no such file or folder: {}", display(&path)));
    }
    Ok(path)
}

fn open(cwd: &Path, args: &[String]) -> Result<CliAction, String> {
    let [arg] = args else {
        return Err("usage: bb open <path>".into());
    };
    let path = resolve_existing(cwd, arg)?;
    let is_dir = path.is_dir();
    // A file's repo is found from its folder; the fallback root of find_repo would be the file.
    let start = if is_dir {
        Some(path.as_path())
    } else {
        path.parent()
    };
    let root = match start {
        Some(dir) => find_repo(&display(dir))?.root,
        None => display(&path),
    };
    Ok(CliAction::Open {
        path: display(&path),
        is_dir,
        root,
    })
}

/// Splits a trailing `:<digits>` off `arg`, leaving a bare drive letter (`C:`) alone.
fn split_line(arg: &str) -> Result<(&str, Option<u32>), String> {
    let Some((head, tail)) = arg.rsplit_once(':') else {
        return Ok((arg, None));
    };
    let bare_drive = head.len() == 1 && head.chars().all(|c| c.is_ascii_alphabetic());
    if head.is_empty() || bare_drive || tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit())
    {
        return Ok((arg, None));
    }
    match tail.parse::<u32>() {
        Ok(line) if line >= 1 => Ok((head, Some(line))),
        _ => Err(format!("line must be 1 or more: {tail}")),
    }
}

fn edit(cwd: &Path, args: &[String]) -> Result<CliAction, String> {
    let [arg] = args else {
        return Err("usage: bb edit <path>[:<line>]".into());
    };
    let (target, line) = split_line(arg)?;
    let path = resolve_existing(cwd, target)?;
    Ok(CliAction::Edit {
        path: display(&path),
        line,
    })
}

fn git(cwd: &Path, args: &[String]) -> Result<CliAction, String> {
    if !args.is_empty() {
        return Err("usage: bb git".into());
    }
    let info = find_repo(&display(cwd))?;
    if !info.is_git {
        return Err("not a git repository".into());
    }
    Ok(CliAction::Git { root: info.root })
}

fn no_args(command: &str, args: &[String]) -> Result<(), String> {
    if args.is_empty() {
        Ok(())
    } else {
        Err(format!("usage: bb {command}"))
    }
}

const BROWSE_USAGE: &str = "usage: bb browse [<url or .html file>]";
const LOOPBACK_ONLY: &str =
    "Local Browser opens only localhost, 127.0.0.1, and local .html or .htm files.";

/// Mirrors `normalizeInput` in `localBrowserModel.ts`: `5173` and `:5173` mean
/// `http://localhost:5173/`, and a missing scheme means http. A path to an `.html` or `.htm`
/// file, absolute or relative to `cwd`, becomes a `file:///` URL.
fn browse(cwd: &Path, args: &[String]) -> Result<CliAction, String> {
    let url = match args {
        [] => None,
        [arg] => Some(normalize_browse_url(cwd, arg.trim())?),
        _ => return Err(BROWSE_USAGE.into()),
    };
    Ok(CliAction::Browse { url })
}

fn normalize_browse_url(cwd: &Path, text: &str) -> Result<String, String> {
    if text.is_empty() {
        return Err(BROWSE_USAGE.into());
    }
    // Loopback shorthand goes first so `localhost:3000/index.html` stays an address; a path
    // is tried only for what the address rules reject (a Windows path, or one with spaces).
    match loopback_url(text) {
        Ok(url) => Ok(url),
        Err(refusal) => file_url(cwd, text)?.ok_or(refusal),
    }
}

fn loopback_url(text: &str) -> Result<String, String> {
    if text.chars().any(char::is_whitespace) {
        return Err("a URL cannot contain spaces".into());
    }
    let digits = text.strip_prefix(':').unwrap_or(text);
    let candidate = if (1..=5).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    {
        let port: u32 = digits.parse().unwrap_or(0);
        if !(1..=65535).contains(&port) {
            return Err("ports run from 1 to 65535".into());
        }
        format!("http://localhost:{port}/")
    } else if has_scheme(text) {
        text.to_string()
    } else {
        format!("http://{text}")
    };
    let parsed = tauri::Url::parse(&candidate)
        .map_err(|_| format!("{text:?} is not a valid address. {LOOPBACK_ONLY}"))?;
    if !crate::browser_policy::is_loopback_url(parsed.as_str()) {
        return Err(LOOPBACK_ONLY.into());
    }
    Ok(parsed.to_string())
}

/// The `file:///` URL for an HTML file named by `text`, or `None` when `text` does not look like
/// a path to one (it names no existing entry and does not end in `.html` or `.htm`).
fn file_url(cwd: &Path, text: &str) -> Result<Option<String>, String> {
    if has_scheme(text) {
        return Ok(None);
    }
    let Ok(joined) = normalize(&display(&cwd.join(text))) else {
        return Ok(None);
    };
    let is_html = joined
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("html") || e.eq_ignore_ascii_case("htm"));
    if !is_html && !joined.exists() {
        return Ok(None);
    }
    let path = strip_verbatim(joined);
    if is_unc(&path) {
        return Err("UNC paths are not supported; map the share to a drive letter".into());
    }
    if !path.exists() {
        return Err(format!("no such file: {}", display(&path)));
    }
    if !is_html {
        return Err(format!("not an .html or .htm file: {}", display(&path)));
    }
    if !path.is_file() {
        return Err(format!("not a file: {}", display(&path)));
    }
    tauri::Url::from_file_path(&path)
        .map(|u| Some(u.to_string()))
        .map_err(|_| format!("cannot make a file URL from {}", display(&path)))
}

/// Drops a `\\?\` verbatim prefix, which a browser does not read as a file URL.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = display(&path);
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
        _ => path,
    }
}

fn is_unc(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(
        path.components().next(),
        Some(Component::Prefix(p))
            if matches!(p.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..) | Prefix::DeviceNS(_))
    )
}

/// True for a leading `scheme://`, so `localhost:3000` (a host and port) is not read as a scheme.
fn has_scheme(text: &str) -> bool {
    let Some((scheme, _)) = text.split_once("://") else {
        return false;
    };
    scheme.starts_with(|c: char| c.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
}

fn term(cwd: &Path, args: &[String], command: Option<Vec<String>>) -> Result<CliAction, String> {
    const USAGE: &str = "usage: bb term [<folder>] [-- <command>]";
    let dir = match args {
        [] => cwd.to_path_buf(),
        [arg] => resolve_existing(cwd, arg)?,
        _ => return Err(USAGE.into()),
    };
    if !dir.is_dir() {
        return Err(format!("not a folder: {}", display(&dir)));
    }
    let command = command.map(|words| words.join(" "));
    if command.as_deref().is_some_and(|c| c.trim().is_empty()) {
        return Err(USAGE.into());
    }
    Ok(CliAction::Term {
        cwd: display(&dir),
        command,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-cli-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A repo folder holding `src/a.rs`.
    fn repo(tag: &str) -> PathBuf {
        let dir = temp_dir(tag);
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src").join("a.rs"), "x").unwrap();
        dir
    }

    fn run(command: &str, args: &[&str], cwd: &Path) -> Result<CliCommand, String> {
        let body = json!({ "command": command, "args": args, "cwd": display(cwd) });
        parse(body.to_string().as_bytes(), 7)
    }

    fn abs(p: &Path) -> String {
        display(&normalize(&display(p)).unwrap())
    }

    #[test]
    fn open_folder_uses_its_own_repo_root() {
        let dir = repo("open-dir");
        let cmd = run("open", &["src"], &dir).unwrap();
        assert_eq!(cmd.pty_id, 7);
        assert!(!cmd.collapsed);
        assert_eq!(
            cmd.action,
            CliAction::Open {
                path: abs(&dir.join("src")),
                is_dir: true,
                root: abs(&dir),
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_file_roots_at_the_parent_folder() {
        let dir = repo("open-file");
        let cmd = run("open", &["src/a.rs"], &dir).unwrap();
        assert_eq!(
            cmd.action,
            CliAction::Open {
                path: abs(&dir.join("src").join("a.rs")),
                is_dir: false,
                root: abs(&dir),
            }
        );

        // Outside a repo the fallback root is the file's folder, not the file.
        let plain = temp_dir("open-file-plain");
        fs::write(plain.join("n.txt"), "x").unwrap();
        if !find_repo(&display(&plain)).unwrap().is_git {
            let CliAction::Open { root, .. } = run("open", &["n.txt"], &plain).unwrap().action
            else {
                panic!("expected open");
            };
            assert_eq!(root, abs(&plain));
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&plain);
    }

    #[test]
    fn open_resolves_relative_absolute_and_dotdot() {
        let dir = repo("open-resolve");
        let abs_arg = display(&dir.join("src"));
        let CliAction::Open { path, .. } = run("open", &[&abs_arg], &dir).unwrap().action else {
            panic!("expected open");
        };
        assert_eq!(path, abs(&dir.join("src")));

        let sub = dir.join("src");
        let CliAction::Open { path, .. } = run("open", &["../src/a.rs"], &sub).unwrap().action
        else {
            panic!("expected open");
        };
        assert_eq!(path, abs(&dir.join("src").join("a.rs")));
        assert!(!path.contains(".."));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_requires_one_existing_path() {
        let dir = repo("open-bad");
        assert!(run("open", &["nope"], &dir).unwrap_err().contains("no such"));
        assert!(run("open", &[], &dir).unwrap_err().starts_with("usage: bb open"));
        assert!(run("open", &["a", "b"], &dir).unwrap_err().starts_with("usage: bb open"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_splits_the_line_suffix() {
        let dir = repo("edit");
        let file = abs(&dir.join("src").join("a.rs"));

        assert_eq!(
            run("edit", &["src/a.rs:12"], &dir).unwrap().action,
            CliAction::Edit {
                path: file.clone(),
                line: Some(12)
            }
        );

        let with_drive = format!("{file}:12");
        assert_eq!(
            run("edit", &[&with_drive], &dir).unwrap().action,
            CliAction::Edit {
                path: file.clone(),
                line: Some(12)
            }
        );
        assert_eq!(
            run("edit", &[&file], &dir).unwrap().action,
            CliAction::Edit {
                path: file.clone(),
                line: None
            }
        );

        // A folder is allowed.
        assert!(matches!(
            run("edit", &["src"], &dir).unwrap().action,
            CliAction::Edit { line: None, .. }
        ));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn edit_rejects_bad_lines_and_arity() {
        let dir = repo("edit-bad");
        assert!(run("edit", &["src/a.rs:0"], &dir).unwrap_err().contains("1 or more"));
        // A non-numeric suffix is part of the name, which does not exist.
        assert!(run("edit", &["src/a.rs:abc"], &dir).unwrap_err().contains("no such"));
        assert!(run("edit", &["src/a.rs:"], &dir).unwrap_err().contains("no such"));
        assert!(run("edit", &["src/a.rs:99999999999"], &dir).is_err());
        assert!(run("edit", &["nope:3"], &dir).unwrap_err().contains("no such"));
        assert!(run("edit", &[], &dir).unwrap_err().starts_with("usage: bb edit"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_line_leaves_a_bare_drive_letter() {
        assert_eq!(split_line("C:12").unwrap(), ("C:12", None));
        assert_eq!(split_line(r"C:\x\a.rs:12").unwrap(), (r"C:\x\a.rs", Some(12)));
        assert_eq!(split_line(r"C:\x\a.rs").unwrap(), (r"C:\x\a.rs", None));
        assert_eq!(split_line("a.rs:3").unwrap(), ("a.rs", Some(3)));
        assert_eq!(split_line(":3").unwrap(), (":3", None));
    }

    #[test]
    fn git_resolves_the_repo_from_cwd() {
        let dir = repo("git");
        let cmd = run("git", &[], &dir.join("src")).unwrap();
        assert_eq!(cmd.action, CliAction::Git { root: abs(&dir) });
        assert!(run("git", &["x"], &dir).unwrap_err().starts_with("usage: bb git"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_refuses_outside_a_repo() {
        let dir = temp_dir("git-none");
        // Skip if the system temp folder itself sits inside a repo.
        if !find_repo(&display(&dir)).unwrap().is_git {
            assert_eq!(run("git", &[], &dir).unwrap_err(), "not a git repository");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_joins_the_query_and_roots_at_the_repo() {
        let dir = repo("search");
        let sub = dir.join("src");
        assert_eq!(
            run("search", &["foo", "bar"], &sub).unwrap().action,
            CliAction::Search {
                root: abs(&dir),
                query: Some("foo bar".into())
            }
        );
        assert_eq!(
            run("search", &[], &sub).unwrap().action,
            CliAction::Search {
                root: abs(&dir),
                query: None
            }
        );

        let plain = temp_dir("search-plain");
        if !find_repo(&display(&plain)).unwrap().is_git {
            let CliAction::Search { root, .. } = run("search", &[], &plain).unwrap().action else {
                panic!("expected search");
            };
            assert_eq!(root, abs(&plain));
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&plain);
    }

    #[test]
    fn scratch_prefers_args_over_stdin() {
        let dir = temp_dir("scratch");
        let with = |args: &[&str], stdin: Option<&str>| {
            let mut v = json!({ "command": "scratch", "args": args, "cwd": display(&dir) });
            if let Some(s) = stdin {
                v["stdin"] = json!(s);
            }
            parse(v.to_string().as_bytes(), 1).unwrap().action
        };
        assert_eq!(
            with(&["hello", "world"], Some("piped")),
            CliAction::Scratch {
                text: "hello world".into()
            }
        );
        assert_eq!(
            with(&[], Some("piped")),
            CliAction::Scratch {
                text: "piped".into()
            }
        );
        assert_eq!(with(&[], None), CliAction::Scratch { text: String::new() });
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn collapsed_is_accepted_in_any_position_and_removed() {
        let dir = repo("collapsed");
        for args in [vec!["--collapsed", "src"], vec!["src", "--collapsed"]] {
            let cmd = run("open", &args, &dir).unwrap();
            assert!(cmd.collapsed);
            assert!(!cmd.tab);
            assert!(matches!(cmd.action, CliAction::Open { is_dir: true, .. }));
        }
        assert!(run("git", &["--collapsed"], &dir).unwrap().collapsed);
        assert_eq!(
            run("search", &["a", "--collapsed", "b"], &dir).unwrap().action,
            CliAction::Search {
                root: abs(&dir),
                query: Some("a b".into())
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tab_takes_either_spelling_and_excludes_collapsed() {
        let dir = repo("tab");
        assert!(run("git", &["--tab"], &dir).unwrap().tab);
        assert!(run("open", &["-t", "src"], &dir).unwrap().tab);
        assert!(!run("git", &[], &dir).unwrap().tab);
        assert_eq!(
            run("git", &["-t", "--collapsed"], &dir).unwrap_err(),
            "--collapsed and --tab cannot be combined"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn double_dash_ends_options_for_every_command() {
        let dir = repo("dashdash");
        assert_eq!(
            run("search", &["--", "--collapsed"], &dir).unwrap().action,
            CliAction::Search {
                root: abs(&dir),
                query: Some("--collapsed".into())
            }
        );
        let cmd = run("scratch", &["-t", "--", "-t", "x"], &dir).unwrap();
        assert!(cmd.tab);
        assert_eq!(cmd.action, CliAction::Scratch { text: "-t x".into() });
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn term_opens_in_cwd_or_a_folder_with_an_optional_command() {
        let dir = repo("term");
        assert_eq!(
            run("term", &[], &dir).unwrap().action,
            CliAction::Term {
                cwd: abs(&dir),
                command: None
            }
        );
        assert_eq!(
            run("term", &["src", "--", "npm", "test", "--", "--watch", "--tab"], &dir)
                .unwrap()
                .action,
            CliAction::Term {
                cwd: abs(&dir.join("src")),
                command: Some("npm test -- --watch --tab".into())
            }
        );
        let cmd = run("term", &["--tab", "--", "npm run dev"], &dir).unwrap();
        assert!(cmd.tab);
        assert_eq!(
            cmd.action,
            CliAction::Term {
                cwd: abs(&dir),
                command: Some("npm run dev".into())
            }
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn term_rejects_files_missing_folders_and_empty_commands() {
        let dir = repo("term-bad");
        assert!(run("term", &["src/a.rs"], &dir).unwrap_err().starts_with("not a folder"));
        assert!(run("term", &["nope"], &dir).unwrap_err().contains("no such"));
        assert!(run("term", &["a", "b"], &dir).unwrap_err().starts_with("usage: bb term"));
        assert!(run("term", &["--"], &dir).unwrap_err().starts_with("usage: bb term"));
        assert!(run("term", &["--", " "], &dir).unwrap_err().starts_with("usage: bb term"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ship_targets_the_repo_or_the_overview() {
        let dir = repo("ship");
        assert_eq!(
            run("ship", &[], &dir.join("src")).unwrap().action,
            CliAction::Ship {
                root: Some(abs(&dir))
            }
        );
        let plain = temp_dir("ship-plain");
        if !find_repo(&display(&plain)).unwrap().is_git {
            assert_eq!(
                run("ship", &[], &plain).unwrap().action,
                CliAction::Ship { root: None }
            );
        }
        assert!(run("ship", &["x"], &dir).unwrap_err().starts_with("usage: bb ship"));
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&plain);
    }

    #[test]
    fn ports_and_containers_take_no_arguments_and_refuse_collapsed() {
        let dir = repo("ports");
        assert_eq!(run("ports", &[], &dir).unwrap().action, CliAction::Ports);
        assert_eq!(
            run("containers", &["-t"], &dir).unwrap().action,
            CliAction::Containers
        );
        assert!(run("ports", &["x"], &dir).unwrap_err().starts_with("usage: bb ports"));
        for command in ["ship", "ports", "containers"] {
            assert_eq!(
                run(command, &["--collapsed"], &dir).unwrap_err(),
                format!("--collapsed does not apply to bb {command}")
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn browse_normalizes_shorthand_to_loopback_urls() {
        let dir = repo("browse");
        let url = |arg: &str| match run("browse", &[arg], &dir).unwrap().action {
            CliAction::Browse { url } => url.unwrap(),
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(url("5199"), "http://localhost:5199/");
        assert_eq!(url(":5199"), "http://localhost:5199/");
        assert_eq!(url("localhost:3000/app?x=1"), "http://localhost:3000/app?x=1");
        assert_eq!(url("127.0.0.1:8080"), "http://127.0.0.1:8080/");
        assert_eq!(url("LOCALHOST"), "http://localhost/");
        assert_eq!(url("https://localhost:7001/x"), "https://localhost:7001/x");
        assert_eq!(
            run("browse", &[], &dir).unwrap().action,
            CliAction::Browse { url: None }
        );
        assert!(run("browse", &["--tab", "5199"], &dir).unwrap().tab);
        assert!(run("browse", &["--collapsed", "5199"], &dir).unwrap().collapsed);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn browse_refuses_non_loopback_and_bad_input() {
        let dir = repo("browse-refuse");
        for arg in [
            "example.com",
            "http://example.com",
            "https://a.localhost:3000",
            "ftp://localhost",
            "0",
            "70000",
            "a.localhost",
            "http://u:p@localhost",
        ] {
            assert!(run("browse", &[arg], &dir).is_err(), "{arg} should be refused");
        }
        assert!(run("browse", &["a", "b"], &dir).unwrap_err().starts_with("usage: bb browse"));
        assert!(run("browse", &["a b"], &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    fn browse_url(arg: &str, cwd: &Path) -> Result<String, String> {
        run("browse", &[arg], cwd).map(|cmd| match cmd.action {
            CliAction::Browse { url } => url.unwrap(),
            other => panic!("unexpected {other:?}"),
        })
    }

    #[test]
    fn browse_turns_html_files_into_file_urls() {
        let dir = temp_dir("browse-file");
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::write(dir.join("docs").join("my page.html"), "x").unwrap();
        fs::write(dir.join("index.HTM"), "x").unwrap();

        let url = browse_url("docs/my page.html", &dir).unwrap();
        assert!(url.starts_with("file:///"), "{url}");
        assert!(url.ends_with("/docs/my%20page.html"), "{url}");
        assert!(!url.contains('\\') && !url.contains("//?/"), "{url}");

        // Relative with `..` and an absolute path name the same file.
        let from_docs = browse_url("../docs/my page.html", &dir.join("docs")).unwrap();
        assert_eq!(from_docs, url);
        let abs_arg = display(&dir.join("docs").join("my page.html"));
        assert_eq!(browse_url(&abs_arg, &dir).unwrap(), url);

        // The extension match ignores case, and `.htm` counts.
        assert!(browse_url("index.HTM", &dir).unwrap().ends_with("/index.HTM"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn browse_refuses_missing_and_non_html_files() {
        let dir = temp_dir("browse-file-bad");
        fs::write(dir.join("notes.txt"), "x").unwrap();
        fs::create_dir_all(dir.join("folder.html")).unwrap();

        assert!(browse_url("missing.html", &dir).unwrap_err().starts_with("no such file"));
        assert!(browse_url("notes.txt", &dir).unwrap_err().starts_with("not an .html or .htm file"));
        assert!(browse_url("folder.html", &dir).unwrap_err().starts_with("not a file"));
        // An address that merely ends in .html is still an address.
        assert_eq!(
            browse_url("localhost:3000/index.html", &dir).unwrap(),
            "http://localhost:3000/index.html"
        );
        assert!(browse_url("http://example.com/a.html", &dir).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn serializes_browse() {
        assert_eq!(
            serde_json::to_value(CliAction::Browse { url: Some("http://localhost:1/".into()) })
                .unwrap(),
            json!({ "kind": "browse", "url": "http://localhost:1/" })
        );
        assert_eq!(
            serde_json::to_value(CliAction::Browse { url: None }).unwrap(),
            json!({ "kind": "browse" })
        );
    }

    #[test]
    fn unknown_options_and_commands_are_errors() {
        let dir = repo("unknown");
        assert_eq!(
            run("git", &["--force"], &dir).unwrap_err(),
            "unknown option: --force"
        );
        assert_eq!(run("help", &[], &dir).unwrap_err(), "unknown command: help");
        assert_eq!(run("frob", &[], &dir).unwrap_err(), "unknown command: frob");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bad_bodies_are_errors() {
        let dir = temp_dir("bodies");
        let cwd = display(&dir);
        assert!(parse(b"not json", 1).is_err());
        assert!(parse(b"[]", 1).is_err());
        assert!(parse(br#"{"args":[],"cwd":"C:\\"}"#, 1).is_err());
        for bad in [
            json!({ "command": 1, "cwd": cwd }),
            json!({ "command": "git", "args": "x", "cwd": cwd }),
            json!({ "command": "git", "args": [1], "cwd": cwd }),
            json!({ "command": "git", "cwd": 5 }),
            json!({ "command": "scratch", "cwd": cwd, "stdin": 3 }),
        ] {
            assert!(parse(bad.to_string().as_bytes(), 1).is_err(), "{bad}");
        }
        // Missing args means empty.
        let ok = json!({ "command": "scratch", "cwd": cwd });
        assert!(parse(ok.to_string().as_bytes(), 1).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cwd_must_be_an_absolute_existing_folder() {
        let dir = repo("cwd");
        let rel = json!({ "command": "git", "cwd": "src" });
        assert!(parse(rel.to_string().as_bytes(), 1).is_err());
        let missing = dir.join("missing");
        assert!(run("git", &[], &missing).unwrap_err().contains("does not exist"));
        let file = dir.join("src").join("a.rs");
        assert!(run("git", &[], &file).unwrap_err().contains("does not exist"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn serializes_camel_case_with_a_kind_tag() {
        let open = CliCommand {
            pty_id: 3,
            collapsed: true,
            tab: false,
            action: CliAction::Open {
                path: "p".into(),
                is_dir: false,
                root: "r".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&open).unwrap(),
            json!({
                "ptyId": 3,
                "collapsed": true,
                "tab": false,
                "action": { "kind": "open", "path": "p", "isDir": false, "root": "r" }
            })
        );
        let edit = CliAction::Edit {
            path: "p".into(),
            line: Some(4),
        };
        assert_eq!(
            serde_json::to_value(&edit).unwrap(),
            json!({ "kind": "edit", "path": "p", "line": 4 })
        );
        let search = CliAction::Search {
            root: "r".into(),
            query: None,
        };
        assert_eq!(
            serde_json::to_value(&search).unwrap(),
            json!({ "kind": "search", "root": "r" })
        );
        let git = serde_json::to_value(CliAction::Git { root: "r".into() }).unwrap();
        assert_eq!(git, json!({ "kind": "git", "root": "r" }));
        let scratch = serde_json::to_value(CliAction::Scratch { text: "t".into() }).unwrap();
        assert_eq!(scratch, json!({ "kind": "scratch", "text": "t" }));
        let term = CliAction::Term {
            cwd: "c".into(),
            command: None,
        };
        assert_eq!(serde_json::to_value(&term).unwrap(), json!({ "kind": "term", "cwd": "c" }));
        assert_eq!(
            serde_json::to_value(CliAction::Ship { root: None }).unwrap(),
            json!({ "kind": "ship" })
        );
        assert_eq!(serde_json::to_value(CliAction::Ports).unwrap(), json!({ "kind": "ports" }));
        assert_eq!(
            serde_json::to_value(CliAction::Containers).unwrap(),
            json!({ "kind": "containers" })
        );
    }
}
