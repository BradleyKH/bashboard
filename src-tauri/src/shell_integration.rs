//! Installs the shell integration lines (OSC 133 markers and OSC 9;9 working directory) into
//! `~/.bashrc` (docs/design.md section 3.14). The file work runs over an injectable home
//! directory so tests never touch the real one; the Tauri commands resolve home and delegate.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::hook_install::write_atomic;

const BEGIN: &str = "# >>> bashboard shell integration >>>";
const END: &str = "# <<< bashboard shell integration <<<";

/// Must stay byte-identical to the README's "New panes in the current folder" block; a test
/// enforces it.
const SNIPPET: &str = r#"PS0="${PS0-}"'\e]133;C\e\\'
__bashboard_prompt() {
  local status=$?
  printf '\e]133;D;%s\e\\' "$status"
  printf '\e]9;9;%s\e\\' "$(cygpath -w "$PWD")"
  return "$status"
}
PROMPT_COMMAND="__bashboard_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
"#;

const BASH_PROFILE: &str = "test -f ~/.profile && . ~/.profile\ntest -f ~/.bashrc && . ~/.bashrc\n";
const BACKUP_NAME: &str = ".bashrc.bashboard-backup";

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
    pub bashrc_path: String,
    pub status: Status,
    pub block: String,
    pub creates_bashrc: bool,
    pub creates_bash_profile: bool,
    pub bash_profile_warning: Option<String>,
}

/// The marked block, LF line endings.
fn block() -> String {
    format!("{BEGIN}\n{SNIPPET}{END}\n")
}

fn snippet_lines() -> Vec<&'static str> {
    SNIPPET.lines().collect()
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

/// The index range of the README snippet appearing verbatim, last line inclusive.
fn verbatim_range(lines: &[&str]) -> Option<(usize, usize)> {
    let want = snippet_lines();
    lines
        .windows(want.len())
        .position(|w| w.iter().zip(&want).all(|(l, s)| content(l) == *s))
        .map(|start| (start, start + want.len() - 1))
}

fn defines_prompt_fn(line: &str) -> bool {
    let line = content(line).trim_start();
    let line = line
        .strip_prefix("function ")
        .map(str::trim_start)
        .unwrap_or(line);
    line.strip_prefix("__bashboard_prompt").is_some_and(|rest| {
        rest.trim_start().starts_with('(') || rest.trim_start().starts_with('{') || rest.is_empty()
    })
}

/// Classifies the current `.bashrc` text; `None` means the file does not exist.
pub fn status(text: Option<&str>) -> Status {
    let Some(text) = text else {
        return Status::Missing;
    };
    let lines = split_lines(text);
    match marked_range(&lines) {
        Some(Ok((begin, end))) => {
            let inner: Vec<&str> = lines[begin + 1..end].iter().map(|l| content(l)).collect();
            return if inner == snippet_lines() {
                Status::Installed
            } else {
                Status::Outdated
            };
        }
        Some(Err(())) => return Status::Custom,
        None => {}
    }
    if verbatim_range(&lines).is_some() {
        return Status::HandAdded;
    }
    if lines.iter().any(|l| defines_prompt_fn(l)) {
        return Status::Custom;
    }
    Status::Missing
}

fn block_with(eol: &str) -> String {
    if eol == "\n" {
        block()
    } else {
        block().replace('\n', eol)
    }
}

fn replace_range(lines: &[&str], (start, end): (usize, usize), eol: &str) -> String {
    let mut out: String = lines[..start].concat();
    out.push_str(&block_with(eol));
    out.push_str(&lines[end + 1..].concat());
    out
}

/// The new `.bashrc` text, keeping the file's line endings. Errors for hand-customized lines.
pub fn apply(text: Option<&str>) -> Result<String, String> {
    let current = text.unwrap_or("");
    let eol = if uses_crlf(current) { "\r\n" } else { "\n" };
    let lines = split_lines(current);
    match status(text) {
        Status::Installed => Ok(current.to_string()),
        Status::Custom => Err(
            "~/.bashrc already has customized Bashboard shell integration lines; update them by hand."
                .into(),
        ),
        Status::Outdated => {
            let Some(Ok(range)) = marked_range(&lines) else { unreachable!() };
            Ok(replace_range(&lines, range, eol))
        }
        Status::HandAdded => {
            let range = verbatim_range(&lines).expect("status found the snippet");
            Ok(replace_range(&lines, range, eol))
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
            out.push_str(&block_with(eol));
            Ok(out)
        }
    }
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

fn preview_in(home: &Path) -> Result<Preview, String> {
    let bashrc = home.join(".bashrc");
    let text = read_bashrc(&bashrc)?;
    let (creates_bash_profile, bash_profile_warning) = bash_profile_state(home)?;
    Ok(Preview {
        bashrc_path: bashrc.to_string_lossy().into_owned(),
        status: status(text.as_deref()),
        block: block(),
        creates_bashrc: text.is_none(),
        creates_bash_profile,
        bash_profile_warning,
    })
}

fn install_in(home: &Path) -> Result<(), String> {
    let bashrc = home.join(".bashrc");
    let text = read_bashrc(&bashrc)?;
    // Computed before any write so a customized file leaves the disk untouched.
    let next = apply(text.as_deref())?;
    let (creates_bash_profile, _) = bash_profile_state(home)?;
    if creates_bash_profile {
        write_atomic(&home.join(".bash_profile"), BASH_PROFILE)?;
    }
    if text.as_deref() == Some(next.as_str()) {
        return Ok(());
    }
    if text.is_some() {
        std::fs::copy(&bashrc, home.join(BACKUP_NAME))
            .map_err(|e| format!("could not back up {}: {e}", bashrc.display()))?;
    }
    write_atomic(&bashrc, &next)
}

#[tauri::command]
pub async fn shell_integration_preview() -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(|| preview_in(&home_dir()?))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn shell_integration_install() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| install_in(&home_dir()?))
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

    #[test]
    fn readme_contains_the_snippet_verbatim() {
        // core.autocrlf may check README.md out with CRLF, and .gitattributes does not pin it.
        let readme = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../README.md"))
            .replace("\r\n", "\n");
        assert!(readme.contains(&format!("```sh\n{SNIPPET}```\n")));
    }

    #[test]
    fn status_missing() {
        assert_eq!(status(None), Status::Missing);
        assert_eq!(status(Some("")), Status::Missing);
        assert_eq!(status(Some("alias ll='ls -l'\n")), Status::Missing);
    }

    #[test]
    fn status_installed_outdated_hand_added_custom() {
        assert_eq!(
            status(Some(&format!("x=1\n\n{}", block()))),
            Status::Installed
        );
        assert_eq!(
            status(Some(&format!("x=1\n{OLD_BLOCK}y=2\n"))),
            Status::Outdated
        );
        assert_eq!(
            status(Some(&format!("x=1\n{SNIPPET}y=2\n"))),
            Status::HandAdded
        );
        let custom = SNIPPET.replace("cygpath -w", "cygpath -m");
        assert_eq!(status(Some(&custom)), Status::Custom);
        assert_eq!(
            status(Some("function __bashboard_prompt {\n:\n}\n")),
            Status::Custom
        );
        assert_eq!(status(Some(&format!("{BEGIN}\nfoo\n"))), Status::Custom);
    }

    #[test]
    fn apply_missing_appends_after_one_blank_line() {
        assert_eq!(apply(None).unwrap(), block());
        assert_eq!(apply(Some("")).unwrap(), block());
        assert_eq!(apply(Some("x=1")).unwrap(), format!("x=1\n\n{}", block()));
        assert_eq!(apply(Some("x=1\n")).unwrap(), format!("x=1\n\n{}", block()));
        assert_eq!(
            apply(Some("x=1\n\n")).unwrap(),
            format!("x=1\n\n{}", block())
        );
    }

    #[test]
    fn apply_outdated_and_hand_added_replace_in_place() {
        let expected = format!("x=1\n{}y=2\n", block());
        assert_eq!(
            apply(Some(&format!("x=1\n{OLD_BLOCK}y=2\n"))).unwrap(),
            expected
        );
        assert_eq!(
            apply(Some(&format!("x=1\n{SNIPPET}y=2\n"))).unwrap(),
            expected
        );
    }

    #[test]
    fn apply_installed_is_unchanged_and_custom_errors() {
        let text = format!("x=1\n\n{}", block());
        assert_eq!(apply(Some(&text)).unwrap(), text);
        let custom = SNIPPET.replace("cygpath -w", "cygpath -m");
        assert!(apply(Some(&custom)).unwrap_err().contains("by hand"));
    }

    #[test]
    fn apply_keeps_crlf() {
        let crlf_block = block().replace('\n', "\r\n");
        assert_eq!(
            apply(Some("x=1\r\n")).unwrap(),
            format!("x=1\r\n\r\n{crlf_block}")
        );
        let old = format!("x=1\r\n{}y=2\r\n", OLD_BLOCK.replace('\n', "\r\n"));
        assert_eq!(status(Some(&old)), Status::Outdated);
        assert_eq!(
            apply(Some(&old)).unwrap(),
            format!("x=1\r\n{crlf_block}y=2\r\n")
        );
        let hand = format!("x=1\r\n{}", SNIPPET.replace('\n', "\r\n"));
        assert_eq!(status(Some(&hand)), Status::HandAdded);
        assert_eq!(apply(Some(&hand)).unwrap(), format!("x=1\r\n{crlf_block}"));
        assert_eq!(status(Some(&crlf_block)), Status::Installed);
    }

    #[test]
    fn install_into_empty_home_creates_bashrc_and_bash_profile() {
        let dir = temp_dir("fresh");
        let p = preview_in(&dir).unwrap();
        assert_eq!(p.status, Status::Missing);
        assert!(p.creates_bashrc && p.creates_bash_profile);
        assert_eq!(p.bash_profile_warning, None);
        install_in(&dir).unwrap();
        assert_eq!(read(&dir, ".bashrc"), block());
        assert_eq!(read(&dir, ".bash_profile"), BASH_PROFILE);
        assert!(!dir.join(BACKUP_NAME).exists());
        assert_eq!(preview_in(&dir).unwrap().status, Status::Installed);
    }

    #[test]
    fn bash_profile_without_bashrc_warns_and_is_left_alone() {
        let dir = temp_dir("profile");
        std::fs::write(dir.join(".bash_profile"), "export X=1\n").unwrap();
        let p = preview_in(&dir).unwrap();
        assert!(!p.creates_bash_profile);
        assert!(p.bash_profile_warning.unwrap().contains(".bashrc"));
        install_in(&dir).unwrap();
        assert_eq!(read(&dir, ".bash_profile"), "export X=1\n");

        let dir = temp_dir("profile-ok");
        std::fs::write(dir.join(".bash_profile"), BASH_PROFILE).unwrap();
        assert_eq!(preview_in(&dir).unwrap().bash_profile_warning, None);
    }

    #[test]
    fn install_backs_up_existing_bashrc_and_overwrites_old_backup() {
        let dir = temp_dir("backup");
        std::fs::write(dir.join(BACKUP_NAME), "older").unwrap();
        std::fs::write(dir.join(".bashrc"), "x=1\n").unwrap();
        install_in(&dir).unwrap();
        assert_eq!(read(&dir, BACKUP_NAME), "x=1\n");
        assert_eq!(read(&dir, ".bashrc"), format!("x=1\n\n{}", block()));
    }

    #[test]
    fn custom_or_non_utf8_bashrc_errors_and_writes_nothing() {
        let dir = temp_dir("custom");
        let custom = SNIPPET.replace("cygpath -w", "cygpath -m");
        std::fs::write(dir.join(".bashrc"), &custom).unwrap();
        assert!(install_in(&dir).is_err());
        assert_eq!(read(&dir, ".bashrc"), custom);
        assert!(!dir.join(BACKUP_NAME).exists());
        assert!(!dir.join(".bash_profile").exists());

        let dir = temp_dir("utf8");
        std::fs::write(dir.join(".bashrc"), b"x=\xff\n").unwrap();
        assert!(preview_in(&dir).unwrap_err().contains("UTF-8"));
        assert!(install_in(&dir).is_err());
    }

    #[test]
    fn preview_serializes_camel_case() {
        let dir = temp_dir("wire");
        let v = serde_json::to_value(preview_in(&dir).unwrap()).unwrap();
        assert!(v["bashrcPath"].is_string());
        assert_eq!(v["status"], "missing");
        assert_eq!(v["block"], block());
        assert_eq!(v["createsBashrc"], true);
        assert_eq!(v["createsBashProfile"], true);
        assert!(v["bashProfileWarning"].is_null());
        assert_eq!(
            serde_json::to_value(Status::HandAdded).unwrap(),
            "handAdded"
        );
    }
}
