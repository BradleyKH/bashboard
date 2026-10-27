//! Code search over a repo (design section 3.11), built on ripgrep's `ignore`, `grep-regex`,
//! and `grep-searcher` crates.
//!
//! A search sends one `names` batch first, then one `file` batch per file with line matches,
//! then `done`. A cancelled search sends nothing more, `done` included. Paths are relative to
//! the root with forward slashes, and match ranges are UTF-16 offsets into the line text.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread,
};

use grep_matcher::{LineTerminator, Matcher};
use grep_regex::{RegexMatcher, RegexMatcherBuilder};
use grep_searcher::{BinaryDetection, Searcher, SearcherBuilder, Sink, SinkMatch};
use ignore::{
    WalkBuilder,
    overrides::{Override, OverrideBuilder},
};
use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

/// The same 2 MiB as the Files pane's read limit.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Counted in matching lines, not in ranges within a line.
const MAX_MATCHES: usize = 5_000;
/// Keeps a minified file's megabyte lines off the channel.
const MAX_LINE_UNITS: usize = 1_000;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub regex: bool,
    pub include: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    /// 1-based.
    pub line: u64,
    pub text: String,
    /// `[start, end)` in UTF-16 code units of `text`.
    pub ranges: Vec<[u32; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchBatch {
    Names {
        paths: Vec<String>,
    },
    File {
        path: String,
        matches: Vec<LineMatch>,
    },
    Done {
        files: u32,
        matches: u32,
        truncated: bool,
    },
}

/// A validated search, ready to run off the calling thread.
pub struct Search {
    root: PathBuf,
    matcher: RegexMatcher,
    include: Option<Override>,
}

impl Search {
    /// Builds the matcher and the include filter, so a bad query or glob fails before any walk.
    pub fn new(root: &Path, query: &str, opts: &SearchOptions) -> Result<Search, String> {
        Ok(Search {
            root: root.to_path_buf(),
            matcher: build_matcher(query, opts)?,
            include: build_include(root, &opts.include)?,
        })
    }

    /// Runs the search, calling `emit` per batch. `emit` returning false, or `cancel` being
    /// set, ends the search without sending anything more.
    pub fn run(&self, cancel: &AtomicBool, emit: &mut dyn FnMut(SearchBatch) -> bool) {
        let Some(files) = self.walk(cancel, &mut || {}) else {
            return;
        };
        let names = files
            .iter()
            .filter(|(_, rel)| {
                let name = rel.rsplit('/').next().unwrap_or(rel);
                self.matcher.is_match(name.as_bytes()).unwrap_or(false)
            })
            .map(|(_, rel)| rel.clone())
            .collect();
        if !emit(SearchBatch::Names { paths: names }) {
            return;
        }

        let mut searcher = SearcherBuilder::new()
            .line_terminator(LineTerminator::crlf())
            .line_number(true)
            .binary_detection(BinaryDetection::quit(b'\x00'))
            .build();
        let (mut file_count, mut total, mut truncated) = (0u32, 0usize, false);
        for (path, rel) in &files {
            if cancel.load(Ordering::Relaxed) {
                return;
            }
            let remaining = MAX_MATCHES - total;
            let mut sink = Collect {
                matcher: &self.matcher,
                cancel,
                // One past the remaining room tells "exactly full" from "more to come".
                limit: remaining + 1,
                matches: Vec::new(),
                binary: false,
                cancelled: false,
            };
            if searcher
                .search_path(&self.matcher, path, &mut sink)
                .is_err()
            {
                continue;
            }
            if sink.cancelled || cancel.load(Ordering::Relaxed) {
                return;
            }
            if sink.binary {
                continue;
            }
            let mut matches = sink.matches;
            if matches.len() > remaining {
                matches.truncate(remaining);
                truncated = true;
            }
            if !matches.is_empty() {
                total += matches.len();
                file_count += 1;
                if !emit(SearchBatch::File {
                    path: rel.clone(),
                    matches,
                }) {
                    return;
                }
            }
            if truncated {
                break;
            }
        }
        emit(SearchBatch::Done {
            files: file_count,
            matches: total as u32,
            truncated,
        });
    }

    /// Every searchable file in walk order, as (absolute path, relative path with `/`). The
    /// names batch has to lead, so the whole walk precedes any output; `cancel` is checked per
    /// entry so a huge tree does not delay a cancel. Returns `None` when cancelled. `on_entry`
    /// lets tests observe the walk.
    fn walk(
        &self,
        cancel: &AtomicBool,
        on_entry: &mut dyn FnMut(),
    ) -> Option<Vec<(PathBuf, String)>> {
        let mut builder = WalkBuilder::new(&self.root);
        builder
            .hidden(true)
            .ignore(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            // A folder in no repo (section 3.8) still honors its .gitignore.
            .require_git(false)
            .max_filesize(Some(MAX_FILE_BYTES))
            .sort_by_file_name(|a, b| a.cmp(b));
        let mut files = Vec::new();
        for entry in builder.build().flatten() {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            on_entry();
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&self.root) else {
                continue;
            };
            let rel = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            // After the walk's ignore rules, so an include glob never pulls in ignored or hidden
            // files.
            if let Some(include) = &self.include {
                if include.matched(Path::new(&rel), false).is_ignore() {
                    continue;
                }
            }
            files.push((entry.into_path(), rel));
        }
        Some(files)
    }
}

fn build_matcher(query: &str, opts: &SearchOptions) -> Result<RegexMatcher, String> {
    if query.is_empty() {
        return Err("Enter a search term".into());
    }
    RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .word(opts.whole_word)
        .fixed_strings(!opts.regex)
        .crlf(true)
        .build(query)
        .map_err(|e| {
            // The regex crate's message is a multi-line caret diagram; its last `error:` line
            // is the part that reads well inline.
            let text = e.to_string();
            let reason = text
                .lines()
                .rev()
                .find_map(|l| l.trim().strip_prefix("error: "))
                .unwrap_or(text.trim());
            format!("Invalid regex: {reason}")
        })
}

/// Comma-separated globs, matched like .gitignore lines (a glob with no slash matches at any
/// depth); `None` when there are none.
fn build_include(root: &Path, include: &str) -> Result<Option<Override>, String> {
    let globs: Vec<&str> = include
        .split(',')
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .collect();
    if globs.is_empty() {
        return Ok(None);
    }
    let mut builder = OverrideBuilder::new(root);
    for glob in globs {
        builder
            .add(glob)
            .map_err(|e| format!("Invalid include glob: {e}"))?;
    }
    builder
        .build()
        .map(Some)
        .map_err(|e| format!("Invalid include glob: {e}"))
}

struct Collect<'a> {
    matcher: &'a RegexMatcher,
    cancel: &'a AtomicBool,
    limit: usize,
    matches: Vec<LineMatch>,
    binary: bool,
    cancelled: bool,
}

impl Sink for Collect<'_> {
    type Error = io::Error;

    fn matched(&mut self, _: &Searcher, mat: &SinkMatch<'_>) -> Result<bool, io::Error> {
        if self.cancel.load(Ordering::Relaxed) {
            self.cancelled = true;
            return Ok(false);
        }
        let first = mat.line_number().unwrap_or(1);
        for (i, line) in mat.lines().enumerate() {
            self.matches
                .push(line_match(self.matcher, first + i as u64, line));
            if self.matches.len() >= self.limit {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn binary_data(&mut self, _: &Searcher, _: u64) -> Result<bool, io::Error> {
        self.binary = true;
        Ok(false)
    }
}

fn line_match(matcher: &RegexMatcher, line: u64, bytes: &[u8]) -> LineMatch {
    let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    let mut byte_ranges = Vec::new();
    let _ = matcher.find_iter(bytes, |m| {
        if m.end() > m.start() {
            byte_ranges.push((m.start(), m.end()));
        }
        true
    });
    let (mut text, units) = decode_utf16_offsets(bytes);
    let mut cut = units[bytes.len()];
    if cut as usize > MAX_LINE_UNITS {
        // Cut on a char boundary, so a surrogate pair is never split.
        let (mut sum, mut end) = (0usize, 0usize);
        for (i, c) in text.char_indices() {
            if sum + c.len_utf16() > MAX_LINE_UNITS {
                break;
            }
            sum += c.len_utf16();
            end = i + c.len_utf8();
        }
        text.truncate(end);
        cut = sum as u32;
    }
    let ranges = byte_ranges
        .into_iter()
        .map(|(s, e)| [units[s], units[e].min(cut)])
        .filter(|[s, e]| *s < cut && e > s)
        .collect();
    LineMatch { line, text, ranges }
}

/// Decodes `bytes` lossily, as `String::from_utf8_lossy` does, and returns for each byte
/// offset (and the end) the UTF-16 offset it maps to. A byte inside a multi-byte character or
/// an invalid sequence maps to the start of that character.
fn decode_utf16_offsets(bytes: &[u8]) -> (String, Vec<u32>) {
    let mut text = String::with_capacity(bytes.len());
    let mut units = Vec::with_capacity(bytes.len() + 1);
    let mut unit = 0u32;
    for chunk in bytes.utf8_chunks() {
        for c in chunk.valid().chars() {
            units.extend(std::iter::repeat_n(unit, c.len_utf8()));
            unit += c.len_utf16() as u32;
            text.push(c);
        }
        if !chunk.invalid().is_empty() {
            units.extend(std::iter::repeat_n(unit, chunk.invalid().len()));
            unit += 1;
            text.push('\u{fffd}');
        }
    }
    units.push(unit);
    (text, units)
}

#[derive(Default)]
pub struct SearchState {
    next_id: AtomicU32,
    running: Arc<Mutex<HashMap<u32, Arc<AtomicBool>>>>,
}

#[tauri::command]
pub fn search_start(
    state: State<'_, SearchState>,
    root: String,
    query: String,
    options: SearchOptions,
    on_batch: Channel<SearchBatch>,
) -> Result<u32, String> {
    let root = crate::files::normalize(&root)?;
    if !root.is_dir() {
        return Err(format!("not a folder: {}", root.display()));
    }
    let search = Search::new(&root, &query, &options)?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    state.running.lock().unwrap().insert(id, cancel.clone());
    let running = state.running.clone();
    thread::spawn(move || {
        // A failed send means the page went away, which ends the search like a cancel.
        search.run(&cancel, &mut |batch| on_batch.send(batch).is_ok());
        running.lock().unwrap().remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub fn search_cancel(state: State<'_, SearchState>, id: u32) -> Result<(), String> {
    if let Some(flag) = state.running.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-search-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, content: impl AsRef<[u8]>) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn opts() -> SearchOptions {
        SearchOptions::default()
    }

    fn run(dir: &Path, query: &str, opts: &SearchOptions) -> Vec<SearchBatch> {
        let search = Search::new(dir, query, opts).unwrap();
        let mut out = Vec::new();
        search.run(&AtomicBool::new(false), &mut |b| {
            out.push(b);
            true
        });
        out
    }

    fn names(batches: &[SearchBatch]) -> Vec<String> {
        match &batches[0] {
            SearchBatch::Names { paths } => paths.clone(),
            other => panic!("first batch is not names: {other:?}"),
        }
    }

    fn file_paths(batches: &[SearchBatch]) -> Vec<String> {
        batches
            .iter()
            .filter_map(|b| match b {
                SearchBatch::File { path, .. } => Some(path.clone()),
                _ => None,
            })
            .collect()
    }

    fn file<'a>(batches: &'a [SearchBatch], rel: &str) -> &'a [LineMatch] {
        batches
            .iter()
            .find_map(|b| match b {
                SearchBatch::File { path, matches } if path == rel => Some(matches.as_slice()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no file batch for {rel}"))
    }

    fn done(batches: &[SearchBatch]) -> (u32, u32, bool) {
        match batches.last().unwrap() {
            SearchBatch::Done {
                files,
                matches,
                truncated,
            } => (*files, *matches, *truncated),
            other => panic!("last batch is not done: {other:?}"),
        }
    }

    #[test]
    fn honors_gitignore_without_a_git_folder() {
        let dir = temp_dir("gitignore");
        write(&dir, ".gitignore", "build/\n*.log\n");
        write(&dir, "src/a.txt", "needle\n");
        write(&dir, "build/out.txt", "needle\n");
        write(&dir, "debug.log", "needle\n");
        let batches = run(&dir, "needle", &opts());
        assert_eq!(file_paths(&batches), vec!["src/a.txt"]);
        assert_eq!(done(&batches), (1, 1, false));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_hidden_files_and_folders() {
        let dir = temp_dir("hidden");
        write(&dir, ".secret", "needle\n");
        write(&dir, ".git/config", "needle\n");
        write(&dir, ".cache/x.txt", "needle\n");
        write(&dir, "shown.txt", "needle\n");
        assert_eq!(file_paths(&run(&dir, "needle", &opts())), vec!["shown.txt"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn skips_large_and_binary_files() {
        let dir = temp_dir("skip");
        let mut big = b"needle\n".to_vec();
        big.resize(MAX_FILE_BYTES as usize + 1, b'x');
        write(&dir, "big.txt", big);
        write(&dir, "bin.dat", b"needle\n\0more\n");
        write(&dir, "ok.txt", "needle\n");
        let batches = run(&dir, "needle", &opts());
        assert_eq!(file_paths(&batches), vec!["ok.txt"]);
        assert_eq!(done(&batches), (1, 1, false));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn literal_query_keeps_regex_metacharacters() {
        let dir = temp_dir("literal");
        write(&dir, "a.txt", "call foo(a.b)\nfooXaYb\n");
        let batches = run(&dir, "foo(a.b)", &opts());
        let m = file(&batches, "a.txt");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line, 1);
        assert_eq!(m[0].ranges, vec![[5, 13]]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn case_sensitivity_follows_the_option() {
        let dir = temp_dir("case");
        write(&dir, "a.txt", "Needle\nneedle\n");
        assert_eq!(file(&run(&dir, "needle", &opts()), "a.txt").len(), 2);
        let cs = SearchOptions {
            case_sensitive: true,
            ..opts()
        };
        let lines: Vec<u64> = file(&run(&dir, "needle", &cs), "a.txt")
            .iter()
            .map(|m| m.line)
            .collect();
        assert_eq!(lines, vec![2]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn whole_word_skips_partial_words() {
        let dir = temp_dir("word");
        write(&dir, "a.txt", "needles\na needle here\n");
        let ww = SearchOptions {
            whole_word: true,
            ..opts()
        };
        let batches = run(&dir, "needle", &ww);
        let m = file(&batches, "a.txt");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line, 2);
        assert_eq!(m[0].ranges, vec![[2, 8]]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn regex_option_and_invalid_regex() {
        let dir = temp_dir("regex");
        write(&dir, "a.txt", "id 42 and 7\nnone\n");
        let re = SearchOptions {
            regex: true,
            ..opts()
        };
        let batches = run(&dir, r"\d+", &re);
        assert_eq!(file(&batches, "a.txt")[0].ranges, vec![[3, 5], [10, 11]]);
        let err = Search::new(&dir, "(unclosed", &re).err().unwrap();
        assert!(err.starts_with("Invalid regex:"), "{err}");
        assert!(!err.contains('\n'), "{err}");
        assert!(Search::new(&dir, "(unclosed", &opts()).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_query_and_bad_glob_are_errors() {
        let dir = temp_dir("errors");
        assert!(Search::new(&dir, "", &opts()).is_err());
        let bad = SearchOptions {
            include: "src/[".into(),
            ..opts()
        };
        assert!(
            Search::new(&dir, "x", &bad)
                .err()
                .unwrap()
                .starts_with("Invalid include glob:")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn include_globs_narrow_the_walk() {
        let dir = temp_dir("include");
        write(&dir, "top.ts", "needle\n");
        write(&dir, "src/deep/nested.ts", "needle\n");
        write(&dir, "src/readme.md", "needle\n");
        write(&dir, "other.md", "needle\n");
        let ts = SearchOptions {
            include: "*.ts".into(),
            ..opts()
        };
        assert_eq!(
            file_paths(&run(&dir, "needle", &ts)),
            vec!["src/deep/nested.ts", "top.ts"]
        );
        let two = SearchOptions {
            include: " *.ts , src/** ,".into(),
            ..opts()
        };
        assert_eq!(
            file_paths(&run(&dir, "needle", &two)),
            vec!["src/deep/nested.ts", "src/readme.md", "top.ts"]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn include_glob_does_not_override_gitignore() {
        let dir = temp_dir("include-ignored");
        write(&dir, ".gitignore", "gen.ts\n");
        write(&dir, "gen.ts", "needle\n");
        write(&dir, "keep.ts", "needle\n");
        let ts = SearchOptions {
            include: "*.ts".into(),
            ..opts()
        };
        assert_eq!(file_paths(&run(&dir, "needle", &ts)), vec!["keep.ts"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_batch_comes_first_with_file_name_hits_only() {
        let dir = temp_dir("names");
        write(&dir, "needle/inside.txt", "nothing\n");
        write(&dir, "src/needle.rs", "nothing\n");
        write(&dir, "src/other.rs", "a needle\n");
        let batches = run(&dir, "needle", &opts());
        assert_eq!(names(&batches), vec!["src/needle.rs"]);
        assert_eq!(file_paths(&batches), vec!["src/other.rs"]);
        assert_eq!(batches.len(), 3);
        let none = run(&dir, "absent", &opts());
        assert_eq!(
            none,
            vec![
                SearchBatch::Names { paths: vec![] },
                SearchBatch::Done {
                    files: 0,
                    matches: 0,
                    truncated: false
                },
            ]
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn line_numbers_and_utf16_ranges() {
        let dir = temp_dir("utf16");
        // "é" is 2 bytes and 1 UTF-16 unit; "😀" is 4 bytes and 2 units.
        write(&dir, "a.txt", "first\ncafé needle 😀 needle\n");
        let batches = run(&dir, "needle", &opts());
        let m = file(&batches, "a.txt");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line, 2);
        assert_eq!(m[0].text, "café needle 😀 needle");
        assert_eq!(m[0].ranges, vec![[5, 11], [15, 21]]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn crlf_line_endings_are_stripped() {
        let dir = temp_dir("crlf");
        write(&dir, "a.txt", "one\r\ntwo needle\r\nthree\r\n");
        let re = SearchOptions {
            regex: true,
            ..opts()
        };
        let batches = run(&dir, "needle$", &re);
        let m = file(&batches, "a.txt");
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].line, 2);
        assert_eq!(m[0].text, "two needle");
        assert_eq!(m[0].ranges, vec![[4, 10]]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_lines_are_truncated_and_ranges_clipped() {
        let dir = temp_dir("long");
        let line = format!("{}needle{}needle\n", "x".repeat(997), "y".repeat(100));
        write(&dir, "a.txt", line);
        let batches = run(&dir, "needle", &opts());
        let m = &file(&batches, "a.txt")[0];
        assert_eq!(m.text.encode_utf16().count(), MAX_LINE_UNITS);
        assert_eq!(m.ranges, vec![[997, 1000]]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stops_at_the_match_cap() {
        let dir = temp_dir("cap");
        let body = "needle\n".repeat(3_000);
        write(&dir, "a.txt", &body);
        write(&dir, "b.txt", &body);
        write(&dir, "c.txt", &body);
        let batches = run(&dir, "needle", &opts());
        assert_eq!(file_paths(&batches), vec!["a.txt", "b.txt"]);
        assert_eq!(file(&batches, "a.txt").len(), 3_000);
        assert_eq!(file(&batches, "b.txt").len(), 2_000);
        assert_eq!(done(&batches), (2, 5_000, true));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn exactly_the_cap_is_not_truncated() {
        let dir = temp_dir("cap-exact");
        write(&dir, "a.txt", "needle\n".repeat(MAX_MATCHES));
        assert_eq!(done(&run(&dir, "needle", &opts())), (1, 5_000, false));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_sends_nothing_more() {
        let dir = temp_dir("cancel");
        write(&dir, "a.txt", "needle\n");
        write(&dir, "b.txt", "needle\n");
        let search = Search::new(&dir, "needle", &opts()).unwrap();
        let cancel = AtomicBool::new(false);
        let mut out = Vec::new();
        search.run(&cancel, &mut |b| {
            out.push(b);
            cancel.store(true, Ordering::Relaxed);
            true
        });
        assert_eq!(out, vec![SearchBatch::Names { paths: vec![] }]);

        let mut sent = 0;
        search.run(&AtomicBool::new(false), &mut |_| {
            sent += 1;
            sent < 2
        });
        assert_eq!(sent, 2, "a failed send ends the search");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cancelling_stops_the_walk_at_once() {
        let dir = temp_dir("cancel-walk");
        for i in 0..50 {
            write(&dir, &format!("f{i:02}.txt"), "needle\n");
        }
        let search = Search::new(&dir, "needle", &opts()).unwrap();

        let cancel = AtomicBool::new(false);
        let mut visited = 0;
        let files = search.walk(&cancel, &mut || {
            visited += 1;
            if visited == 3 {
                cancel.store(true, Ordering::Relaxed);
            }
        });
        assert!(files.is_none());
        assert_eq!(visited, 3, "no entry is visited after the cancel");

        let mut visited = 0;
        let files = search.walk(&AtomicBool::new(false), &mut || visited += 1);
        assert_eq!(files.unwrap().len(), 50);
        assert!(visited >= 50);

        let mut sent = 0;
        search.run(&AtomicBool::new(true), &mut |_| {
            sent += 1;
            true
        });
        assert_eq!(sent, 0, "a search cancelled before it starts sends nothing");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn batches_serialize_to_the_wire_shape() {
        let file = SearchBatch::File {
            path: "src/a.ts".into(),
            matches: vec![LineMatch {
                line: 3,
                text: "x".into(),
                ranges: vec![[0, 1]],
            }],
        };
        assert_eq!(
            serde_json::to_string(&file).unwrap(),
            r#"{"type":"file","path":"src/a.ts","matches":[{"line":3,"text":"x","ranges":[[0,1]]}]}"#
        );
        let done = SearchBatch::Done {
            files: 1,
            matches: 2,
            truncated: false,
        };
        assert_eq!(
            serde_json::to_string(&done).unwrap(),
            r#"{"type":"done","files":1,"matches":2,"truncated":false}"#
        );
        let names = SearchBatch::Names {
            paths: vec!["a".into()],
        };
        assert_eq!(
            serde_json::to_string(&names).unwrap(),
            r#"{"type":"names","paths":["a"]}"#
        );
        let opts: SearchOptions = serde_json::from_str(
            r#"{"caseSensitive":true,"wholeWord":false,"regex":true,"include":"*.ts"}"#,
        )
        .unwrap();
        assert!(opts.case_sensitive && opts.regex && !opts.whole_word && opts.include == "*.ts");
    }
}
