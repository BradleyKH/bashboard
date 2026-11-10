//! Watches a served HTML file so its pane can reload (docs/design/browser.md section 3.21, Changes
//! on disk).

use std::{path::Path, sync::mpsc, thread, time::Duration};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Generators often write a file in several steps, so a burst is coalesced into one change.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// Watches `file` and calls `on_change` once per burst of events that could have changed it. The
/// folder is watched rather than the file because a replace (an editor's save, a generator writing
/// a temp file and renaming it) swaps the file out from under a file-level watch. Dropping the
/// returned watcher ends the watch and its thread.
pub fn watch_file(
    file: &Path,
    on_change: impl Fn() + Send + 'static,
) -> notify::Result<RecommendedWatcher> {
    let dir = file.parent().map(Path::to_path_buf).unwrap_or_default();
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    let file = file.to_path_buf();
    thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            if !event_may_touch(&ev, &file) {
                continue;
            }
            while rx.recv_timeout(DEBOUNCE).is_ok() {}
            on_change();
        }
    });
    Ok(watcher)
}

/// Whether a folder event could mean `file` changed. Errs toward yes, since a spurious event only
/// reloads the page. ReadDirectoryChangesW may name a file by its 8.3 alias (`REPORT~1.HTM`) or in
/// another case, and a buffer overflow arrives with no paths or with the folder itself as path.
fn event_may_touch(ev: &notify::Result<notify::Event>, file: &Path) -> bool {
    let Ok(ev) = ev else {
        return true;
    };
    if ev.need_rescan() || ev.paths.is_empty() {
        return true;
    }
    let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
        return true;
    };
    let alias_prefix = name
        .split('.')
        .next()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(6)
        .collect::<String>()
        .to_ascii_uppercase();
    let dir = file.parent();
    ev.paths
        .iter()
        .any(|p| match p.file_name().and_then(|n| n.to_str()) {
            None => true,
            Some(_) if Some(p.as_path()) == dir => true,
            Some(n) => {
                n.eq_ignore_ascii_case(name)
                    || (n.contains('~') && n.to_ascii_uppercase().starts_with(&alias_prefix))
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc::RecvTimeoutError;

    fn event(paths: &[&str]) -> notify::Result<notify::Event> {
        let mut ev = notify::Event::new(notify::EventKind::Any);
        for p in paths {
            ev = ev.add_path(PathBuf::from(p));
        }
        Ok(ev)
    }

    #[test]
    fn matches_the_file_and_its_aliases_only() {
        let file = Path::new("C:/site/report.html");
        assert!(event_may_touch(&event(&["C:/site/report.html"]), file));
        assert!(event_may_touch(&event(&["C:/site/REPORT.HTML"]), file));
        assert!(event_may_touch(&event(&["C:/site/REPORT~1.HTM"]), file));
        assert!(event_may_touch(&event(&[]), file));
        assert!(event_may_touch(&event(&["C:/site"]), file));
        assert!(!event_may_touch(&event(&["C:/site/style.css"]), file));
        assert!(!event_may_touch(&event(&["C:/site/report.html.tmp"]), file));
    }

    #[test]
    fn fires_once_per_burst() {
        let dir =
            std::env::temp_dir().join(format!("bashboard-browser-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("page.html");
        std::fs::write(&file, "<p>1</p>").unwrap();
        let (tx, rx) = mpsc::channel::<()>();
        let _watcher = watch_file(&file, move || {
            let _ = tx.send(());
        })
        .unwrap();
        thread::sleep(Duration::from_millis(100));
        for i in 0..3 {
            std::fs::write(&file, format!("<p>{i}</p>")).unwrap();
            thread::sleep(Duration::from_millis(50));
        }
        rx.recv_timeout(Duration::from_secs(5))
            .expect("no change seen");
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(600)),
            Err(RecvTimeoutError::Timeout),
            "one burst fired twice"
        );
        std::fs::write(dir.join("other.css"), "p{}").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(600)).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
