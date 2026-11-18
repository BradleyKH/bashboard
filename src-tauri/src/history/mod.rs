//! Past coding agent sessions for the Sessions dialog: one pure reader per agent that turns the
//! head and tail of a transcript into a `PastSession`, `repo::main_repo_root` to group them by
//! repository, and `index` to cache and watch them. The formats are internal to each tool and
//! undocumented, so every field is optional and an unparseable line is skipped, as in
//! `crate::transcript`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agents::AgentId;

pub mod claude;
pub mod codex;
pub mod copilot;
pub mod index;
pub mod repo;

/// One past or live session as the Sessions dialog lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastSession {
    pub agent: AgentId,
    pub session_id: String,
    /// From the transcript contents, never decoded from a folder name (Claude's project slugs are
    /// lossy).
    pub cwd: String,
    /// Left false by the readers; the index fills it, memoized per cwd, since it touches the disk.
    pub cwd_exists: bool,
    /// Left `None` by the readers; the index fills it from `main_repo_root`, memoized per cwd.
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    /// Never empty: falls back to the first prompt, then the session id.
    pub title: String,
    pub first_prompt: Option<String>,
    pub last_prompt: Option<String>,
    /// Milliseconds since the epoch.
    pub started_at: u64,
    /// Milliseconds since the epoch: the newest record's time, else the file's mtime.
    pub updated_at: u64,
    pub permission_mode: Option<String>,
    pub model: Option<String>,
}

/// The lines of a transcript's `head` and `tail` that can be whole, in file order. Callers pass
/// the first and last few KB of a file, or the same text twice for a small file. A cut can split
/// a line, so the head's unterminated last line and the tail's first line are dropped. The two
/// can overlap and repeat a line; readers keep only the first or last of anything, so a repeat
/// changes nothing.
pub(crate) fn complete_lines<'a>(head: &'a str, tail: &'a str) -> Vec<&'a str> {
    let whole = head == tail;
    let mut out: Vec<&str> = head.split('\n').collect();
    // split leaves "" after a final newline and the partial line otherwise; either way it goes.
    if !whole {
        out.pop();
        out.extend(tail.split('\n').skip(1));
    }
    out
}

/// The JSON objects among `complete_lines(head, tail)`; anything unparseable is skipped.
pub(crate) fn records(head: &str, tail: &str) -> Vec<Value> {
    complete_lines(head, tail)
        .into_iter()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .filter(Value::is_object)
        .collect()
}

/// A prompt for display: whitespace runs collapsed to one space (prompts are shown on one line),
/// trimmed, and cut to 200 characters. `None` when nothing is left.
pub(crate) fn clip_prompt(text: &str) -> Option<String> {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if joined.is_empty() {
        return None;
    }
    Some(joined.chars().take(200).collect())
}

/// A non-empty string field.
pub(crate) fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Milliseconds since the epoch for an RFC 3339 time such as `2026-11-17T22:44:32.924Z` or
/// `2026-11-17T17:44:32+05:00`. Hand-rolled to avoid a date dependency for one format.
pub(crate) fn iso_ms(s: &str) -> Option<u64> {
    let s = s.trim().trim_matches('"');
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> {
        let part = s.get(r)?;
        part.bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| part.parse().ok())?
    };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, se) = (num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let padded: String = frac[..digits]
            .chars()
            .chain("000".chars())
            .take(3)
            .collect();
        ms = padded.parse().ok()?;
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hm = rest[1..].replace(':', "");
            if hm.len() != 4 || !hm.bytes().all(|c| c.is_ascii_digit()) {
                return None;
            }
            sign * (hm[..2].parse::<i64>().ok()? * 60 + hm[2..].parse::<i64>().ok()?)
        }
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    u64::try_from(secs * 1000 + ms).ok()
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_times_parse() {
        assert_eq!(iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_ms("2026-11-17T22:44:32.924Z"), Some(1_794_955_472_924));
        assert_eq!(
            iso_ms("2026-11-17T23:44:32.9+01:00"),
            Some(1_794_955_472_900)
        );
        assert_eq!(
            iso_ms("2026-11-17T22:44:32.123456789Z"),
            Some(1_794_955_472_123)
        );
        assert_eq!(iso_ms("2000-02-29T00:00:00"), Some(951_782_400_000));
        assert_eq!(iso_ms("not a time"), None);
        assert_eq!(iso_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(iso_ms("2026-11-17T22:44:32Q"), None);
    }

    #[test]
    fn records_drop_cut_lines_and_read_small_files_whole() {
        let a = r#"{"n":1}"#;
        let b = r#"{"n":2}"#;
        let c = r#"{"n":3}"#;
        let whole = format!("{a}\n{b}\n{c}");
        let ns = |v: Vec<Value>| {
            v.iter()
                .map(|r| r["n"].as_i64().unwrap())
                .collect::<Vec<_>>()
        };
        assert_eq!(ns(records(&whole, &whole)), [1, 2, 3]);
        // The head ends mid-record and the tail starts mid-record.
        let head = format!("{a}\n{{\"n\":");
        let tail = format!("2}}\n{c}\n");
        assert_eq!(ns(records(&head, &tail)), [1, 3]);
        // A tail whose first line looks complete is still dropped, since the cut may sit inside
        // a longer record whose end happens to parse.
        assert_eq!(
            ns(records(&format!("{a}\n"), &format!("{b}\n{c}\n"))),
            [1, 3]
        );
        assert_eq!(ns(records("", "")), Vec::<i64>::new());
    }

    #[test]
    fn prompts_are_collapsed_and_clipped() {
        assert_eq!(
            clip_prompt("  fix\n\n the   bug "),
            Some("fix the bug".into())
        );
        assert_eq!(clip_prompt(" \n "), None);
        let long = "é".repeat(300);
        assert_eq!(clip_prompt(&long).unwrap().chars().count(), 200);
    }
}
