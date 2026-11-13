//! Finding the first real error in a CI job log and cutting an excerpt around it
//! (docs/design/ship.md section 3.23). Pure: no host, no DOM.
//!
//! Line indexes are into the raw log text split on `\n`, the same lines `cleanLog` in
//! `src/shipModel.ts` yields, so cleaning never adds or removes a line.

/// How many lines of context an excerpt keeps above the first diagnostic line.
const LEAD_LINES: usize = 5;

/// Removes CSI sequences (colors, cursor moves) and OSC sequences. An OSC left open at a
/// newline ends there, so the line count never changes.
pub fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                // Parameter and intermediate bytes, then one final byte in @..~.
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    chars.next();
                    if ('@'..='~').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    chars.next();
                    if n == '\x07' {
                        break;
                    }
                    if n == '\x1b' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A leading `2024-05-01T12:00:00.1234567Z ` host timestamp, as `LOG_TIMESTAMP` in
/// `src/shipModel.ts` matches it.
fn strip_timestamp(line: &str) -> &str {
    let b = line.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|s| s.iter().all(u8::is_ascii_digit));
    let shape = digits(0..4)
        && b.get(4) == Some(&b'-')
        && digits(5..7)
        && b.get(7) == Some(&b'-')
        && digits(8..10)
        && b.get(10) == Some(&b'T')
        && digits(11..13)
        && b.get(13) == Some(&b':')
        && digits(14..16)
        && b.get(16) == Some(&b':')
        && digits(17..19);
    if !shape {
        return line;
    }
    let mut i = 19;
    if b.get(i) == Some(&b'.') && b.get(i + 1).is_some_and(u8::is_ascii_digit) {
        i += 1;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
    }
    if b.get(i) != Some(&b'Z') {
        return line;
    }
    i += 1;
    if b.get(i) == Some(&b' ') {
        i += 1;
    }
    &line[i..]
}

/// The log as plain lines, one per raw `\n`-separated line.
fn clean_lines(text: &str) -> Vec<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    strip_ansi(text)
        .split('\n')
        .map(|line| {
            let line = line.strip_suffix('\r').unwrap_or(line);
            // GitLab redraws a line after a bare CR (its section markers); keep what shows.
            let line = line.rsplit('\r').next().unwrap_or(line);
            strip_timestamp(line).to_string()
        })
        .collect()
}

/// Wrapper lines that report a failure without saying what failed.
fn is_generic(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("exit code") || lower.contains("exited with code")
}

/// The host's own closing line for a failed step (`##[error]Process completed with exit code 1.`,
/// GitLab's `ERROR: Job failed: exit code 1`). What follows it is post-job cleanup.
fn is_failure_marker(line: &str) -> bool {
    let t = line.trim_start();
    is_generic(t) && (t.contains("##[error]") || t.starts_with("ERROR: Job failed"))
}

/// A cargo-style status label right-aligned to 12 columns (`       Error failed to bundle`),
/// as cargo and the Tauri CLI print a failure.
fn is_error_label(line: &str) -> bool {
    line.strip_prefix("       Error ").is_some_and(|rest| !rest.trim().is_empty())
}

/// A whitespace-separated token like `TypeError:` or `java.io.IOException:`.
fn has_error_token(line: &str) -> bool {
    line.split_whitespace().any(|tok| {
        let tok = tok.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
        ["Error:", "Exception:"].iter().any(|suffix| {
            tok.strip_suffix(suffix).is_some_and(|word| {
                !word.is_empty()
                    && word
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '$'))
            })
        })
    })
}

fn has_word(line: &str, word: &str) -> bool {
    line.match_indices(word).any(|(i, _)| {
        let before = line[..i].chars().next_back();
        let after = line[i + word.len()..].chars().next();
        !before.is_some_and(|c| c.is_ascii_alphanumeric())
            && !after.is_some_and(|c| c.is_ascii_alphanumeric())
    })
}

fn is_diagnostic(line: &str) -> bool {
    let t = line.trim_start();
    if t.is_empty() || is_generic(t) {
        return false;
    }
    t.contains("##[error]")
        || t.starts_with("::error")
        || t.starts_with("error:")
        || t.starts_with("error[")
        || t.starts_with("Error:")
        || is_error_label(line)
        || has_error_token(t)
        || t.contains("panic:")
        || has_word(t, "FAILED")
        || has_word(t, "ENOENT")
        || t.contains("Traceback (most recent call last)")
        || t.contains("npm ERR!")
}

/// The 0-based index of the first line that names an error, skipping generic exit-code lines.
pub fn first_error_line(text: &str) -> Option<usize> {
    clean_lines(text).iter().position(|l| is_diagnostic(l))
}

/// At most `max_lines` cleaned lines: from a few lines above the first diagnostic line when
/// there is one, otherwise the last lines, and in both cases ending at the host's closing
/// failure line when there is one, so post-job cleanup stays out.
pub fn excerpt(text: &str, max_lines: usize) -> String {
    let mut lines = clean_lines(text);
    if let Some(marker) = lines.iter().rposition(|l| is_failure_marker(l)) {
        lines.truncate(marker + 1);
    }
    while lines.last().is_some_and(|l| l.trim().is_empty()) {
        lines.pop();
    }
    let start = match lines.iter().position(|l| is_diagnostic(l)) {
        Some(i) => i.saturating_sub(LEAD_LINES),
        None => lines.len().saturating_sub(max_lines),
    };
    let end = (start + max_lines).min(lines.len());
    lines[start..end].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_removes_csi_and_osc_and_keeps_lines() {
        let raw = "\x1b[31mred\x1b[0m\n\x1b]0;title\x07plain\n\x1b]8;;http://x\x1b\\link\nopen\x1b]0;never closed\nnext";
        let out = strip_ansi(raw);
        assert_eq!(out, "red\nplain\nlink\nopen\nnext");
        assert_eq!(out.split('\n').count(), raw.split('\n').count());
    }

    #[test]
    fn timestamps_strip_like_the_front_end() {
        assert_eq!(
            strip_timestamp("2024-05-01T12:00:00.1234567Z hello"),
            "hello"
        );
        assert_eq!(strip_timestamp("2024-05-01T12:00:00Z hello"), "hello");
        assert_eq!(strip_timestamp("2024-05-01T12:00:00Zhello"), "hello");
        assert_eq!(
            strip_timestamp("2024-05-01 12:00:00 hello"),
            "2024-05-01 12:00:00 hello"
        );
        assert_eq!(strip_timestamp("2024"), "2024");
    }

    #[test]
    fn github_log_skips_the_exit_code_line() {
        let log = "\u{feff}2024-05-01T12:00:00.0000000Z ##[group]Run pnpm test\n\
                   2024-05-01T12:00:01.0000000Z > vitest run\n\
                   2024-05-01T12:00:02.0000000Z \x1b[31mTypeError: x is not a function\x1b[0m\n\
                   2024-05-01T12:00:02.1000000Z     at foo (src/a.ts:3:1)\n\
                   2024-05-01T12:00:03.0000000Z ##[error]Process completed with exit code 1.\n";
        assert_eq!(first_error_line(log), Some(2));
    }

    #[test]
    fn github_error_annotation_counts() {
        let log = "2024-05-01T12:00:00Z ok\n2024-05-01T12:00:00Z ::error file=a.rs,line=3::mismatched types\n";
        assert_eq!(first_error_line(log), Some(1));
    }

    #[test]
    fn gitlab_log_with_section_markers() {
        let log = "\x1b[0Ksection_start:1700000000:step_script\r\x1b[0K\x1b[0K\x1b[36;1mExecuting step\x1b[0;m\n\
                   $ cargo test\n\
                   test forge::tests::works ... FAILED\n\
                   \x1b[31;1mERROR: Job failed: exit code 101\n";
        assert_eq!(first_error_line(log), Some(2));
    }

    #[test]
    fn bitbucket_log_finds_npm_err() {
        let log =
            "+ npm ci\r\nnpm WARN deprecated foo\r\nnpm ERR! code ENOENT\r\nnpm ERR! path /x\r\n";
        assert_eq!(first_error_line(log), Some(2));
    }

    #[test]
    fn azure_devops_log_finds_the_error_above_the_generic_one() {
        let log = "2024-05-01T12:00:00.0000000Z Starting: Build\n\
                   2024-05-01T12:00:01.0000000Z error: could not compile `app`\n\
                   2024-05-01T12:00:02.0000000Z ##[error]Bash exited with code '1'.\n\
                   2024-05-01T12:00:03.0000000Z ##[error]Process completed with exit code 1.\n";
        assert_eq!(first_error_line(log), Some(1));
    }

    #[test]
    fn generic_lines_alone_find_nothing() {
        let log = "building\nError: Process completed with exit code 1.\nexit code 1\n";
        assert_eq!(first_error_line(log), None);
    }

    #[test]
    fn other_patterns_match() {
        for line in [
            "panic: runtime error: index out of range",
            "Traceback (most recent call last):",
            "  java.lang.NullPointerException: boom",
            "Error: Cannot find module 'x'",
            "ENOENT: no such file",
        ] {
            assert_eq!(first_error_line(&format!("ok\n{line}")), Some(1), "{line}");
        }
        for line in ["errors: 0", "std::error_code", "UNFAILED", "Error:"] {
            assert_eq!(
                first_error_line(line),
                if line == "Error:" { Some(0) } else { None },
                "{line}"
            );
        }
    }

    #[test]
    fn excerpt_starts_above_the_error_and_caps_length() {
        let mut lines: Vec<String> = (0..300).map(|i| format!("line {i}")).collect();
        lines[100] = "error: boom".into();
        let text = lines.join("\n");
        let ex = excerpt(&text, 150);
        let got: Vec<&str> = ex.split('\n').collect();
        assert_eq!(got.len(), 150);
        assert_eq!(got[0], "line 95");
        assert_eq!(got[5], "error: boom");
    }

    #[test]
    fn cargo_and_tauri_errors_count() {
        let log = "\x1b[1m\x1b[91merror[E0425]\x1b[0m: cannot find value `x`\n";
        assert_eq!(first_error_line(&format!("ok\n{log}")), Some(1));
        let tauri = "warning: function `f` is never used\n\
                     \x20      Built application at: /tmp/app\n\
                     failed to bundle project: no bb\n\
                     \x20      Error failed to bundle project: no bb\n\
                     ##[error]Process completed with exit code 1.\n";
        assert_eq!(first_error_line(tauri), Some(3));
        assert_eq!(first_error_line("Error handling is described below"), None);
        assert_eq!(first_error_line("       Error "), None);
    }

    #[test]
    fn excerpt_ends_at_the_closing_failure_line() {
        let mut lines: Vec<String> = (0..300).map(|i| format!("warning {i}")).collect();
        lines.push("       Error failed to bundle project".into());
        lines.push("##[error]Process completed with exit code 1.".into());
        lines.extend((0..40).map(|i| format!("Post job cleanup {i}")));
        let ex = excerpt(&lines.join("\n"), 150);
        let got: Vec<&str> = ex.split('\n').collect();
        assert_eq!(got.first(), Some(&"warning 295"));
        assert_eq!(got.last(), Some(&"##[error]Process completed with exit code 1."));

        // With no diagnostic line, the tail still stops at the closing line.
        let mut plain: Vec<String> = (0..300).map(|i| format!("line {i}")).collect();
        plain.push("##[error]Process completed with exit code 1.".into());
        plain.push("Cleaning up orphan processes".into());
        let ex = excerpt(&plain.join("\n"), 150);
        let got: Vec<&str> = ex.split('\n').collect();
        assert_eq!(got.len(), 150);
        assert_eq!(got.last(), Some(&"##[error]Process completed with exit code 1."));
    }

    #[test]
    fn excerpt_without_an_error_takes_the_tail() {
        let text: String = (0..200).map(|i| format!("line {i}\n")).collect();
        let ex = excerpt(&text, 150);
        let got: Vec<&str> = ex.split('\n').collect();
        assert_eq!(got.len(), 150);
        assert_eq!(got[0], "line 50");
        assert_eq!(got[149], "line 199");
        assert_eq!(excerpt("", 150), "");
        assert_eq!(excerpt("error: near top\nb", 150), "error: near top\nb");
    }
}
