//! The failure report: a failed CI run's jobs, failed steps, and log excerpts, rendered as a
//! prompt asking an agent to fix the cause (docs/design/ship.md section 3.23). Logs come
//! through a closure so the report builds and renders without a host.

use super::diagnostic;
use super::types::{ForgeError, Job, JobLog, Run, RunStatus};

/// The most failed jobs a report carries; the rest are counted, not shown.
pub const MAX_JOBS: usize = 5;
/// The most log lines a job's excerpt carries.
pub const MAX_LOG_LINES: usize = 150;

#[derive(Debug, Clone, PartialEq)]
pub struct FailedJob {
    pub name: String,
    pub failed_steps: Vec<String>,
    pub web_url: Option<String>,
    /// The excerpt, or the reason the log could not be loaded.
    pub log: Result<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FailureReport {
    pub repo: String,
    pub branch: Option<String>,
    pub run_name: String,
    pub run_url: String,
    pub sha: Option<String>,
    pub jobs: Vec<FailedJob>,
    /// Every failed job in the run, including those past `MAX_JOBS`.
    pub failed_total: usize,
}

impl FailureReport {
    /// `fetch_log` takes a job id; it is called only for the jobs the report shows.
    pub fn build(
        repo: &str,
        run: &Run,
        jobs: &[Job],
        fetch_log: impl Fn(&str) -> Result<JobLog, ForgeError>,
    ) -> Self {
        let failed: Vec<&Job> = jobs
            .iter()
            .filter(|j| j.status == RunStatus::Failure)
            .collect();
        let shown = failed
            .iter()
            .take(MAX_JOBS)
            .map(|job| FailedJob {
                name: job.name.clone(),
                failed_steps: job
                    .steps
                    .iter()
                    .filter(|s| s.status == RunStatus::Failure)
                    .map(|s| s.name.clone())
                    .collect(),
                web_url: job.web_url.clone(),
                log: fetch_log(&job.id)
                    .map(|log| diagnostic::excerpt(&log.text, MAX_LOG_LINES))
                    .map_err(|e| e.message),
            })
            .collect();
        Self {
            repo: repo.to_string(),
            branch: run.branch.clone(),
            run_name: run.name.clone(),
            run_url: run.web_url.clone(),
            sha: run.sha.clone(),
            jobs: shown,
            failed_total: failed.len(),
        }
    }
}

/// A fence longer than any backtick run in `body`, so a log holding ``` cannot close it.
fn fence(body: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in body.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    "`".repeat((longest + 1).max(3))
}

pub fn render(report: &FailureReport) -> String {
    let mut out = String::new();
    let branch = report
        .branch
        .as_deref()
        .map(|b| format!(" on branch {b}"))
        .unwrap_or_default();
    out.push_str(&format!("CI failed for {}{branch}.\n", report.repo));
    out.push_str(&format!("Run: {} ({})\n", report.run_name, report.run_url));
    if let Some(sha) = &report.sha {
        out.push_str(&format!("Commit: {sha}\n"));
    }
    if report.jobs.is_empty() {
        out.push_str("\nThe host reported no failed jobs for this run.\n");
    } else if report.failed_total > report.jobs.len() {
        out.push_str(&format!(
            "\nShowing {} of {} failed jobs.\n",
            report.jobs.len(),
            report.failed_total
        ));
    }
    for job in &report.jobs {
        out.push_str(&format!("\n## Failed job: {}\n", job.name));
        if !job.failed_steps.is_empty() {
            out.push_str(&format!("Failed steps: {}\n", job.failed_steps.join(", ")));
        }
        if let Some(url) = &job.web_url {
            out.push_str(&format!("Link: {url}\n"));
        }
        match &job.log {
            Ok(text) if text.is_empty() => out.push_str("(log empty)\n"),
            Ok(text) => {
                let f = fence(text);
                out.push_str(&format!("Log excerpt:\n{f}\n{text}\n{f}\n"));
            }
            Err(message) => out.push_str(&format!("(log unavailable: {message})\n")),
        }
    }
    out.push_str("\nFind the cause of this CI failure and fix it.\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::types::Step;

    fn run() -> Run {
        Run {
            id: "42".into(),
            number: Some(7),
            name: "CI".into(),
            title: "Fix things".into(),
            branch: Some("main".into()),
            sha: Some("abc123".into()),
            event: None,
            status: RunStatus::Failure,
            raw_status: "failure".into(),
            actor: None,
            created_at: "2024-05-01T12:00:00Z".into(),
            started_at: None,
            finished_at: None,
            web_url: "https://example.com/run/42".into(),
        }
    }

    fn job(id: &str, status: RunStatus) -> Job {
        Job {
            id: id.into(),
            name: format!("job {id}"),
            status,
            started_at: None,
            finished_at: None,
            web_url: Some(format!("https://example.com/job/{id}")),
            steps: vec![
                Step {
                    number: 1,
                    name: "checkout".into(),
                    status: RunStatus::Success,
                },
                Step {
                    number: 2,
                    name: "test".into(),
                    status: RunStatus::Failure,
                },
            ],
        }
    }

    fn ok_log(_: &str) -> Result<JobLog, ForgeError> {
        Ok(JobLog::new("setup\nerror: boom\n".into(), false))
    }

    #[test]
    fn caps_at_five_failed_jobs_and_skips_passing_ones() {
        let mut jobs: Vec<Job> = (0..7)
            .map(|i| job(&i.to_string(), RunStatus::Failure))
            .collect();
        jobs.insert(0, job("ok", RunStatus::Success));
        let fetched = std::cell::RefCell::new(Vec::new());
        let report = FailureReport::build("o/r", &run(), &jobs, |id| {
            fetched.borrow_mut().push(id.to_string());
            ok_log(id)
        });
        assert_eq!(report.jobs.len(), MAX_JOBS);
        assert_eq!(report.failed_total, 7);
        assert_eq!(report.jobs[0].name, "job 0");
        assert_eq!(fetched.borrow().len(), MAX_JOBS);
        assert!(render(&report).contains("Showing 5 of 7 failed jobs."));
    }

    #[test]
    fn unavailable_log_keeps_the_job() {
        let jobs = vec![job("1", RunStatus::Failure)];
        let report = FailureReport::build("o/r", &run(), &jobs, |_| {
            Err(ForgeError::other("rate limited"))
        });
        let text = render(&report);
        assert!(text.contains("## Failed job: job 1"));
        assert!(text.contains("(log unavailable: rate limited)"));
    }

    #[test]
    fn renders_header_jobs_and_closing_ask() {
        let jobs = vec![job("1", RunStatus::Failure)];
        let text = render(&FailureReport::build("o/r", &run(), &jobs, ok_log));
        let expected = "CI failed for o/r on branch main.\n\
                        Run: CI (https://example.com/run/42)\n\
                        Commit: abc123\n\
                        \n\
                        ## Failed job: job 1\n\
                        Failed steps: test\n\
                        Link: https://example.com/job/1\n\
                        Log excerpt:\n\
                        ```\n\
                        setup\n\
                        error: boom\n\
                        ```\n\
                        \n\
                        Find the cause of this CI failure and fix it.\n";
        assert_eq!(text, expected);
    }

    #[test]
    fn fence_outgrows_backticks_in_the_log() {
        assert_eq!(fence("plain"), "```");
        assert_eq!(fence("a ```` b"), "`````");
    }
}
