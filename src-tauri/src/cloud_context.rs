//! Machine-wide Azure context for the cloud chip (docs/design/terminal.md section 3.26): the
//! default subscription from `azureProfile.json`, read once at startup and re-read when the file
//! changes. It never polls and never runs `az`.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::lock::LockExt;

const PROFILE_FILE: &str = "azureProfile.json";
/// `az login` rewrites the file in several steps, so a burst is coalesced into one re-read.
const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AzureContext {
    pub name: String,
    pub id: String,
    pub user: Option<String>,
}

#[derive(Default)]
pub struct CloudState {
    current: Mutex<Option<AzureContext>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Deserialize)]
struct Profile {
    #[serde(default)]
    subscriptions: Vec<Subscription>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    is_default: bool,
    user: Option<SubscriptionUser>,
}

#[derive(Deserialize)]
struct SubscriptionUser {
    name: Option<String>,
}

/// The default subscription in an `azureProfile.json` body. `az` writes the file as UTF-8 with a
/// BOM, which `serde_json` rejects, so it is stripped first. Anything unparseable, or a profile
/// with no default subscription, is `None`: a missing login is not an error.
fn parse_profile(bytes: &[u8]) -> Option<AzureContext> {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let profile: Profile = serde_json::from_slice(bytes).ok()?;
    let sub = profile.subscriptions.into_iter().find(|s| s.is_default)?;
    Some(AzureContext {
        name: sub.name,
        id: sub.id,
        user: sub.user.and_then(|u| u.name).filter(|n| !n.is_empty()),
    })
}

/// `AZURE_CONFIG_DIR` when set and non-empty, else `<home>/.azure`.
fn config_dir(env_dir: Option<OsString>, home: Option<PathBuf>) -> Option<PathBuf> {
    match env_dir.filter(|d| !d.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => home.map(|h| h.join(".azure")),
    }
}

fn read_profile(dir: &Path) -> Option<AzureContext> {
    parse_profile(&std::fs::read(dir.join(PROFILE_FILE)).ok()?)
}

/// Whether a directory event could mean the profile changed. Errs toward yes for events with no
/// path or a buffer overflow, since a spurious re-read is cheap and the emit is deduplicated.
fn event_may_touch(ev: &notify::Result<notify::Event>) -> bool {
    let Ok(ev) = ev else {
        return true;
    };
    if ev.need_rescan() || ev.paths.is_empty() {
        return true;
    }
    ev.paths.iter().any(|p| match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.eq_ignore_ascii_case(PROFILE_FILE),
        None => true,
    })
}

/// Loads the context and watches the config folder. The folder is watched rather than the file
/// because `az` replaces the file. If the folder does not exist yet nothing is watched, so a
/// first `az login` after launch shows the badge only after an app restart; polling for the
/// folder is not worth its cost.
pub fn init(app: &AppHandle) {
    let state = app.state::<CloudState>();
    let home = app.path().home_dir().ok();
    let Some(dir) = config_dir(std::env::var_os("AZURE_CONFIG_DIR"), home) else {
        return;
    };
    *state.current.lock_or_recover() = read_profile(&dir);
    if !dir.is_dir() {
        return;
    }
    match watch_dir(app.clone(), dir.clone()) {
        Ok(watcher) => *state.watcher.lock_or_recover() = Some(watcher),
        Err(e) => eprintln!("cloud: could not watch {}: {e}", dir.display()),
    }
}

fn watch_dir(app: AppHandle, dir: PathBuf) -> notify::Result<RecommendedWatcher> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx)?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            if !event_may_touch(&ev) {
                continue;
            }
            while rx.recv_timeout(DEBOUNCE).is_ok() {}
            let next = read_profile(&dir);
            let state = app.state::<CloudState>();
            {
                let mut current = state.current.lock_or_recover();
                if *current == next {
                    continue;
                }
                *current = next.clone();
            }
            let _ = app.emit("cloud://azure", next);
        }
    });
    Ok(watcher)
}

#[tauri::command]
pub fn azure_context(state: State<'_, CloudState>) -> Option<AzureContext> {
    state.current.lock_or_recover().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &str = r#"{
        "installationId": "x",
        "subscriptions": [
            { "id": "aaa", "name": "Dev", "isDefault": false, "user": { "name": "a@x.com", "type": "user" } },
            { "id": "bbb", "name": "Prod One", "isDefault": true, "user": { "name": "b@x.com", "type": "user" } }
        ]
    }"#;

    #[test]
    fn picks_the_default_of_two() {
        assert_eq!(
            parse_profile(TWO.as_bytes()),
            Some(AzureContext { name: "Prod One".into(), id: "bbb".into(), user: Some("b@x.com".into()) })
        );
    }

    #[test]
    fn strips_a_bom() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(TWO.as_bytes());
        assert_eq!(parse_profile(&bytes).map(|c| c.id), Some("bbb".into()));
    }

    #[test]
    fn no_default_is_none() {
        let json = r#"{ "subscriptions": [ { "id": "a", "name": "A", "isDefault": false } ] }"#;
        assert_eq!(parse_profile(json.as_bytes()), None);
        assert_eq!(parse_profile(br#"{ "subscriptions": [] }"#), None);
    }

    #[test]
    fn missing_user_is_none_user() {
        let json = r#"{ "subscriptions": [ { "id": "a", "name": "A", "isDefault": true } ] }"#;
        assert_eq!(
            parse_profile(json.as_bytes()),
            Some(AzureContext { name: "A".into(), id: "a".into(), user: None })
        );
    }

    #[test]
    fn garbage_is_none() {
        assert_eq!(parse_profile(b""), None);
        assert_eq!(parse_profile(b"not json"), None);
        assert_eq!(parse_profile(b"[1,2]"), None);
        assert_eq!(parse_profile(&[0xEF, 0xBB, 0xBF]), None);
    }

    #[test]
    fn serializes_camel_case_with_null_user() {
        let ctx = AzureContext { name: "A".into(), id: "a".into(), user: None };
        assert_eq!(serde_json::to_string(&ctx).unwrap(), r#"{"name":"A","id":"a","user":null}"#);
    }

    #[test]
    fn env_dir_wins_over_home() {
        let home = Some(PathBuf::from("/h"));
        assert_eq!(config_dir(Some("/c".into()), home.clone()), Some(PathBuf::from("/c")));
        assert_eq!(config_dir(Some("".into()), home.clone()), Some(PathBuf::from("/h/.azure")));
        assert_eq!(config_dir(None, home), Some(PathBuf::from("/h/.azure")));
        assert_eq!(config_dir(None, None), None);
    }

    #[test]
    fn events_filter_to_the_profile() {
        let ev = |p: &str| Ok(notify::Event::new(notify::EventKind::Any).add_path(PathBuf::from(p)));
        assert!(event_may_touch(&ev("/h/.azure/azureProfile.json")));
        assert!(event_may_touch(&ev("/h/.azure/AZUREPROFILE.JSON")));
        assert!(!event_may_touch(&ev("/h/.azure/msal_token_cache.json")));
        assert!(event_may_touch(&Ok(notify::Event::new(notify::EventKind::Any))));
    }
}
