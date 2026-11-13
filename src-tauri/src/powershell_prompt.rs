//! The prompt wrapper PowerShell 7 and Windows PowerShell panes start with (docs/design/terminal.md
//! section 3.1): it reports the working directory (OSC 9;9) ahead of the user's own prompt, so new
//! panes open in the focused pane's folder. It is passed on the command line at each launch and
//! never written to the user's profile.

/// `[char]27` rather than the `` `e `` escape, which Windows PowerShell 5.1 does not know. It runs
/// after the profile, so it wraps whatever prompt the profile (or a framework like Starship) set.
/// The guard keeps it from wrapping a profile that already carries this wrapper, which would
/// recurse forever. The AWS context goes out at every prompt, matching the bash lines
/// (docs/setup.md), so the badge recovers when a nested shell exits.
const SNIPPET: &str = r#"if (-not (Test-Path variable:Global:__BashboardOriginalPrompt)) {
  $Global:__BashboardOriginalPrompt = $function:prompt
}
function Global:prompt {
  $exit = $global:LASTEXITCODE
  $loc = $executionContext.SessionState.Path.CurrentLocation
  $out = "$([char]27)]9;9;`"$loc`"$([char]7)" + (& $Global:__BashboardOriginalPrompt)
  $region = $env:AWS_REGION
  if (-not $region) { $region = $env:AWS_DEFAULT_REGION }
  $out = "$([char]27)]7502;aws;$($env:AWS_PROFILE);$region$([char]7)" + $out
  $global:LASTEXITCODE = $exit
  return $out
}"#;

/// Appended to the profile's own arguments. `-EncodedCommand` (base64 of UTF-16 LE) sidesteps
/// command-line quoting entirely; `-NoExit` keeps the shell interactive once it has run.
/// Execution policy governs script files, not `-EncodedCommand`, so this works even where the
/// policy keeps the profile itself from loading.
pub fn launch_args() -> [String; 3] {
    let utf16: Vec<u8> = SNIPPET.encode_utf16().flat_map(u16::to_le_bytes).collect();
    ["-NoExit".into(), "-EncodedCommand".into(), base64(&utf16)]
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(ALPHABET[(n >> (18 - 6 * i)) as usize & 63] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xFB, 0xFF]), "+/8=");
    }

    #[test]
    fn launch_args_encode_the_snippet_as_utf16() {
        let [no_exit, flag, encoded] = launch_args();
        assert_eq!((no_exit.as_str(), flag.as_str()), ("-NoExit", "-EncodedCommand"));
        // "if" in UTF-16 LE is 69 00 66 00.
        assert!(encoded.starts_with(&base64(&[0x69, 0, 0x66, 0])[..4]));
        assert!(SNIPPET.is_ascii());
    }

    /// Runs the wrapper in a real PowerShell when one is installed: the prompt must carry OSC 9;9
    /// with the current folder, and applying it twice must not wrap it twice.
    #[test]
    fn the_wrapper_reports_the_folder_once() {
        let exe = ["pwsh.exe", "powershell.exe"].into_iter().find(|exe| {
            std::process::Command::new(exe).args(["-NoProfile", "-Command", "exit 0"]).output().is_ok()
        });
        let Some(exe) = exe else { return };
        let script = format!(
            "Set-Location $env:SystemRoot; {SNIPPET}\n{SNIPPET}\n[Console]::Out.Write((prompt))"
        );
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let out = std::process::Command::new(exe)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &base64(&utf16)])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let root = std::env::var("SystemRoot").unwrap();
        assert_eq!(text.matches("\x1b]9;9;").count(), 1, "{text:?}");
        assert!(text.contains(&format!("\x1b]9;9;\"{root}\"\x07")), "{text:?}");
    }

    /// The AWS context is reported at every prompt.
    #[test]
    fn the_wrapper_reports_the_aws_context_at_every_prompt() {
        let exe = ["pwsh.exe", "powershell.exe"].into_iter().find(|exe| {
            std::process::Command::new(exe).args(["-NoProfile", "-Command", "exit 0"]).output().is_ok()
        });
        let Some(exe) = exe else { return };
        let script = format!(
            "$env:AWS_PROFILE = 'prod-admin'; $env:AWS_REGION = 'us-east-1'; {SNIPPET}\n\
             [Console]::Out.Write((prompt)); [Console]::Out.Write((prompt))\n\
             $env:AWS_PROFILE = 'dev'; $env:AWS_REGION = ''; $env:AWS_DEFAULT_REGION = 'eu-west-1'\n\
             [Console]::Out.Write((prompt)); [Console]::Out.Write((prompt))"
        );
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let out = std::process::Command::new(exe)
            .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", &base64(&utf16)])
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert_eq!(text.matches("\x1b]7502;aws;").count(), 4, "{text:?}");
        assert_eq!(text.matches("\x1b]7502;aws;prod-admin;us-east-1\x07").count(), 2, "{text:?}");
        assert_eq!(text.matches("\x1b]7502;aws;dev;eu-west-1\x07").count(), 2, "{text:?}");
    }
}
