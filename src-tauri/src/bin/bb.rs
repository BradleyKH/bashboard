//! `bb`, the pane CLI (docs/design/app.md section 3.13). It forwards its arguments to the app's
//! hook receiver as `POST /cli`; parsing and path resolution happen in the core.

use std::borrow::Cow;
use std::io::{self, IsTerminal, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::process::ExitCode;
use std::time::Duration;

// The reader and `exists` serve the app only.
#[allow(dead_code, unused_imports)]
#[path = "../credential_store.rs"]
mod credential_store;

// The version reader and binary name serve the app's installer only.
#[allow(dead_code)]
#[path = "../hook_client.rs"]
mod hook_client;

use credential_store::{AZURE_DEVOPS_USER, BITBUCKET_TARGET, BITBUCKET_USER, clean_token};

/// The command reference, shared with the app dialog's CLI tab.
const REFERENCE: &str = include_str!("../../cli-commands.json");

#[derive(serde::Deserialize)]
struct Reference {
    intro: String,
    commands: Vec<Entry>,
    options: Vec<Entry>,
}

#[derive(serde::Deserialize)]
struct Entry {
    usage: String,
    summary: String,
}

fn help_text() -> String {
    let r: Reference = serde_json::from_str(REFERENCE).expect("cli-commands.json is valid");
    // Pads to the longest usage, so a long one never runs into its summary.
    let width = r.commands.iter().chain(&r.options).map(|e| e.usage.len()).max().unwrap_or(0) + 2;
    let line = |e: &Entry| format!("  {:<width$}{}\n", e.usage, e.summary);
    let mut text = format!("{}\n\nUsage:\n", r.intro);
    r.commands.iter().for_each(|e| text.push_str(&line(e)));
    text.push_str("\nOptions:\n");
    r.options.iter().for_each(|e| text.push_str(&line(e)));
    text
}

const MAX_STDIN: u64 = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
/// Agents wait on every hook call, so the hook gives up on Bashboard much sooner.
const HOOK_TIMEOUT: Duration = Duration::from_secs(1);

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Ahead of `run`: outside a pane the hook must exit 0 quietly, not fail like other commands.
    if let Some(("hook", rest)) = args.split_first().map(|(c, r)| (c.as_str(), r)) {
        return ExitCode::from(hook_client::run(rest, &post_hook));
    }
    match run(&args) {
        Ok(code) => code,
        Err(msg) => {
            eprintln!("bb: {msg}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<ExitCode, String> {
    let Some((command, rest)) = args.split_first() else {
        print!("{}", help_text());
        return Ok(ExitCode::SUCCESS);
    };
    if is_help(command) {
        print!("{}", help_text());
        return Ok(ExitCode::SUCCESS);
    }
    // Talks only to Credential Manager, so it works outside a pane too.
    if command == "auth" {
        return auth(rest).map(|()| ExitCode::SUCCESS);
    }
    if command == "skill" {
        return skill(rest).map(|()| ExitCode::SUCCESS);
    }
    if command == "ci" {
        return Ok(ci(rest));
    }
    if command == "pr" {
        return Ok(pr(rest));
    }
    let pane = Pane::from_env()?;
    let stdin = if wants_stdin(command, rest) && !io::stdin().is_terminal() {
        Some(read_stdin()?)
    } else {
        None
    };
    let body = request_body(command, rest, &pane.cwd, stdin.as_deref());
    let response = pane
        .post("/cli", &body, TIMEOUT)
        .map_err(|e| format!("could not reach Bashboard: {e}"))?;
    answer(&response).map(|()| ExitCode::SUCCESS)
}

/// What a pane hands `bb` through its environment, plus the folder `bb` runs in.
struct Pane {
    addr: String,
    token: String,
    id: String,
    cwd: String,
}

impl Pane {
    fn from_env() -> Result<Self, String> {
        let url = std::env::var("BASHBOARD_HOOK_URL").unwrap_or_default();
        if url.is_empty() {
            return Err("only works inside a Bashboard pane".into());
        }
        let cwd = std::env::current_dir()
            .map_err(|e| format!("no working directory: {e}"))?
            .to_string_lossy()
            .into_owned();
        Ok(Self {
            addr: parse_url(&url)?,
            token: std::env::var("BASHBOARD_HOOK_TOKEN").unwrap_or_default(),
            id: std::env::var("BASHBOARD_PANE_ID").unwrap_or_default(),
            cwd,
        })
    }

    fn post(&self, path: &str, body: &[u8], timeout: Duration) -> io::Result<Vec<u8>> {
        let headers = [
            ("X-Bashboard-Token", self.token.as_str()),
            ("X-Bashboard-Pane", self.id.as_str()),
        ];
        let request = build_request(path, &self.addr, &headers, body);
        send(&self.addr, &request, timeout)
    }
}

/// Forge calls behind `/ci` can take several seconds each, and `status` makes two.
const CI_TIMEOUT: Duration = Duration::from_secs(60);
const CI_USAGE: &str = "usage: bb ci [status|wait|log|rerun|cancel] [options] (see bb help)";
const MIN_INTERVAL: Duration = Duration::from_secs(10);
const DEFAULT_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const NO_RUN_LIMIT: Duration = Duration::from_secs(5 * 60);
const MAX_FAILED_READS: u32 = 8;
/// `bb ci wait` exits 1 only for a failed or cancelled run, so its own errors take this code.
const WAIT_GAVE_UP: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq)]
enum CiOp {
    Status,
    Wait,
    Log,
    Rerun,
    Cancel,
}

#[derive(Debug, PartialEq)]
struct CiArgs {
    op: CiOp,
    branch: Option<String>,
    json: bool,
    interval: Duration,
    timeout: Duration,
    run: Option<String>,
    job: Option<String>,
    failed: bool,
}

fn parse_ci(rest: &[String]) -> Result<CiArgs, String> {
    let (op, flags) = match rest.first().map(String::as_str) {
        None => (CiOp::Status, rest),
        Some(f) if f.starts_with('-') => (CiOp::Status, rest),
        Some(sub) => {
            let op = match sub {
                "status" => CiOp::Status,
                "wait" => CiOp::Wait,
                "log" => CiOp::Log,
                "rerun" => CiOp::Rerun,
                "cancel" => CiOp::Cancel,
                other => return Err(format!("unknown ci command \"{other}\" ({CI_USAGE})")),
            };
            (op, &rest[1..])
        }
    };
    let mut args = CiArgs {
        op,
        branch: None,
        json: false,
        interval: DEFAULT_INTERVAL,
        timeout: DEFAULT_TIMEOUT,
        run: None,
        job: None,
        failed: false,
    };
    let mut it = flags.iter();
    while let Some(arg) = it.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((f, v)) if f.starts_with("--") => (f, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let applies = match flag {
            "--branch" | "--json" => true,
            "--interval" | "--timeout" => op == CiOp::Wait,
            "--run" => matches!(op, CiOp::Log | CiOp::Rerun | CiOp::Cancel),
            "--job" => op == CiOp::Log,
            "--failed" => op == CiOp::Rerun,
            _ => return Err(format!("unknown option \"{arg}\" ({CI_USAGE})")),
        };
        if !applies {
            return Err(format!("{flag} does not apply to bb ci {}", op_word(op)));
        }
        let takes_value = !matches!(flag, "--json" | "--failed");
        let value = if !takes_value {
            if inline.is_some() {
                return Err(format!("{flag} takes no value"));
            }
            String::new()
        } else {
            match inline.or_else(|| it.next().cloned()) {
                Some(v) if !v.is_empty() && !v.starts_with("--") => v,
                _ => return Err(format!("{flag} needs a value")),
            }
        };
        match flag {
            "--branch" => args.branch = Some(value),
            "--json" => args.json = true,
            "--interval" => args.interval = parse_duration(&value)?.max(MIN_INTERVAL),
            "--timeout" => args.timeout = parse_duration(&value)?,
            "--run" => args.run = Some(value),
            "--job" => args.job = Some(value),
            _ => args.failed = true,
        }
    }
    if args.job.is_some() && args.run.is_none() {
        return Err("--job needs --run".into());
    }
    Ok(args)
}

fn op_word(op: CiOp) -> &'static str {
    match op {
        CiOp::Status => "status",
        CiOp::Wait => "wait",
        CiOp::Log => "log",
        CiOp::Rerun => "rerun",
        CiOp::Cancel => "cancel",
    }
}

/// `90`, `90s`, `30m`, `1h`, or a sum such as `1h30m`; a bare number is seconds.
fn parse_duration(text: &str) -> Result<Duration, String> {
    let bad = || format!("bad duration \"{text}\" (use e.g. 90s, 30m, or 1h)");
    let mut total = 0u64;
    let mut digits = String::new();
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            digits.push(c);
            continue;
        }
        let unit = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            _ => return Err(bad()),
        };
        let n: u64 = digits.parse().map_err(|_| bad())?;
        total = total.saturating_add(n.saturating_mul(unit));
        digits.clear();
    }
    if !digits.is_empty() {
        total = total.saturating_add(digits.parse::<u64>().map_err(|_| bad())?);
    } else if total == 0 && text.trim().is_empty() {
        return Err(bad());
    }
    if total == 0 {
        return Err(format!("duration \"{text}\" must be more than zero"));
    }
    Ok(Duration::from_secs(total))
}

fn ci_body(args: &CiArgs, cwd: &str) -> Vec<u8> {
    let op = match args.op {
        CiOp::Status | CiOp::Wait => "status",
        CiOp::Log if args.job.is_some() => "log",
        CiOp::Log => "failed",
        CiOp::Rerun => "rerun",
        CiOp::Cancel => "cancel",
    };
    let mut body = serde_json::json!({ "op": op, "cwd": cwd });
    if let Some(b) = &args.branch {
        body["branch"] = b.as_str().into();
    }
    if let Some(r) = &args.run {
        body["runId"] = r.as_str().into();
    }
    if let Some(j) = &args.job {
        body["jobId"] = j.as_str().into();
    }
    // The core accepts failedOnly only on rerun.
    if args.op == CiOp::Rerun && args.failed {
        body["failedOnly"] = true.into();
    }
    serde_json::to_vec(&body).expect("a JSON value serializes")
}

#[derive(Debug, PartialEq)]
struct CiError {
    message: String,
    /// Worth reading again: Bashboard was unreachable or the forge failed (502). Anything else
    /// (a bad token, no live pane, a bad request) will fail the same way next time.
    transient: bool,
}

fn ci_answer(raw: &[u8]) -> Result<serde_json::Value, CiError> {
    let Some((status, body)) = parse_response(raw) else {
        return Err(CiError {
            message: "Bashboard sent an unreadable answer".into(),
            transient: true,
        });
    };
    if status == 200 {
        return serde_json::from_slice(&body).map_err(|e| CiError {
            message: format!("Bashboard sent unreadable JSON: {e}"),
            transient: true,
        });
    }
    let message = if body.iter().all(u8::is_ascii_whitespace) {
        format!("Bashboard answered {status}")
    } else {
        error_text(&body)
    };
    Err(CiError {
        message,
        transient: status >= 500,
    })
}

fn ci(rest: &[String]) -> ExitCode {
    let waiting = rest.first().is_some_and(|a| a == "wait");
    match ci_inner(rest) {
        Ok(code) => code,
        Err(msg) => {
            eprintln!("bb: {msg}");
            ExitCode::from(if waiting { WAIT_GAVE_UP } else { 1 })
        }
    }
}

fn ci_inner(rest: &[String]) -> Result<ExitCode, String> {
    let args = parse_ci(rest)?;
    let pane = Pane::from_env()?;
    let body = ci_body(&args, &pane.cwd);
    let fetch = || -> Result<serde_json::Value, CiError> {
        let raw = pane.post("/ci", &body, CI_TIMEOUT).map_err(|e| CiError {
            message: format!("could not reach Bashboard: {e}"),
            transient: true,
        })?;
        ci_answer(&raw)
    };
    if args.op == CiOp::Wait {
        return Ok(ci_wait(&args, fetch));
    }
    let value = fetch().map_err(|e| e.message)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
        return Ok(ExitCode::SUCCESS);
    }
    match args.op {
        CiOp::Status => print!("{}", render_status(&value, now_secs())),
        CiOp::Log => {
            let text = value["text"].as_str().unwrap_or_default();
            print!("{text}");
            if !text.ends_with('\n') {
                println!();
            }
            if value["truncated"].as_bool() == Some(true) {
                eprintln!("bb: the host's log was longer; this is its last 1 MiB");
            }
        }
        _ => println!("{}", write_message(&args, value["runId"].as_str().unwrap_or("?"))),
    }
    Ok(ExitCode::SUCCESS)
}

fn write_message(args: &CiArgs, run_id: &str) -> String {
    match args.op {
        CiOp::Rerun if args.failed => format!("Re-running the failed jobs of run {run_id}."),
        CiOp::Rerun => format!("Re-running run {run_id}."),
        _ => format!("Canceled run {run_id}."),
    }
}

/// A large diff can take a moment, but nothing behind `/size` leaves the machine.
const SIZE_TIMEOUT: Duration = Duration::from_secs(30);
const PR_USAGE: &str = "usage: bb pr size [--json] (see bb help)";
/// `bb pr size` keeps exit 1 for "over the threshold", so every error takes this code.
const PR_ERROR: u8 = 2;

/// Whether `--json` was given.
fn parse_pr(rest: &[String]) -> Result<bool, String> {
    match rest.split_first() {
        Some((sub, flags)) if sub == "size" => match flags {
            [] => Ok(false),
            [flag] if flag == "--json" => Ok(true),
            _ => Err(format!("unknown option \"{}\" ({PR_USAGE})", flags.join(" "))),
        },
        Some((sub, _)) if !is_help(sub) => Err(format!("unknown pr command \"{sub}\" ({PR_USAGE})")),
        _ => Err(PR_USAGE.into()),
    }
}

fn pr(rest: &[String]) -> ExitCode {
    match pr_size(rest) {
        Ok(code) => code,
        Err(msg) => {
            eprintln!("bb: {msg}");
            ExitCode::from(PR_ERROR)
        }
    }
}

fn pr_size(rest: &[String]) -> Result<ExitCode, String> {
    let json = parse_pr(rest)?;
    let pane = Pane::from_env()?;
    let body = serde_json::to_vec(&serde_json::json!({ "cwd": pane.cwd }))
        .expect("a JSON value serializes");
    let raw = pane
        .post("/size", &body, SIZE_TIMEOUT)
        .map_err(|e| format!("could not reach Bashboard: {e}"))?;
    let value = ci_answer(&raw).map_err(|e| e.message)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
    } else {
        println!("{}", size_line(&value));
    }
    Ok(ExitCode::from(if over_threshold(&value) { 1 } else { 0 }))
}

/// Strictly over a nonzero threshold, and only when there is something to compare against.
fn over_threshold(value: &serde_json::Value) -> bool {
    let size = &value["size"];
    let threshold = value["threshold"].as_u64().unwrap_or(0);
    !size["comparison"].is_null()
        && threshold > 0
        && size["lines"].as_u64().unwrap_or(0) > threshold
}

fn plural(n: u64, one: &str) -> String {
    if n == 1 { format!("{n} {one}") } else { format!("{n} {one}s") }
}

fn size_line(value: &serde_json::Value) -> String {
    let size = &value["size"];
    let n = |k: &str| size[k].as_u64().unwrap_or(0);
    let threshold = match value["threshold"].as_u64().unwrap_or(0) {
        0 => "threshold off".to_string(),
        t => format!("threshold {t}"),
    };
    let excluded = format!(
        "tests, lockfiles, and generated files excluded: {} in {}",
        plural(n("excludedLines"), "line"),
        plural(n("excludedFiles"), "file"),
    );
    match size["comparison"].as_str() {
        Some(against) => format!(
            "{} in {} against {against} ({threshold}; {excluded})",
            plural(n("lines"), "line"),
            plural(n("files"), "file"),
        ),
        None => format!("No comparison ref, so the branch size is not measured ({threshold})."),
    }
}

/// Polls `status` until a stop rule fires; see `decide`.
fn ci_wait(
    args: &CiArgs,
    mut fetch: impl FnMut() -> Result<serde_json::Value, CiError>,
) -> ExitCode {
    let start = std::time::Instant::now();
    let mut state = WaitState::default();
    let mut last_summary = None;
    loop {
        let read = fetch();
        let elapsed = start.elapsed();
        match &read {
            Err(e) if !e.transient => {
                eprintln!("bb: {}", e.message);
                return ExitCode::from(WAIT_GAVE_UP);
            }
            Err(e) => eprintln!(
                "bb: read {} of {MAX_FAILED_READS} failed: {}",
                state.failed_reads + 1,
                e.message
            ),
            Ok(v) => {
                let summary = status_summary(v);
                if last_summary.as_ref() != Some(&summary) {
                    if args.json {
                        println!("{v}");
                    } else {
                        println!("[{}] {summary}", format_duration(elapsed.as_secs()));
                    }
                    let _ = io::stdout().flush();
                    last_summary = Some(summary);
                }
            }
        }
        let read = read.as_ref().map_err(|e| e.message.as_str());
        match decide(&mut state, read, elapsed, args.timeout) {
            Verdict::Continue => {
                let left = args.timeout.saturating_sub(elapsed);
                std::thread::sleep(args.interval.min(left.max(Duration::from_secs(1))));
            }
            Verdict::Stop(code, why) => {
                if args.json {
                    eprintln!("{why}");
                } else {
                    println!("{why}");
                }
                return ExitCode::from(code);
            }
        }
    }
}

#[derive(Debug, Default)]
struct WaitState {
    failed_reads: u32,
    /// The head SHA of the last good read; `None` until one arrives.
    head: Option<Option<String>>,
    /// When the head SHA was first seen, so a push during the wait restarts the no-run clock.
    head_since: Duration,
}

#[derive(Debug, PartialEq)]
enum Verdict {
    Continue,
    Stop(u8, String),
}

/// A run status that will not change on its own. `waiting` needs a person, so it is not final.
fn is_final(status: &str) -> bool {
    !matches!(status, "queued" | "running" | "waiting")
}

/// The stop rules for `bb ci wait`, applied to one read of `/ci` status at `elapsed`.
fn decide(
    state: &mut WaitState,
    read: Result<&serde_json::Value, &str>,
    elapsed: Duration,
    timeout: Duration,
) -> Verdict {
    match read {
        Err(msg) => {
            state.failed_reads += 1;
            if state.failed_reads >= MAX_FAILED_READS {
                return Verdict::Stop(
                    WAIT_GAVE_UP,
                    format!("Gave up: {MAX_FAILED_READS} reads in a row failed; the last said: {msg}"),
                );
            }
        }
        Ok(status) => {
            state.failed_reads = 0;
            let head = status["headSha"].as_str().map(str::to_string);
            if state.head.as_ref() != Some(&head) {
                state.head = Some(head.clone());
                state.head_since = elapsed;
            }
            let pull = &status["pull"];
            let number = pull["number"].as_u64().unwrap_or_default();
            match pull["state"].as_str() {
                Some("merged") => return Verdict::Stop(0, format!("PR #{number} merged.")),
                Some("closed") => {
                    return Verdict::Stop(
                        WAIT_GAVE_UP,
                        format!("Gave up: PR #{number} was closed without merging."),
                    );
                }
                _ => {}
            }
            let runs = status["runs"].as_array().map(Vec::as_slice).unwrap_or_default();
            let sha = short_sha(head.as_deref());
            if runs.is_empty() {
                if elapsed.saturating_sub(state.head_since) >= NO_RUN_LIMIT {
                    return Verdict::Stop(
                        WAIT_GAVE_UP,
                        format!("Gave up: no run appeared on {sha} within 5 minutes."),
                    );
                }
            } else if runs.iter().all(|r| is_final(run_status(r))) {
                let bad: Vec<String> = runs
                    .iter()
                    .filter(|r| matches!(run_status(r), "failure" | "cancelled"))
                    .map(|r| format!("{} ({})", r["name"].as_str().unwrap_or("?"), run_status(r)))
                    .collect();
                return if bad.is_empty() {
                    Verdict::Stop(0, format!("Passed: every run on {sha} finished without failing."))
                } else {
                    Verdict::Stop(1, format!("Failed: {}. Run bb ci log for the report.", bad.join(", ")))
                };
            }
        }
    }
    if elapsed >= timeout {
        return Verdict::Stop(
            WAIT_GAVE_UP,
            format!("Gave up: timed out after {}.", format_duration(timeout.as_secs())),
        );
    }
    Verdict::Continue
}

fn run_status(run: &serde_json::Value) -> &str {
    run["status"].as_str().unwrap_or("other")
}

fn short_sha(sha: Option<&str>) -> String {
    sha.map_or_else(|| "the branch".into(), |s| s.chars().take(7).collect())
}

/// One line naming the head, each run's status, and the PR; `bb ci wait` prints it on change.
fn status_summary(status: &serde_json::Value) -> String {
    let sha = short_sha(status["headSha"].as_str());
    let runs = status["runs"].as_array().map(Vec::as_slice).unwrap_or_default();
    let mut line = if runs.is_empty() {
        format!("{sha}: no runs yet")
    } else {
        let list: Vec<String> = runs
            .iter()
            .map(|r| format!("{} {}", r["name"].as_str().unwrap_or("?"), run_status(r)))
            .collect();
        format!("{sha}: {}", list.join(", "))
    };
    if let Some(state) = status["pull"]["state"].as_str() {
        let number = status["pull"]["number"].as_u64().unwrap_or_default();
        line.push_str(&format!("; PR #{number} {state}"));
    }
    line
}

fn render_status(status: &serde_json::Value, now: i64) -> String {
    let repo = &status["repo"];
    let text = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
    let mut out = format!(
        "{}/{}  {}\nbranch {} at {}\n",
        text(&repo["owner"]),
        text(&repo["name"]),
        text(&repo["webUrl"]),
        text(&status["branch"]),
        short_sha(status["headSha"].as_str()),
    );
    let runs = status["runs"].as_array().map(Vec::as_slice).unwrap_or_default();
    if runs.is_empty() {
        out.push_str("  no runs on this commit\n");
    }
    let name_width = runs.iter().map(|r| text(&r["name"]).len()).max().unwrap_or(0);
    for r in runs {
        let line = format!(
            "  {:<9}  {:<name_width$}  {:<7}  {}",
            run_status(r),
            text(&r["name"]),
            run_duration(r, now),
            text(&r["webUrl"]),
        );
        out.push_str(line.trim_end());
        out.push('\n');
    }
    let pull = &status["pull"];
    if pull.is_object() {
        let draft = if pull["draft"].as_bool() == Some(true) { ", draft" } else { "" };
        out.push_str(&format!(
            "PR #{} ({}{draft}): {}  {}\n",
            pull["number"].as_u64().unwrap_or_default(),
            text(&pull["state"]),
            text(&pull["title"]),
            text(&pull["webUrl"]),
        ));
    } else {
        out.push_str("no pull request from this branch\n");
    }
    out
}

/// How long a run has taken, or has been going; `-` when the host gave no usable times.
fn run_duration(run: &serde_json::Value, now: i64) -> String {
    let start = run["startedAt"]
        .as_str()
        .or_else(|| run["createdAt"].as_str())
        .and_then(iso_secs);
    let end = match run["finishedAt"].as_str().and_then(iso_secs) {
        Some(t) => Some(t),
        None if !is_final(run_status(run)) => Some(now),
        None => None,
    };
    match (start, end) {
        (Some(s), Some(e)) if e >= s => format_duration((e - s) as u64),
        _ => "-".into(),
    }
}

fn format_duration(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {}s", secs / 60, secs % 60),
        _ => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

/// Seconds since the Unix epoch for an ISO 8601 time such as `2026-11-12T10:00:00.123Z` or
/// `2026-11-12T10:00:00+02:00`.
fn iso_secs(s: &str) -> Option<i64> {
    let num = |range: std::ops::Range<usize>| s.get(range)?.parse::<i64>().ok();
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b' ') {
        return None;
    }
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        rest = frac.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest {
        "" | "Z" | "z" => 0,
        _ => {
            let sign = match rest.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = rest[1..].chars().filter(|c| *c != ':').collect();
            if digits.len() != 4 {
                return None;
            }
            let oh: i64 = digits[..2].parse().ok()?;
            let om: i64 = digits[2..].parse().ok()?;
            sign * (oh * 3600 + om * 60)
        }
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + sec - offset)
}

/// The skill Claude Code loads to learn `bb`, installed by `bb skill install`.
const SKILL: &str = include_str!("../../skills/bashboard/SKILL.md");
const SKILL_USAGE: &str = "usage: bb skill install";

fn skill(rest: &[String]) -> Result<(), String> {
    if !matches!(rest, [a] if a == "install") {
        return Err(SKILL_USAGE.into());
    }
    let home = home_dir().ok_or("could not find the home folder (HOME and USERPROFILE are unset)")?;
    println!("{}", install_skill(std::path::Path::new(&home))?);
    Ok(())
}

/// Git Bash's rule, and the one Claude Code follows on Windows: `HOME`, then `USERPROFILE`.
fn home_dir() -> Option<String> {
    ["HOME", "USERPROFILE"]
        .into_iter()
        .filter_map(|v| std::env::var(v).ok())
        .find(|h| !h.is_empty())
}

fn install_skill(home: &std::path::Path) -> Result<String, String> {
    let dir = home.join(".claude").join("skills").join("bashboard");
    let path = dir.join("SKILL.md");
    let shown = path.display();
    match std::fs::read_to_string(&path) {
        Ok(existing) if existing == SKILL => {
            return Ok(format!("The Bashboard skill at {shown} is already up to date."));
        }
        // Someone else's skill by the same name is theirs to move, not ours to replace.
        Ok(existing) if !is_bashboard_skill(&existing) => {
            return Err(format!(
                "{shown} exists and is not Bashboard's (its front matter lacks \
                 \"bashboard-skill: true\"); move it aside to install"
            ));
        }
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("could not read {shown}: {e}")),
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    std::fs::write(&path, SKILL).map_err(|e| format!("could not write {shown}: {e}"))?;
    Ok(format!("Installed the Bashboard skill at {shown}."))
}

/// Whether a skill file's front matter carries the `bashboard-skill: true` marker.
fn is_bashboard_skill(text: &str) -> bool {
    let mut lines = text.trim_start_matches('\u{feff}').lines().map(str::trim);
    if lines.next() != Some("---") {
        return false;
    }
    lines
        .take_while(|l| *l != "---")
        .any(|l| l == "bashboard-skill: true")
}

fn is_help(command: &str) -> bool {
    matches!(command, "help" | "-h" | "--help")
}

/// Standard input feeds `scratch` only when no text was given on the command line.
fn wants_stdin(command: &str, rest: &[String]) -> bool {
    command == "scratch"
        && rest
            .iter()
            .all(|a| matches!(a.as_str(), "--collapsed" | "--tab" | "-t" | "--"))
}

fn read_stdin() -> Result<String, String> {
    let mut bytes = Vec::new();
    io::stdin()
        .lock()
        .take(MAX_STDIN + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read standard input: {e}"))?;
    if bytes.len() as u64 > MAX_STDIN {
        return Err("input is over 1 MiB".into());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug, PartialEq)]
enum AuthAction {
    Store,
    Clear,
}

#[derive(Debug, PartialEq)]
enum AuthProvider {
    Bitbucket,
    /// The organization as typed; its credential target is built by `azure_devops_target`.
    AzureDevOps(String),
}

const AUTH_USAGE: &str =
    "usage: bb auth bitbucket [--clear] | bb auth azure-devops <org> [--clear]";

fn parse_flags(flags: &[String]) -> Result<AuthAction, String> {
    match flags {
        [] => Ok(AuthAction::Store),
        [f] if f == "--clear" => Ok(AuthAction::Clear),
        _ => Err(AUTH_USAGE.into()),
    }
}

fn parse_auth(rest: &[String]) -> Result<(AuthProvider, AuthAction), String> {
    let Some((provider, args)) = rest.split_first() else {
        return Err(AUTH_USAGE.into());
    };
    match provider.as_str() {
        "bitbucket" => Ok((AuthProvider::Bitbucket, parse_flags(args)?)),
        "azure-devops" => {
            // A leading dash is a flag in the wrong place, not an organization.
            let Some((org, flags)) = args.split_first().filter(|(o, _)| !o.starts_with('-'))
            else {
                return Err(AUTH_USAGE.into());
            };
            credential_store::azure_devops_target(org)?;
            Ok((AuthProvider::AzureDevOps(org.clone()), parse_flags(flags)?))
        }
        other => Err(format!("unknown provider \"{other}\" ({AUTH_USAGE})")),
    }
}

fn auth(rest: &[String]) -> Result<(), String> {
    let (provider, action) = parse_auth(rest)?;
    let (target, user, prompt) = match &provider {
        AuthProvider::Bitbucket => (
            BITBUCKET_TARGET.to_string(),
            BITBUCKET_USER,
            "Bitbucket API token: ".to_string(),
        ),
        AuthProvider::AzureDevOps(org) => (
            credential_store::azure_devops_target(org)?,
            AZURE_DEVOPS_USER,
            format!("Azure DevOps PAT for {org}: "),
        ),
    };
    match action {
        AuthAction::Clear => {
            if credential_store::delete(&target)? {
                println!("{}", removed_message(&provider));
            } else {
                println!("{}", not_stored_message(&provider));
            }
        }
        AuthAction::Store => {
            let token = clean_token(&read_secret(&prompt)?)?;
            credential_store::write(&target, user, token.as_bytes())?;
            println!("{}", stored_message(&provider));
        }
    }
    Ok(())
}

fn stored_message(provider: &AuthProvider) -> String {
    match provider {
        AuthProvider::Bitbucket => {
            "Stored the Bitbucket token in Windows Credential Manager.".into()
        }
        AuthProvider::AzureDevOps(org) => {
            format!("Stored the Azure DevOps token for {org} in Windows Credential Manager.")
        }
    }
}

fn removed_message(provider: &AuthProvider) -> String {
    match provider {
        AuthProvider::Bitbucket => "Removed the stored Bitbucket token.".into(),
        AuthProvider::AzureDevOps(org) => {
            format!("Removed the stored Azure DevOps token for {org}.")
        }
    }
}

fn not_stored_message(provider: &AuthProvider) -> String {
    match provider {
        AuthProvider::Bitbucket => "No Bitbucket token was stored.".into(),
        AuthProvider::AzureDevOps(org) => format!("No Azure DevOps token was stored for {org}."),
    }
}

/// Reads one line with console echo off, or standard input when it is not a terminal.
fn read_secret(prompt: &str) -> Result<String, String> {
    let mut input = String::new();
    if io::stdin().is_terminal() {
        eprint!("{prompt}");
        let _ = io::stderr().flush();
        let guard = console::EchoOff::new();
        let read = io::stdin().read_line(&mut input);
        drop(guard);
        eprintln!();
        read.map_err(|e| format!("could not read the token: {e}"))?;
    } else {
        let mut bytes = Vec::new();
        io::stdin()
            .lock()
            .take(MAX_STDIN + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("could not read standard input: {e}"))?;
        input = String::from_utf8_lossy(&bytes).into_owned();
    }
    Ok(input)
}

#[cfg(windows)]
mod console {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        CONSOLE_MODE, ENABLE_ECHO_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE,
        SetConsoleMode,
    };

    /// Turns console echo off for standard input and restores the old mode on drop, so an
    /// early return never leaves the terminal silent.
    pub struct EchoOff {
        handle: HANDLE,
        mode: Option<CONSOLE_MODE>,
    }

    impl EchoOff {
        pub fn new() -> Self {
            // SAFETY: plain console queries on the process's own input handle.
            unsafe {
                let handle = GetStdHandle(STD_INPUT_HANDLE).unwrap_or_default();
                let mut mode = CONSOLE_MODE(0);
                if GetConsoleMode(handle, &mut mode).is_err() {
                    return Self { handle, mode: None };
                }
                let quiet = CONSOLE_MODE(mode.0 & !ENABLE_ECHO_INPUT.0);
                let changed = SetConsoleMode(handle, quiet).is_ok();
                Self {
                    handle,
                    mode: changed.then_some(mode),
                }
            }
        }
    }

    impl Drop for EchoOff {
        fn drop(&mut self) {
            if let Some(mode) = self.mode {
                // SAFETY: restores the mode read in `new` on the same handle.
                unsafe {
                    let _ = SetConsoleMode(self.handle, mode);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod console {
    pub struct EchoOff;

    impl EchoOff {
        pub fn new() -> Self {
            Self
        }
    }
}

fn request_body(command: &str, rest: &[String], cwd: &str, stdin: Option<&str>) -> Vec<u8> {
    let mut body = serde_json::json!({ "command": command, "args": rest, "cwd": cwd });
    if let Some(text) = stdin {
        body["stdin"] = text.into();
    }
    serde_json::to_vec(&body).expect("a JSON value serializes")
}

/// Returns `host:port` from the `http://127.0.0.1:<port>` URL the core hands each pane.
fn parse_url(url: &str) -> Result<String, String> {
    let bad = || format!("bad BASHBOARD_HOOK_URL: {url}");
    let rest = url.strip_prefix("http://").ok_or_else(bad)?;
    let addr = rest.trim_end_matches('/');
    let (host, port) = addr.rsplit_once(':').ok_or_else(bad)?;
    if host.is_empty() || host.contains('/') || port.parse::<u16>().is_err() {
        return Err(bad());
    }
    Ok(addr.to_string())
}

/// Forwards an agent hook event to `POST /hook`, ignoring every failure.
fn post_hook(url: &str, headers: &[(&str, &str)], body: &[u8]) {
    let Ok(addr) = parse_url(url) else { return };
    let request = build_request("/hook", &addr, headers, body);
    let _ = send(&addr, &request, HOOK_TIMEOUT);
}

fn build_request(path: &str, addr: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut req = format!("POST {path} HTTP/1.1\r\nHost: {addr}\r\n");
    for (name, value) in headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str(&format!(
        "Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    ));
    let mut req = req.into_bytes();
    req.extend_from_slice(body);
    req
}

fn send(addr: &str, request: &[u8], timeout: Duration) -> io::Result<Vec<u8>> {
    let target = addr
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no address"))?;
    let mut stream = TcpStream::connect_timeout(&target, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(request)?;
    let mut response = Vec::new();
    match stream.read_to_end(&mut response) {
        // A server that keeps the socket open past its answer still gave one.
        Err(_) if parse_response(&response).is_some() => Ok(response),
        Err(e) => Err(e),
        Ok(_) => Ok(response),
    }
}

/// Splits a raw HTTP response into its status code and body.
fn parse_response(raw: &[u8]) -> Option<(u16, Cow<'_, [u8]>)> {
    let line_end = raw.windows(2).position(|w| w == b"\r\n")?;
    let line = std::str::from_utf8(&raw[..line_end]).ok()?;
    let mut parts = line.split(' ');
    if !parts.next()?.starts_with("HTTP/") {
        return None;
    }
    let status = parts.next()?.parse().ok()?;
    let Some(head_end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
        return Some((status, Cow::Borrowed(&raw[raw.len()..])));
    };
    let body = &raw[head_end + 4..];
    let chunked = String::from_utf8_lossy(&raw[..head_end])
        .lines()
        .filter_map(|l| l.split_once(':'))
        .any(|(name, value)| {
            name.trim().eq_ignore_ascii_case("transfer-encoding")
                && value.to_ascii_lowercase().contains("chunked")
        });
    // tiny_http switches an HTTP/1.1 answer to chunked encoding once the body passes 32 KiB,
    // which a full `bb ci log --job` reply easily does.
    if chunked {
        return Some((status, Cow::Owned(dechunk(body)?)));
    }
    Some((status, Cow::Borrowed(body)))
}

/// Decodes a chunked transfer-encoded body, ignoring chunk extensions and trailers.
fn dechunk(mut rest: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = rest.windows(2).position(|w| w == b"\r\n")?;
        let size_text = std::str::from_utf8(&rest[..line_end]).ok()?;
        let size_text = size_text.split(';').next()?.trim();
        let size = usize::from_str_radix(size_text, 16).ok()?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Some(out);
        }
        out.extend_from_slice(rest.get(..size)?);
        rest = rest.get(size..)?.strip_prefix(b"\r\n")?;
    }
}

fn answer(raw: &[u8]) -> Result<(), String> {
    let (status, body) = parse_response(raw).ok_or("Bashboard sent an unreadable answer")?;
    match status {
        204 => Ok(()),
        400 => Err(error_text(&body)),
        403 => Err("Bashboard rejected the token".into()),
        404 => Err("this pane is not known to Bashboard".into()),
        413 => Err("input is over 1 MiB".into()),
        other => Err(format!("Bashboard answered {other}")),
    }
}

fn error_text(body: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("error")?.as_str().map(str::to_string))
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn help_lists_every_command() {
        let text = help_text();
        for name in [
            "open",
            "edit",
            "git",
            "search",
            "scratch",
            "term",
            "ship",
            "ports",
            "containers",
            "browse",
            "auth",
            "ci",
            "ci wait",
            "ci log",
            "ci rerun",
            "ci cancel",
            "pr size",
            "skill install",
            "help",
            "--collapsed",
            "--tab",
        ] {
            assert!(text.contains(name), "{name} missing from help");
        }
        // Every summary starts in one column, past the longest usage.
        let column = |summary: &str| {
            text.lines().find_map(|l| l.find(summary)).unwrap()
        };
        assert_eq!(column("Open the file in"), column("Store an Azure DevOps PAT"));
        assert!(text.contains("<org> [--clear]  Store"));
    }

    #[test]
    fn auth_arguments() {
        use AuthAction::{Clear, Store};
        use AuthProvider::{AzureDevOps, Bitbucket};
        assert_eq!(
            parse_auth(&strings(&["bitbucket"])),
            Ok((Bitbucket, Store))
        );
        assert_eq!(
            parse_auth(&strings(&["bitbucket", "--clear"])),
            Ok((Bitbucket, Clear))
        );
        assert_eq!(
            parse_auth(&strings(&["azure-devops", "Contoso"])),
            Ok((AzureDevOps("Contoso".into()), Store))
        );
        assert_eq!(
            parse_auth(&strings(&["azure-devops", "contoso", "--clear"])),
            Ok((AzureDevOps("contoso".into()), Clear))
        );
        assert_eq!(parse_auth(&[]).unwrap_err(), AUTH_USAGE);
        // A missing organization, a bad one, and bad flags all fail with the usage or a reason.
        assert_eq!(parse_auth(&strings(&["azure-devops"])).unwrap_err(), AUTH_USAGE);
        assert_eq!(
            parse_auth(&strings(&["azure-devops", "--clear"])).unwrap_err(),
            AUTH_USAGE
        );
        assert!(parse_auth(&strings(&["azure-devops", "a/b"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "a b"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "contoso", "--wat"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "contoso", "--clear", "x"])).is_err());
        assert!(parse_auth(&strings(&["azure-devops", "--clear", "contoso"])).is_err());
        assert!(
            parse_auth(&strings(&["github"]))
                .unwrap_err()
                .contains("unknown provider")
        );
        assert!(parse_auth(&strings(&["bitbucket", "--wat"])).is_err());
        assert!(parse_auth(&strings(&["bitbucket", "--clear", "x"])).is_err());
    }

    #[test]
    fn help_forms() {
        for h in ["help", "-h", "--help"] {
            assert!(is_help(h));
        }
        assert!(!is_help("git"));
    }

    #[test]
    fn stdin_only_for_bare_scratch() {
        assert!(wants_stdin("scratch", &[]));
        assert!(wants_stdin("scratch", &strings(&["--collapsed"])));
        assert!(wants_stdin("scratch", &strings(&["-t", "--tab", "--"])));
        assert!(!wants_stdin("scratch", &strings(&["--", "hello"])));
        assert!(!wants_stdin("scratch", &strings(&["hello"])));
        assert!(!wants_stdin("scratch", &strings(&["--collapsed", "hello"])));
        assert!(!wants_stdin("git", &[]));
    }

    #[test]
    fn url_parsing() {
        assert_eq!(
            parse_url("http://127.0.0.1:5123").unwrap(),
            "127.0.0.1:5123"
        );
        assert_eq!(
            parse_url("http://127.0.0.1:5123/").unwrap(),
            "127.0.0.1:5123"
        );
        assert!(parse_url("https://127.0.0.1:5123").is_err());
        assert!(parse_url("http://127.0.0.1").is_err());
        assert!(parse_url("http://127.0.0.1:notaport").is_err());
        assert!(parse_url("http://:5123").is_err());
        assert!(parse_url("http://127.0.0.1:5123/hook").is_err());
    }

    #[test]
    fn body_shape() {
        let body = request_body("open", &strings(&["src", "--collapsed"]), r"C:\repo", None);
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            v,
            serde_json::json!({ "command": "open", "args": ["src", "--collapsed"], "cwd": r"C:\repo" })
        );
        let body = request_body("scratch", &[], r"C:\repo", Some("hi\n"));
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["stdin"], "hi\n");
        assert_eq!(v["args"], serde_json::json!([]));
    }

    #[test]
    fn request_text() {
        let headers = [("X-Bashboard-Token", "tok"), ("X-Bashboard-Pane", "3")];
        let req = build_request("/cli", "127.0.0.1:9", &headers, b"{}");
        let text = String::from_utf8(req).unwrap();
        assert!(text.starts_with("POST /cli HTTP/1.1\r\n"));
        assert!(text.contains("\r\nX-Bashboard-Token: tok\r\n"));
        assert!(text.contains("\r\nX-Bashboard-Pane: 3\r\n"));
        assert!(text.contains("\r\nContent-Type: application/json\r\n"));
        assert!(text.contains("\r\nContent-Length: 2\r\n"));
        assert!(text.ends_with("\r\nConnection: close\r\n\r\n{}"));
    }

    #[test]
    fn response_parsing() {
        let (status, body) = parse_response(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap();
        assert_eq!((status, &*body), (204, &b""[..]));
        let raw = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 9\r\n\r\n{\"a\":1}\r\n";
        assert_eq!(&*parse_response(raw).unwrap().1, b"{\"a\":1}\r\n");
        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
            4\r\n{\"a\"\r\na;ext=1\r\n:\"0123456\"\r\n1\r\n}\r\n0\r\n\r\n";
        let (status, body) = parse_response(chunked).unwrap();
        assert_eq!((status, &*body), (200, &b"{\"a\":\"0123456\"}"[..]));
        let cut = b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n10\r\nshort";
        assert!(parse_response(cut).is_none());
        assert!(parse_response(b"garbage").is_none());
        assert!(parse_response(b"FTP 200 ok\r\n\r\n").is_none());
    }

    #[test]
    fn answers() {
        assert!(answer(b"HTTP/1.1 204 No Content\r\n\r\n").is_ok());
        let e =
            answer(b"HTTP/1.1 400 Bad Request\r\n\r\n{\"error\":\"no such file\"}").unwrap_err();
        assert_eq!(e, "no such file");
        let e = answer(b"HTTP/1.1 400 Bad Request\r\n\r\nplain words\n").unwrap_err();
        assert_eq!(e, "plain words");
        assert_eq!(
            answer(b"HTTP/1.1 403 Forbidden\r\n\r\n").unwrap_err(),
            "Bashboard rejected the token"
        );
        assert_eq!(
            answer(b"HTTP/1.1 404 Not Found\r\n\r\n").unwrap_err(),
            "this pane is not known to Bashboard"
        );
        assert_eq!(
            answer(b"HTTP/1.1 413 Too Large\r\n\r\n").unwrap_err(),
            "input is over 1 MiB"
        );
        assert_eq!(
            answer(b"HTTP/1.1 500 Oops\r\n\r\n").unwrap_err(),
            "Bashboard answered 500"
        );
    }

    fn ci_args(args: &[&str]) -> Result<CiArgs, String> {
        parse_ci(&strings(args))
    }

    #[test]
    fn ci_subcommands_and_flags() {
        let a = ci_args(&[]).unwrap();
        assert_eq!((a.op, a.json, a.branch), (CiOp::Status, false, None));
        let a = ci_args(&["--branch", "dev", "--json"]).unwrap();
        assert_eq!((a.op, a.json, a.branch.as_deref()), (CiOp::Status, true, Some("dev")));
        let a = ci_args(&["wait", "--interval", "3", "--timeout=1m"]).unwrap();
        assert_eq!(a.op, CiOp::Wait);
        assert_eq!(a.interval, MIN_INTERVAL);
        assert_eq!(a.timeout, Duration::from_secs(60));
        let a = ci_args(&["wait"]).unwrap();
        assert_eq!((a.interval, a.timeout), (DEFAULT_INTERVAL, DEFAULT_TIMEOUT));
        let a = ci_args(&["log", "--run", "7", "--job", "9"]).unwrap();
        assert_eq!((a.run.as_deref(), a.job.as_deref()), (Some("7"), Some("9")));
        let a = ci_args(&["rerun", "--failed", "--run", "7"]).unwrap();
        assert!(a.failed);
        assert_eq!(ci_args(&["cancel"]).unwrap().op, CiOp::Cancel);

        assert!(ci_args(&["frob"]).unwrap_err().contains("unknown ci command"));
        assert!(ci_args(&["--wat"]).unwrap_err().contains("unknown option"));
        assert!(ci_args(&["status", "--run", "1"]).unwrap_err().contains("does not apply"));
        assert!(ci_args(&["cancel", "--failed"]).unwrap_err().contains("does not apply"));
        assert!(ci_args(&["log", "--timeout", "1m"]).is_err());
        assert_eq!(ci_args(&["log", "--job", "9"]).unwrap_err(), "--job needs --run");
        assert!(ci_args(&["--branch"]).unwrap_err().contains("needs a value"));
        assert!(ci_args(&["--branch", "--json"]).unwrap_err().contains("needs a value"));
        assert!(ci_args(&["--json=yes"]).unwrap_err().contains("takes no value"));
        assert!(ci_args(&["wait", "--timeout", "soon"]).is_err());
    }

    #[test]
    fn durations() {
        let secs = |t: &str| parse_duration(t).map(|d| d.as_secs());
        assert_eq!(secs("90"), Ok(90));
        assert_eq!(secs("90s"), Ok(90));
        assert_eq!(secs("30m"), Ok(1800));
        assert_eq!(secs("1h30m"), Ok(5400));
        assert_eq!(secs("2h"), Ok(7200));
        for bad in ["", "m", "1d", "-5", "0", "0m", "1.5m"] {
            assert!(parse_duration(bad).is_err(), "{bad}");
        }
        assert_eq!(format_duration(45), "45s");
        assert_eq!(format_duration(133), "2m 13s");
        assert_eq!(format_duration(3840), "1h 4m");
    }

    #[test]
    fn ci_bodies() {
        let body = |args: &[&str]| -> serde_json::Value {
            serde_json::from_slice(&ci_body(&ci_args(args).unwrap(), "/r")).unwrap()
        };
        assert_eq!(body(&[]), serde_json::json!({ "op": "status", "cwd": "/r" }));
        assert_eq!(
            body(&["wait", "--branch", "dev"]),
            serde_json::json!({ "op": "status", "cwd": "/r", "branch": "dev" })
        );
        assert_eq!(body(&["log"]), serde_json::json!({ "op": "failed", "cwd": "/r" }));
        assert_eq!(
            body(&["log", "--run", "1"]),
            serde_json::json!({ "op": "failed", "cwd": "/r", "runId": "1" })
        );
        assert_eq!(
            body(&["log", "--run", "1", "--job", "2"]),
            serde_json::json!({ "op": "log", "cwd": "/r", "runId": "1", "jobId": "2" })
        );
        assert_eq!(
            body(&["rerun", "--failed"]),
            serde_json::json!({ "op": "rerun", "cwd": "/r", "failedOnly": true })
        );
        assert_eq!(body(&["cancel"]), serde_json::json!({ "op": "cancel", "cwd": "/r" }));
    }

    #[test]
    fn pr_arguments() {
        assert_eq!(parse_pr(&strings(&["size"])), Ok(false));
        assert_eq!(parse_pr(&strings(&["size", "--json"])), Ok(true));
        assert!(parse_pr(&strings(&["size", "--branch"])).unwrap_err().contains("unknown option"));
        assert!(parse_pr(&strings(&["size", "--json", "--json"])).is_err());
        assert!(parse_pr(&strings(&["merge"])).unwrap_err().starts_with("unknown pr command"));
        assert_eq!(parse_pr(&[]), Err(PR_USAGE.to_string()));
        assert_eq!(parse_pr(&strings(&["--help"])), Err(PR_USAGE.to_string()));
    }

    fn size(lines: u64, comparison: Option<&str>, threshold: u64) -> serde_json::Value {
        serde_json::json!({
            "size": {
                "worktree": "/r",
                "branch": "feature",
                "comparison": comparison,
                "lines": lines,
                "added": lines,
                "removed": 0,
                "files": 14,
                "excludedLines": 210,
                "excludedFiles": 6,
            },
            "threshold": threshold,
        })
    }

    #[test]
    fn size_lines() {
        assert_eq!(
            size_line(&size(512, Some("origin/main"), 400)),
            "512 lines in 14 files against origin/main (threshold 400; tests, lockfiles, and generated files excluded: 210 lines in 6 files)"
        );
        let mut one = size(1, Some("main"), 0);
        one["size"]["files"] = 1.into();
        one["size"]["excludedLines"] = 0.into();
        one["size"]["excludedFiles"] = 0.into();
        assert_eq!(
            size_line(&one),
            "1 line in 1 file against main (threshold off; tests, lockfiles, and generated files excluded: 0 lines in 0 files)"
        );
        assert_eq!(
            size_line(&size(0, None, 400)),
            "No comparison ref, so the branch size is not measured (threshold 400)."
        );
    }

    #[test]
    fn size_threshold_is_strictly_over() {
        assert!(over_threshold(&size(401, Some("origin/main"), 400)));
        assert!(!over_threshold(&size(400, Some("origin/main"), 400)));
        assert!(!over_threshold(&size(9000, Some("origin/main"), 0)));
        assert!(!over_threshold(&size(9000, None, 400)));
    }

    #[test]
    fn ci_answers() {
        let ok = ci_answer(b"HTTP/1.1 200 OK\r\n\r\n{\"runId\":\"5\"}").unwrap();
        assert_eq!(ok["runId"], "5");
        let refused =
            ci_answer(b"HTTP/1.1 403 Forbidden\r\n\r\n{\"error\":\"set ship.cliWrites\"}")
                .unwrap_err();
        assert_eq!(
            refused,
            CiError { message: "set ship.cliWrites".into(), transient: false }
        );
        let token =
            ci_answer(b"HTTP/1.1 403 Forbidden\r\n\r\n{\"error\":\"bad Bashboard token\"}")
                .unwrap_err();
        assert_eq!(token.message, "bad Bashboard token");
        let none = ci_answer(b"HTTP/1.1 404 Not Found\r\n\r\n{\"error\":\"No run on dev.\"}")
            .unwrap_err();
        assert!(!none.transient);
        let forge = ci_answer(
            b"HTTP/1.1 502 Bad Gateway\r\n\r\n{\"error\":\"rate limited\",\"kind\":\"rateLimited\"}",
        )
        .unwrap_err();
        assert_eq!(forge, CiError { message: "rate limited".into(), transient: true });
        assert_eq!(
            ci_answer(b"HTTP/1.1 500 Oops\r\n\r\n").unwrap_err().message,
            "Bashboard answered 500"
        );
        assert!(ci_answer(b"garbage").unwrap_err().transient);
    }

    fn status(runs: &[(&str, &str)], pull: Option<&str>) -> serde_json::Value {
        let runs: Vec<_> = runs
            .iter()
            .map(|(name, s)| serde_json::json!({ "name": name, "status": s, "webUrl": "" }))
            .collect();
        serde_json::json!({
            "repo": { "owner": "o", "name": "r", "webUrl": "https://h/o/r" },
            "branch": "dev",
            "headSha": "abcdef1234",
            "runs": runs,
            "pull": pull.map(|s| serde_json::json!({
                "number": 4, "state": s, "title": "T", "webUrl": "u", "draft": false
            })),
        })
    }

    const MIN: Duration = Duration::from_secs(60);
    const LONG: Duration = Duration::from_secs(30 * 60);

    fn code(v: Verdict) -> Option<u8> {
        match v {
            Verdict::Continue => None,
            Verdict::Stop(c, _) => Some(c),
        }
    }

    #[test]
    fn wait_passes_when_every_run_is_final_and_none_failed() {
        let mut s = WaitState::default();
        let v = status(&[("ci", "success"), ("lint", "skipped"), ("x", "other")], Some("open"));
        assert_eq!(code(decide(&mut s, Ok(&v), MIN, LONG)), Some(0));
    }

    #[test]
    fn wait_keeps_going_while_any_run_is_unfinished() {
        let mut s = WaitState::default();
        for unfinished in ["queued", "running", "waiting"] {
            let v = status(&[("ci", "failure"), ("lint", unfinished)], None);
            assert_eq!(decide(&mut s, Ok(&v), MIN, LONG), Verdict::Continue, "{unfinished}");
        }
    }

    #[test]
    fn wait_fails_on_a_failed_or_cancelled_run() {
        for bad in ["failure", "cancelled"] {
            let mut s = WaitState::default();
            let v = status(&[("ci", bad), ("lint", "success")], None);
            match decide(&mut s, Ok(&v), MIN, LONG) {
                Verdict::Stop(1, why) => assert!(why.contains(&format!("ci ({bad})")), "{why}"),
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn wait_follows_the_pull_request() {
        let mut s = WaitState::default();
        let v = status(&[("ci", "running")], Some("merged"));
        assert_eq!(code(decide(&mut s, Ok(&v), MIN, LONG)), Some(0));
        let v = status(&[("ci", "running")], Some("closed"));
        assert_eq!(code(decide(&mut s, Ok(&v), MIN, LONG)), Some(2));
    }

    #[test]
    fn wait_gives_up_when_no_run_appears_on_the_head() {
        let mut s = WaitState::default();
        let empty = status(&[], None);
        assert_eq!(decide(&mut s, Ok(&empty), MIN, LONG), Verdict::Continue);
        assert_eq!(decide(&mut s, Ok(&empty), MIN * 5, LONG), Verdict::Continue);
        assert_eq!(code(decide(&mut s, Ok(&empty), MIN * 6, LONG)), Some(2));
        // A new head (a push during the wait) restarts the five minutes.
        let mut s = WaitState::default();
        assert_eq!(decide(&mut s, Ok(&empty), MIN, LONG), Verdict::Continue);
        let mut pushed = empty.clone();
        pushed["headSha"] = "9999999".into();
        assert_eq!(decide(&mut s, Ok(&pushed), MIN * 4, LONG), Verdict::Continue);
        assert_eq!(decide(&mut s, Ok(&pushed), MIN * 8, LONG), Verdict::Continue);
        assert_eq!(code(decide(&mut s, Ok(&pushed), MIN * 9, LONG)), Some(2));
    }

    #[test]
    fn wait_gives_up_after_eight_failed_reads_in_a_row() {
        let mut s = WaitState::default();
        let good = status(&[("ci", "running")], None);
        for _ in 0..7 {
            assert_eq!(decide(&mut s, Err("boom"), MIN, LONG), Verdict::Continue);
        }
        // A good read resets the count.
        assert_eq!(decide(&mut s, Ok(&good), MIN, LONG), Verdict::Continue);
        for _ in 0..7 {
            assert_eq!(decide(&mut s, Err("boom"), MIN, LONG), Verdict::Continue);
        }
        match decide(&mut s, Err("boom"), MIN, LONG) {
            Verdict::Stop(2, why) => assert!(why.contains("boom"), "{why}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn wait_times_out() {
        let mut s = WaitState::default();
        let v = status(&[("ci", "running")], Some("open"));
        assert_eq!(decide(&mut s, Ok(&v), MIN * 29, LONG), Verdict::Continue);
        match decide(&mut s, Ok(&v), LONG, LONG) {
            Verdict::Stop(2, why) => assert!(why.contains("timed out after 30m 0s"), "{why}"),
            other => panic!("{other:?}"),
        }
        // A settled read on the last poll still wins over the timeout.
        let done = status(&[("ci", "success")], None);
        assert_eq!(code(decide(&mut s, Ok(&done), LONG, LONG)), Some(0));
    }

    #[test]
    fn summaries_and_status_text() {
        let v = status(&[("ci", "running"), ("lint", "success")], Some("open"));
        assert_eq!(status_summary(&v), "abcdef1: ci running, lint success; PR #4 open");
        assert_eq!(status_summary(&status(&[], None)), "abcdef1: no runs yet");

        let mut v = status(&[("build", "success"), ("ci", "running")], Some("open"));
        v["runs"][0]["startedAt"] = "2026-11-12T10:00:00Z".into();
        v["runs"][0]["finishedAt"] = "2026-11-12T10:02:13Z".into();
        v["runs"][0]["webUrl"] = "https://h/run/1".into();
        v["runs"][1]["createdAt"] = "2026-11-12T10:00:00Z".into();
        let now = iso_secs("2026-11-12T10:00:45Z").unwrap();
        assert_eq!(
            render_status(&v, now),
            "o/r  https://h/o/r\n\
             branch dev at abcdef1\n  \
             success    build  2m 13s   https://h/run/1\n  \
             running    ci     45s\n\
             PR #4 (open): T  u\n"
        );
        let text = render_status(&status(&[], None), now);
        assert!(text.contains("no runs on this commit"));
        assert!(text.ends_with("no pull request from this branch\n"));
    }

    #[test]
    fn iso_times() {
        assert_eq!(iso_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_secs("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(iso_secs("2026-11-12T10:00:00.1234567Z"), iso_secs("2026-11-12T10:00:00Z"));
        assert_eq!(
            iso_secs("2026-11-12T12:00:00+02:00"),
            iso_secs("2026-11-12T10:00:00Z")
        );
        assert_eq!(iso_secs("2026-11-12T05:00:00-0500"), iso_secs("2026-11-12T10:00:00"));
        assert_eq!(iso_secs("not a time"), None);
        assert_eq!(iso_secs("2026-11-12T10:00:00+2"), None);
        // A final run without an end time has no duration to show.
        let r = serde_json::json!({ "status": "success", "startedAt": "2026-11-12T10:00:00Z" });
        assert_eq!(run_duration(&r, 0), "-");
    }

    #[test]
    fn write_messages() {
        let m = |args: &[&str]| write_message(&ci_args(args).unwrap(), "5");
        assert_eq!(m(&["rerun"]), "Re-running run 5.");
        assert_eq!(m(&["rerun", "--failed"]), "Re-running the failed jobs of run 5.");
        assert_eq!(m(&["cancel"]), "Canceled run 5.");
    }

    #[test]
    fn skill_marker() {
        assert!(is_bashboard_skill(SKILL));
        assert!(is_bashboard_skill("---\r\nname: x\r\nbashboard-skill: true\r\n---\r\nbody"));
        assert!(!is_bashboard_skill("---\nname: x\n---\nbashboard-skill: true\n"));
        assert!(!is_bashboard_skill("name: x\nbashboard-skill: true\n"));
        assert!(!is_bashboard_skill("---\nbashboard-skill: false\n---\n"));
    }

    #[test]
    fn skill_install_writes_and_refuses_foreign_files() {
        let home = std::env::temp_dir().join(format!("bb-skill-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let path = home.join(".claude/skills/bashboard/SKILL.md");
        assert!(install_skill(&home).unwrap().starts_with("Installed"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SKILL);
        assert!(install_skill(&home).unwrap().contains("already up to date"));
        // An older copy of ours is replaced.
        std::fs::write(&path, "---\nbashboard-skill: true\n---\nold").unwrap();
        assert!(install_skill(&home).unwrap().starts_with("Installed"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), SKILL);
        // Someone else's is left alone.
        std::fs::write(&path, "---\nname: bashboard\n---\nmine").unwrap();
        assert!(install_skill(&home).unwrap_err().contains("bashboard-skill: true"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\nname: bashboard\n---\nmine");
        let _ = std::fs::remove_dir_all(&home);
    }
}
