//! Installs the shell integration lines into Git Bash's `~/.bashrc` (docs/design/app.md section
//! 3.14): the OSC 133 markers and the OSC 9;9 working directory, in a marked block. PowerShell
//! needs no install; its panes start with a prompt wrapper (`powershell_prompt`). The file work
//! runs over injectable paths so tests never touch the real ones; the Tauri commands resolve them
//! and delegate.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::hook_install::write_atomic;
use crate::profiles::GIT_BASH;

const BEGIN: &str = "# >>> bashboard shell integration >>>";
const END: &str = "# <<< bashboard shell integration <<<";

/// Must stay byte-identical to docs/setup.md's "New panes in the current folder" block; a test
/// enforces it.
const BASH_SNIPPET: &str = r#"PS0="${PS0-}"'\e]133;C\e\\'
__bashboard_prompt() {
  local status=$?
  printf '\e]133;D;%s\e\\' "$status"
  printf '\e]9;9;%s\e\\' "$(cygpath -w "$PWD")"
  return "$status"
}
PROMPT_COMMAND="__bashboard_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

const BASH_PROFILE: &str = "test -f ~/.profile && . ~/.profile\ntest -f ~/.bashrc && . ~/.bashrc\n";
const BACKUP_SUFFIX: &str = ".bashboard-backup";

/// What differs between the shells' startup files.
struct Flavor {
    snippet: &'static str,
    /// Earlier published snippets, recognized when pasted by hand and replaced by the current one.
    older: &'static [&'static str],
    /// A line outside the block that shows the user wrote their own version of the lines.
    is_custom_line: fn(&str) -> bool,
    /// How errors name the file.
    file_label: &'static str,
}

const BASH: Flavor = Flavor {
    snippet: BASH_SNIPPET,
    older: &[],
    is_custom_line: defines_bash_prompt_fn,
    file_label: "~/.bashrc",
};

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Missing,
    Installed,
    Outdated,
    HandAdded,
    Custom,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// The profile id the lines are for; only gitBash takes any.
    pub shell: String,
    /// The file the install writes.
    pub path: String,
    pub status: Status,
    pub block: String,
    pub creates_file: bool,
    /// `~/.bash_profile` is missing, so the install creates it.
    pub creates_bash_profile: bool,
    /// Something outside the file that keeps the lines from running, with how to fix it.
    pub warning: Option<String>,
}

/// The marked block, LF line endings.
fn block(f: &Flavor) -> String {
    format!("{BEGIN}\n{}{END}\n", f.snippet)
}

/// Lines with their endings kept, so untouched lines are rewritten byte for byte.
fn split_lines(text: &str) -> Vec<&str> {
    text.split_inclusive('\n').collect()
}

fn content(line: &str) -> &str {
    let line = line.strip_suffix('\n').unwrap_or(line);
    line.strip_suffix('\r').unwrap_or(line)
}

fn uses_crlf(text: &str) -> bool {
    text.find('\n').is_some_and(|i| text[..i].ends_with('\r'))
}

/// The index range of the marked block, end marker inclusive. `Err` for a begin marker with no
/// end, which is not ours to guess at.
fn marked_range(lines: &[&str]) -> Option<Result<(usize, usize), ()>> {
    let begin = lines.iter().position(|l| content(l).trim() == BEGIN)?;
    let end = lines[begin + 1..]
        .iter()
        .position(|l| content(l).trim() == END)
        .map(|i| begin + 1 + i);
    Some(end.map(|end| (begin, end)).ok_or(()))
}

/// The index range of the current or an older snippet appearing verbatim, last line inclusive.
fn verbatim_range(f: &Flavor, lines: &[&str]) -> Option<(usize, usize)> {
    std::iter::once(f.snippet)
        .chain(f.older.iter().copied())
        .find_map(|snippet| {
            let want: Vec<&str> = snippet.lines().collect();
            lines
                .windows(want.len())
                .position(|w| w.iter().zip(&want).all(|(l, s)| content(l) == *s))
                .map(|start| (start, start + want.len() - 1))
        })
}

fn defines_bash_prompt_fn(line: &str) -> bool {
    let line = line.trim_start();
    let line = line
        .strip_prefix("function ")
        .map(str::trim_start)
        .unwrap_or(line);
    line.strip_prefix("__bashboard_prompt").is_some_and(|rest| {
        rest.trim_start().starts_with('(') || rest.trim_start().starts_with('{') || rest.is_empty()
    })
}

/// Classifies the file's current text; `None` means the file does not exist.
fn status(f: &Flavor, text: Option<&str>) -> Status {
    let Some(text) = text else {
        return Status::Missing;
    };
    let lines = split_lines(text);
    match marked_range(&lines) {
        Some(Ok((begin, end))) => {
            let inner: Vec<&str> = lines[begin + 1..end].iter().map(|l| content(l)).collect();
            return if inner == f.snippet.lines().collect::<Vec<_>>() {
                Status::Installed
            } else {
                Status::Outdated
            };
        }
        Some(Err(())) => return Status::Custom,
        None => {}
    }
    if verbatim_range(f, &lines).is_some() {
        return Status::HandAdded;
    }
    if lines.iter().any(|l| (f.is_custom_line)(content(l))) {
        return Status::Custom;
    }
    Status::Missing
}

fn block_with(f: &Flavor, eol: &str) -> String {
    if eol == "\n" {
        block(f)
    } else {
        block(f).replace('\n', eol)
    }
}

fn replace_range(f: &Flavor, lines: &[&str], (start, end): (usize, usize), eol: &str) -> String {
    let mut out: String = lines[..start].concat();
    out.push_str(&block_with(f, eol));
    out.push_str(&lines[end + 1..].concat());
    out
}

/// The file's new text, keeping its line endings. Errors for hand-customized lines.
fn apply(f: &Flavor, text: Option<&str>) -> Result<String, String> {
    let current = text.unwrap_or("");
    let eol = if uses_crlf(current) { "\r\n" } else { "\n" };
    let lines = split_lines(current);
    match status(f, text) {
        Status::Installed => Ok(current.to_string()),
        Status::Custom => Err(format!(
            "{} already has customized Bashboard shell integration lines; update them by hand.",
            f.file_label
        )),
        Status::Outdated => {
            let Some(Ok(range)) = marked_range(&lines) else {
                unreachable!()
            };
            Ok(replace_range(f, &lines, range, eol))
        }
        Status::HandAdded => {
            let range = verbatim_range(f, &lines).expect("status found the snippet");
            Ok(replace_range(f, &lines, range, eol))
        }
        Status::Missing => {
            let mut out = current.to_string();
            if !out.is_empty() {
                if !out.ends_with('\n') {
                    out.push_str(eol);
                }
                if lines.last().is_some_and(|l| !content(l).trim().is_empty()) {
                    out.push_str(eol);
                }
            }
            out.push_str(&block_with(f, eol));
            Ok(out)
        }
    }
}

/// `<file>.bashboard-backup` beside the file.
fn backup_path(file: &Path) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(BACKUP_SUFFIX);
    file.with_file_name(name)
}

/// Git Bash's own rule: `HOME`, falling back to `USERPROFILE`.
fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from)
        .ok_or_else(|| "could not find the home directory".into())
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
    }
}

fn read_bashrc(path: &Path) -> Result<Option<String>, String> {
    read_optional(path)?
        .map(|b| {
            String::from_utf8(b).map_err(|_| {
                format!(
                    "{} is not valid UTF-8; add the lines by hand",
                    path.display()
                )
            })
        })
        .transpose()
}

/// Git Bash's login shell reads `~/.bash_profile`, which must source `~/.bashrc` for the lines
/// to run. Returns (creates it, warning).
fn bash_profile_state(home: &Path) -> Result<(bool, Option<String>), String> {
    let path = home.join(".bash_profile");
    Ok(match read_optional(&path)? {
        None => (true, None),
        Some(b) if b.windows(b".bashrc".len()).any(|w| w == b".bashrc") => (false, None),
        Some(_) => (
            false,
            Some(format!(
                "{} does not mention .bashrc, so login shells may not run these lines; add `test -f ~/.bashrc && . ~/.bashrc` to it.",
                path.display()
            )),
        ),
    })
}

fn bash_preview_in(home: &Path) -> Result<Preview, String> {
    let bashrc = home.join(".bashrc");
    let text = read_bashrc(&bashrc)?;
    let (creates_bash_profile, warning) = bash_profile_state(home)?;
    Ok(Preview {
        shell: GIT_BASH.into(),
        path: bashrc.to_string_lossy().into_owned(),
        status: status(&BASH, text.as_deref()),
        block: block(&BASH),
        creates_file: text.is_none(),
        creates_bash_profile,
        warning,
    })
}

fn bash_install_in(home: &Path) -> Result<(), String> {
    let bashrc = home.join(".bashrc");
    let text = read_bashrc(&bashrc)?;
    // Computed before any write so a customized file leaves the disk untouched.
    let next = apply(&BASH, text.as_deref())?;
    let (creates_bash_profile, _) = bash_profile_state(home)?;
    if creates_bash_profile {
        write_atomic(&home.join(".bash_profile"), BASH_PROFILE)?;
    }
    if text.as_deref() == Some(next.as_str()) {
        return Ok(());
    }
    if text.is_some() {
        std::fs::copy(&bashrc, backup_path(&bashrc))
            .map_err(|e| format!("could not back up {}: {e}", bashrc.display()))?;
    }
    write_atomic(&bashrc, &next)
}

fn preview_for(shell: &str) -> Result<Preview, String> {
    match shell {
        GIT_BASH => bash_preview_in(&home_dir()?),
        _ => Err(format!("{shell} has no shell integration to install")),
    }
}

fn install_for(shell: &str) -> Result<(), String> {
    match shell {
        GIT_BASH => bash_install_in(&home_dir()?),
        _ => Err(format!("{shell} has no shell integration to install")),
    }
}

/// `shell` is a profile id and defaults to Git Bash, the only one with lines to install.
#[tauri::command]
pub async fn shell_integration_preview(shell: Option<String>) -> Result<Preview, String> {
    let shell = shell.unwrap_or_else(|| GIT_BASH.into());
    tauri::async_runtime::spawn_blocking(move || preview_for(&shell))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_integration_install(shell: Option<String>) -> Result<(), String> {
    let shell = shell.unwrap_or_else(|| GIT_BASH.into());
    tauri::async_runtime::spawn_blocking(move || install_for(&shell))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-shell-integration-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read(dir: &Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    const OLD_BLOCK: &str = "# >>> bashboard shell integration >>>\n__bashboard_prompt() { :; }\nPROMPT_COMMAND=__bashboard_prompt\n# <<< bashboard shell integration <<<\n";
    const BACKUP_NAME: &str = ".bashrc.bashboard-backup";

    #[test]
    fn setup_doc_contains_the_snippet_verbatim() {
        // core.autocrlf may check the doc out with CRLF, and .gitattributes does not pin it.
        let doc = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/setup.md"))
            .replace("\r\n", "\n");
        assert!(doc.contains(&format!("```sh\n{BASH_SNIPPET}```\n")));
    }

    #[test]
    fn status_missing() {
        assert_eq!(status(&BASH, None), Status::Missing);
        assert_eq!(status(&BASH, Some("")), Status::Missing);
        assert_eq!(status(&BASH, Some("alias ll='ls -l'\n")), Status::Missing);
    }

    #[test]
    fn status_installed_outdated_hand_added_custom() {
        assert_eq!(
            status(&BASH, Some(&format!("x=1\n\n{}", block(&BASH)))),
            Status::Installed
        );
        assert_eq!(
            status(&BASH, Some(&format!("x=1\n{OLD_BLOCK}y=2\n"))),
            Status::Outdated
        );
        assert_eq!(
            status(&BASH, Some(&format!("x=1\n{BASH_SNIPPET}y=2\n"))),
            Status::HandAdded
        );
        let custom = BASH_SNIPPET.replace("cygpath -w", "cygpath -m");
        assert_eq!(status(&BASH, Some(&custom)), Status::Custom);
        assert_eq!(
            status(&BASH, Some("function __bashboard_prompt {\n:\n}\n")),
            Status::Custom
        );
        assert_eq!(
            status(&BASH, Some(&format!("{BEGIN}\nfoo\n"))),
            Status::Custom
        );
    }

    #[test]
    fn apply_missing_appends_after_one_blank_line() {
        let b = block(&BASH);
        assert_eq!(apply(&BASH, None).unwrap(), b);
        assert_eq!(apply(&BASH, Some("")).unwrap(), b);
        assert_eq!(apply(&BASH, Some("x=1")).unwrap(), format!("x=1\n\n{b}"));
        assert_eq!(apply(&BASH, Some("x=1\n")).unwrap(), format!("x=1\n\n{b}"));
        assert_eq!(
            apply(&BASH, Some("x=1\n\n")).unwrap(),
            format!("x=1\n\n{b}")
        );
    }

    #[test]
    fn apply_outdated_and_hand_added_replace_in_place() {
        let expected = format!("x=1\n{}y=2\n", block(&BASH));
        assert_eq!(
            apply(&BASH, Some(&format!("x=1\n{OLD_BLOCK}y=2\n"))).unwrap(),
            expected
        );
        assert_eq!(
            apply(&BASH, Some(&format!("x=1\n{BASH_SNIPPET}y=2\n"))).unwrap(),
            expected
        );
    }

    #[test]
    fn apply_installed_is_unchanged_and_custom_errors() {
        let text = format!("x=1\n\n{}", block(&BASH));
        assert_eq!(apply(&BASH, Some(&text)).unwrap(), text);
        let custom = BASH_SNIPPET.replace("cygpath -w", "cygpath -m");
        assert!(apply(&BASH, Some(&custom)).unwrap_err().contains("by hand"));
    }

    #[test]
    fn apply_keeps_crlf() {
        let crlf_block = block(&BASH).replace('\n', "\r\n");
        assert_eq!(
            apply(&BASH, Some("x=1\r\n")).unwrap(),
            format!("x=1\r\n\r\n{crlf_block}")
        );
        let old = format!("x=1\r\n{}y=2\r\n", OLD_BLOCK.replace('\n', "\r\n"));
        assert_eq!(status(&BASH, Some(&old)), Status::Outdated);
        assert_eq!(
            apply(&BASH, Some(&old)).unwrap(),
            format!("x=1\r\n{crlf_block}y=2\r\n")
        );
        let hand = format!("x=1\r\n{}", BASH_SNIPPET.replace('\n', "\r\n"));
        assert_eq!(status(&BASH, Some(&hand)), Status::HandAdded);
        assert_eq!(
            apply(&BASH, Some(&hand)).unwrap(),
            format!("x=1\r\n{crlf_block}")
        );
        assert_eq!(status(&BASH, Some(&crlf_block)), Status::Installed);
    }

    #[test]
    fn install_into_empty_home_creates_bashrc_and_bash_profile() {
        let dir = temp_dir("fresh");
        let p = bash_preview_in(&dir).unwrap();
        assert_eq!(p.status, Status::Missing);
        assert!(p.creates_file && p.creates_bash_profile);
        assert_eq!(p.warning, None);
        bash_install_in(&dir).unwrap();
        assert_eq!(read(&dir, ".bashrc"), block(&BASH));
        assert_eq!(read(&dir, ".bash_profile"), BASH_PROFILE);
        assert!(!dir.join(BACKUP_NAME).exists());
        assert_eq!(bash_preview_in(&dir).unwrap().status, Status::Installed);
    }

    #[test]
    fn bash_profile_without_bashrc_warns_and_is_left_alone() {
        let dir = temp_dir("profile");
        std::fs::write(dir.join(".bash_profile"), "export X=1\n").unwrap();
        let p = bash_preview_in(&dir).unwrap();
        assert!(!p.creates_bash_profile);
        assert!(p.warning.unwrap().contains(".bashrc"));
        bash_install_in(&dir).unwrap();
        assert_eq!(read(&dir, ".bash_profile"), "export X=1\n");

        let dir = temp_dir("profile-ok");
        std::fs::write(dir.join(".bash_profile"), BASH_PROFILE).unwrap();
        assert_eq!(bash_preview_in(&dir).unwrap().warning, None);
    }

    #[test]
    fn install_backs_up_existing_bashrc_and_overwrites_old_backup() {
        let dir = temp_dir("backup");
        std::fs::write(dir.join(BACKUP_NAME), "older").unwrap();
        std::fs::write(dir.join(".bashrc"), "x=1\n").unwrap();
        bash_install_in(&dir).unwrap();
        assert_eq!(read(&dir, BACKUP_NAME), "x=1\n");
        assert_eq!(read(&dir, ".bashrc"), format!("x=1\n\n{}", block(&BASH)));
    }

    #[test]
    fn custom_or_non_utf8_bashrc_errors_and_writes_nothing() {
        let dir = temp_dir("custom");
        let custom = BASH_SNIPPET.replace("cygpath -w", "cygpath -m");
        std::fs::write(dir.join(".bashrc"), &custom).unwrap();
        assert!(bash_install_in(&dir).is_err());
        assert_eq!(read(&dir, ".bashrc"), custom);
        assert!(!dir.join(BACKUP_NAME).exists());
        assert!(!dir.join(".bash_profile").exists());

        let dir = temp_dir("utf8");
        std::fs::write(dir.join(".bashrc"), b"x=\xff\n").unwrap();
        assert!(bash_preview_in(&dir).unwrap_err().contains("UTF-8"));
        assert!(bash_install_in(&dir).is_err());
    }

    #[test]
    fn preview_serializes_camel_case() {
        let dir = temp_dir("wire");
        let v = serde_json::to_value(bash_preview_in(&dir).unwrap()).unwrap();
        assert_eq!(v["shell"], "gitBash");
        assert!(v["path"].is_string());
        assert_eq!(v["status"], "missing");
        assert_eq!(v["block"], block(&BASH));
        assert_eq!(v["createsFile"], true);
        assert_eq!(v["createsBashProfile"], true);
        assert!(v["warning"].is_null());
        assert_eq!(
            serde_json::to_value(Status::HandAdded).unwrap(),
            "handAdded"
        );
    }

    #[test]
    fn other_shells_have_no_integration() {
        for shell in ["cmd", "pwsh", "powershell"] {
            assert!(preview_for(shell).is_err());
            assert!(install_for(shell).is_err());
        }
    }
}
