//! Parsing and resolution of `POST /cli` requests from `bb` (docs/design.md section 3.13).
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
    let mut args = Vec::new();
    for arg in req.args {
        if arg == "--collapsed" {
            collapsed = true;
        } else if arg.starts_with("--") {
            return Err(format!("unknown option: {arg}"));
        } else {
            args.push(arg);
        }
    }

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
        other => return Err(format!("unknown command: {other}")),
    };

    Ok(CliCommand {
        pty_id,
        collapsed,
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
    }
}
