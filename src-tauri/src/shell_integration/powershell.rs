//! The PowerShell 7 and Windows PowerShell flavor of the shell integration (docs/design/app.md
//! section 3.14): a prompt wrapper that reports the folder (OSC 9;9), added to the shell's
//! `$PROFILE.CurrentUserCurrentHost`. Each shell has its own profile file, and only the shell
//! itself knows where (Documents may be redirected to OneDrive), so the path is asked of it.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use super::{
    Flavor, Preview, apply, backup_path, block, read_optional, status, write_atomic,
};
use crate::profiles::{self, POWERSHELL, PWSH};

/// Must stay byte-identical to docs/setup.md's PowerShell block; a test enforces it. `[char]27`
/// rather than the `` `e `` escape, which Windows PowerShell 5.1 does not know. The guard keeps a
/// re-run profile (`. $PROFILE`) from wrapping the wrapper, which would recurse forever.
pub(super) const SNIPPET: &str = r#"if (-not (Test-Path variable:Global:__BashboardOriginalPrompt)) {
  $Global:__BashboardOriginalPrompt = $function:prompt
}

function Global:prompt {
  $exit = $global:LASTEXITCODE
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $out = "$([char]27)]9;9;`"$loc`"$([char]7)" + (& $Global:__BashboardOriginalPrompt)
  $global:LASTEXITCODE = $exit   # keep the last native exit code visible to the user
  return $out
}
"#;

/// The snippet docs/setup.md published before the installer existed, which only PowerShell 7 ran
/// correctly.
const FIRST_SNIPPET: &str = r#"$Global:__BashboardOriginalPrompt = $function:prompt

function Global:prompt {
  $exit = $global:LASTEXITCODE
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $out = "`e]9;9;`"$loc`"`a" + (& $Global:__BashboardOriginalPrompt)
  $global:LASTEXITCODE = $exit   # keep the last native exit code visible to the user
  return $out
}
"#;

const POWERSHELL_FLAVOR: Flavor = Flavor {
    snippet: SNIPPET,
    older: &[FIRST_SNIPPET],
    is_custom_line: |line| line.contains("__BashboardOriginalPrompt"),
    file_label: "Your PowerShell profile",
};

/// Prints the profile path, then the effective execution policy. The output encoding is set
/// first because Windows PowerShell otherwise writes the OEM code page, which mangles a
/// non-ASCII user name in the path.
const QUERY: &str = "try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}; \
$PROFILE.CurrentUserCurrentHost; [string](Get-ExecutionPolicy)";

struct HostInfo {
    profile: PathBuf,
    policy: String,
}

fn parse_query(stdout: &str) -> Option<HostInfo> {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    let profile = PathBuf::from(lines.next()?);
    let policy = lines.next()?.to_string();
    Some(HostInfo { profile, policy })
}

fn exe_for(shell: &str) -> Result<&'static PathBuf, String> {
    match shell {
        PWSH => profiles::detected_pwsh().ok_or_else(|| "PowerShell 7 was not found".to_string()),
        POWERSHELL => profiles::detected_windows_powershell()
            .ok_or_else(|| "Windows PowerShell was not found".to_string()),
        _ => Err(format!("{shell} is not a PowerShell profile")),
    }
}

fn query_host(exe: &Path) -> Result<HostInfo, String> {
    let mut cmd = Command::new(exe);
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        QUERY,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    crate::editors::hide_console(&mut cmd);
    let out = cmd
        .output()
        .map_err(|e| format!("could not run {}: {e}", exe.display()))?;
    parse_query(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| {
        format!(
            "{} did not report its profile path: {}",
            exe.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )
    })
}

/// Restricted (Windows PowerShell's default on Windows clients) runs no scripts, and AllSigned
/// runs only signed ones, so either keeps the profile from loading.
fn policy_warning(policy: &str) -> Option<String> {
    let blocks =
        policy.eq_ignore_ascii_case("Restricted") || policy.eq_ignore_ascii_case("AllSigned");
    blocks.then(|| {
        format!(
            "PowerShell's execution policy is {policy}, so it will not run this profile. To allow it, run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in that shell."
        )
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Encoding {
    Utf8,
    Utf8Bom,
    /// What Windows PowerShell's `>` and `Out-File` write by default.
    Utf16Le,
}

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

fn decode(path: &Path, bytes: &[u8]) -> Result<(String, Encoding), String> {
    let by_hand = || {
        format!(
            "{} is not UTF-8 or UTF-16; add the lines by hand",
            path.display()
        )
    };
    if let Some(rest) = bytes.strip_prefix(UTF8_BOM) {
        let text = String::from_utf8(rest.to_vec()).map_err(|_| by_hand())?;
        return Ok((text, Encoding::Utf8Bom));
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        if rest.len() % 2 != 0 {
            return Err(by_hand());
        }
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        let text = String::from_utf16(&units).map_err(|_| by_hand())?;
        return Ok((text, Encoding::Utf16Le));
    }
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| by_hand())?;
    Ok((text, Encoding::Utf8))
}

fn encode(text: &str, enc: Encoding) -> Vec<u8> {
    match enc {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf8Bom => [UTF8_BOM, text.as_bytes()].concat(),
        Encoding::Utf16Le => [b"\xFF\xFE".as_slice()]
            .into_iter()
            .flatten()
            .copied()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect(),
    }
}

fn read_profile(path: &Path) -> Result<Option<(String, Encoding)>, String> {
    read_optional(path)?.map(|b| decode(path, &b)).transpose()
}

fn preview_at(shell: &str, path: &Path, policy: &str) -> Result<Preview, String> {
    let current = read_profile(path)?;
    let text = current.as_ref().map(|(t, _)| t.as_str());
    Ok(Preview {
        shell: shell.into(),
        path: path.to_string_lossy().into_owned(),
        status: status(&POWERSHELL_FLAVOR, text),
        block: block(&POWERSHELL_FLAVOR),
        creates_file: current.is_none(),
        creates_bash_profile: false,
        warning: policy_warning(policy),
    })
}

fn install_at(path: &Path) -> Result<(), String> {
    let current = read_profile(path)?;
    let text = current.as_ref().map(|(t, _)| t.as_str());
    let next = apply(&POWERSHELL_FLAVOR, text)?;
    if text == Some(next.as_str()) {
        return Ok(());
    }
    // A new profile is written as plain UTF-8: the block is ASCII, which every PowerShell reads.
    let enc = current.as_ref().map_or(Encoding::Utf8, |(_, e)| *e);
    if current.is_some() {
        std::fs::copy(path, backup_path(path))
            .map_err(|e| format!("could not back up {}: {e}", path.display()))?;
    }
    // write_atomic creates the folder, which a fresh Documents\PowerShell may not have.
    write_atomic(path, encode(&next, enc))
}

pub(super) fn preview(shell: &str) -> Result<Preview, String> {
    let host = query_host(exe_for(shell)?)?;
    preview_at(shell, &host.profile, &host.policy)
}

pub(super) fn install(shell: &str) -> Result<(), String> {
    let host = query_host(exe_for(shell)?)?;
    install_at(&host.profile)
}

#[cfg(test)]
mod tests {
    use super::super::Status;
    use super::super::tests::temp_dir;
    use super::*;

    #[test]
    fn setup_doc_contains_the_snippet_verbatim() {
        let doc = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/setup.md"))
            .replace("\r\n", "\n");
        assert!(doc.contains(&format!("```powershell\n{SNIPPET}```\n")));
    }

    #[test]
    fn parses_the_query_output() {
        let info = parse_query("\r\nC:\\Users\\a\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1\r\nRemoteSigned\r\n").unwrap();
        assert_eq!(
            info.profile,
            PathBuf::from(r"C:\Users\a\Documents\PowerShell\Microsoft.PowerShell_profile.ps1")
        );
        assert_eq!(info.policy, "RemoteSigned");
        assert!(parse_query("C:\\x.ps1\n").is_none());
    }

    #[test]
    fn warns_only_for_policies_that_block_the_profile() {
        assert!(
            policy_warning("Restricted")
                .unwrap()
                .contains("Set-ExecutionPolicy")
        );
        assert!(policy_warning("AllSigned").is_some());
        for ok in ["RemoteSigned", "Unrestricted", "Bypass"] {
            assert_eq!(policy_warning(ok), None);
        }
    }

    #[test]
    fn statuses() {
        let f = &POWERSHELL_FLAVOR;
        assert_eq!(status(f, Some("Import-Module posh-git\n")), Status::Missing);
        assert_eq!(status(f, Some(&block(f))), Status::Installed);
        assert_eq!(
            status(f, Some(&format!("x\n{FIRST_SNIPPET}"))),
            Status::HandAdded
        );
        assert_eq!(status(f, Some(&format!("x\n{SNIPPET}"))), Status::HandAdded);
        let custom = SNIPPET.replace("$exit = ", "$e = ");
        assert_eq!(status(f, Some(&custom)), Status::Custom);
    }

    #[test]
    fn install_creates_a_missing_profile_and_its_folder() {
        let dir = temp_dir("ps-fresh");
        let path = dir
            .join("PowerShell")
            .join("Microsoft.PowerShell_profile.ps1");
        let p = preview_at(PWSH, &path, "RemoteSigned").unwrap();
        assert_eq!(
            (p.status, p.creates_file, p.warning),
            (Status::Missing, true, None)
        );
        install_at(&path).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            block(&POWERSHELL_FLAVOR)
        );
        assert!(!backup_path(&path).exists());
        assert_eq!(
            preview_at(PWSH, &path, "Restricted").unwrap().status,
            Status::Installed
        );
    }

    #[test]
    fn install_replaces_the_first_snippet_and_keeps_utf16_and_bom() {
        let dir = temp_dir("ps-utf16");
        let path = dir.join("profile.ps1");
        let before = format!(
            "oh-my-posh init pwsh | Invoke-Expression\r\n{}",
            FIRST_SNIPPET.replace('\n', "\r\n")
        );
        std::fs::write(&path, encode(&before, Encoding::Utf16Le)).unwrap();
        install_at(&path).unwrap();
        let (text, enc) = decode(&path, &std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(enc, Encoding::Utf16Le);
        assert_eq!(
            text,
            format!(
                "oh-my-posh init pwsh | Invoke-Expression\r\n{}",
                block(&POWERSHELL_FLAVOR).replace('\n', "\r\n")
            )
        );
        assert_eq!(
            std::fs::read(backup_path(&path)).unwrap(),
            encode(&before, Encoding::Utf16Le)
        );

        let path = dir.join("bom.ps1");
        std::fs::write(&path, [UTF8_BOM, b"Set-Alias g git\n"].concat()).unwrap();
        install_at(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(UTF8_BOM));
        assert_eq!(decode(&path, &bytes).unwrap().1, Encoding::Utf8Bom);
    }

    #[test]
    fn custom_or_undecodable_profile_errors_and_writes_nothing() {
        let dir = temp_dir("ps-custom");
        let path = dir.join("profile.ps1");
        std::fs::write(&path, "$Global:__BashboardOriginalPrompt = 1\n").unwrap();
        assert!(install_at(&path).unwrap_err().contains("by hand"));
        assert!(!backup_path(&path).exists());

        std::fs::write(&path, b"x=\xff\n").unwrap();
        assert!(
            preview_at(PWSH, &path, "RemoteSigned")
                .unwrap_err()
                .contains("by hand")
        );
    }
}
