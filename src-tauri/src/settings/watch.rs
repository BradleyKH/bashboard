//! The hot-reload watcher on the settings file's folder.

use std::{
    path::Path,
    sync::mpsc,
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Watches `file` and calls `on_change` once per burst of events that could have changed it.
/// The folder is watched rather than the file because a replace (an editor's save, `sed -i`)
/// swaps the file out from under a file-level watch.
pub(super) fn watch_file(file: &Path, on_change: impl Fn() + Send + 'static) -> notify::Result<RecommendedWatcher> {
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
            // Coalesce the burst of events a single save produces.
            while rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
            on_change();
        }
    });
    Ok(watcher)
}

/// Whether a folder event could mean `file` changed. Errs toward yes, since a spurious reload
/// only re-reads the file while a missed one leaves stale settings until the next save.
/// ReadDirectoryChangesW may name a file by its 8.3 alias (`SETTIN~1.JSO`) or in another case,
/// and a buffer overflow arrives as an event with no paths or with the folder itself as path.
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
    ev.paths.iter().any(|p| match p.file_name().and_then(|n| n.to_str()) {
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

    use crate::settings::file::{reload, FILE_NAME};
    use crate::settings::model::Settings;

    fn event(kind: notify::EventKind, paths: &[&str]) -> notify::Result<notify::Event> {
        let mut ev = notify::Event::new(kind);
        for p in paths {
            ev = ev.add_path(PathBuf::from(p));
        }
        Ok(ev)
    }

    #[test]
    fn event_may_touch_matches_the_file_and_its_aliases() {
        use notify::event::{EventKind, Flag, ModifyKind, RenameMode};
        let file = Path::new("C:/cfg/settings.json");
        let any = EventKind::Any;
        assert!(event_may_touch(&event(any, &["C:/cfg/settings.json"]), file));
        assert!(event_may_touch(&event(any, &["C:/cfg/Settings.JSON"]), file));
        assert!(event_may_touch(&event(any, &["C:/cfg/SETTIN~1.JSO"]), file));
        let rename_to = EventKind::Modify(ModifyKind::Name(RenameMode::To));
        assert!(event_may_touch(&event(rename_to, &["C:/cfg/settings.json"]), file));
        let rename_both = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        assert!(event_may_touch(&event(rename_both, &["C:/cfg/sedAb12", "C:/cfg/settings.json"]), file));
        // Overflow and backend errors carry no usable path.
        assert!(event_may_touch(&event(any, &[]), file));
        assert!(event_may_touch(&event(any, &["C:/cfg"]), file));
        let rescan = notify::Event::new(any).add_path("C:/cfg/x".into()).set_flag(Flag::Rescan);
        assert!(event_may_touch(&Ok(rescan), file));
        assert!(event_may_touch(&Err(notify::Error::generic("boom")), file));

        assert!(!event_may_touch(&event(any, &["C:/cfg/workspace.json"]), file));
        assert!(!event_may_touch(&event(any, &["C:/cfg/settings.json.tmp"]), file));
        assert!(!event_may_touch(&event(any, &["C:/cfg/WORKSP~1.JSO"]), file));
        assert!(!event_may_touch(&event(any, &["C:/cfg/sedAb12"]), file));
    }

    /// Drives the real watcher through outside edits that replace or rewrite the file: a temp
    /// file renamed over it (`sed -i`, editors) and an in-place truncate and write (`cat >`),
    /// including a pause mid-write that splits the events into two bursts.
    #[test]
    fn watcher_fires_for_rename_over_and_truncate_overwrite() {
        use std::io::Write;
        use std::sync::mpsc::RecvTimeoutError;
        let dir = std::env::temp_dir().join(format!("bashboard-settings-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);
        std::fs::write(&path, r#"{ "scrollback": 1 }"#).unwrap();

        let (tx, rx) = mpsc::channel::<u32>();
        let read_path = path.clone();
        let _watcher = watch_file(&path, move || {
            let _ = tx.send(reload(&read_path, &Settings::default()).0.scrollback);
        })
        .unwrap();
        // Waits for the reload that sees `want`, skipping any made on a half-written file.
        let expect = |want: u32| loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(got) if got == want => break,
                Ok(_) => continue,
                Err(RecvTimeoutError::Timeout) => panic!("no reload saw scrollback {want}"),
                Err(e) => panic!("{e}"),
            }
        };

        let tmp = dir.join("sedXy12ab");
        std::fs::write(&tmp, r#"{ "scrollback": 2 }"#).unwrap();
        std::fs::remove_file(&path).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        expect(2);

        let tmp = dir.join("settings.json.tmp");
        std::fs::write(&tmp, r#"{ "scrollback": 3 }"#).unwrap();
        std::fs::rename(&tmp, &path).unwrap();
        expect(3);

        std::fs::write(&path, r#"{ "scrollback": 4 }"#).unwrap();
        expect(4);

        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(br#"{ "scrollback":"#).unwrap();
        f.flush().unwrap();
        thread::sleep(Duration::from_millis(400));
        f.write_all(b" 5 }").unwrap();
        drop(f);
        expect(5);

        thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        std::fs::write(dir.join("workspace.json"), "{}").unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(500)).is_err(), "an unrelated file triggered a reload");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
