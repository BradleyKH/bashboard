//! Installs the Bashboard hook script and registers it in Claude Code's `settings.json`
//! (design section 3.3). Everything works over a base directory so tests never touch the real
//! home; the Tauri commands resolve `~/.claude` and delegate.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::State;

use crate::profiles;
use crate::settings::SettingsState;

const SCRIPT: &str = include_str!("../../hooks/bashboard-hook.sh");
const SCRIPT_NAME: &str = "bashboard-hook.sh";
const COMMAND: &str = "bash ~/.claude/hooks/bashboard-hook.sh";
const EVENTS: [&str; 5] = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub settings_path: String,
    pub script_path: String,
    pub additions: Map<String, Value>,
    pub already_installed: bool,
    pub claude_detected: bool,
    /// The registered command runs through bash; without it every hook call fails.
    pub bash_found: bool,
}

fn claude_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|h| !h.is_empty()))
        .ok_or("could not find the home directory")?;
    Ok(PathBuf::from(home).join(".claude"))
}

fn settings_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("settings.json")
}

fn script_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("hooks").join(SCRIPT_NAME)
}

/// A missing file reads as an empty object; anything that is not a strict JSON object (or whose
/// `hooks` is not an object) is an error so we never rewrite a file we do not understand.
fn read_settings(path: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{} is not valid JSON ({e}); fix it and try again", path.display()))?;
    let Some(root) = value.as_object() else {
        return Err(format!("{} must contain a JSON object", path.display()));
    };
    match root.get("hooks") {
        None | Some(Value::Object(_)) => {}
        Some(_) => return Err(format!("\"hooks\" in {} must be an object", path.display())),
    }
    Ok(value)
}

fn has_bashboard_hook(groups: &[Value]) -> bool {
    groups.iter().any(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| {
                hooks.iter().any(|h| {
                    h.get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|c| c.contains(SCRIPT_NAME))
                })
            })
    })
}

fn group() -> Value {
    json!({ "hooks": [{ "type": "command", "command": COMMAND, "timeout": 5 }] })
}

/// The groups install would append, keyed by event; events already registered are omitted.
fn additions(settings: &Value) -> Result<Map<String, Value>, String> {
    let hooks = settings.get("hooks").and_then(Value::as_object);
    let mut out = Map::new();
    for event in EVENTS {
        let existing = match hooks.and_then(|h| h.get(event)) {
            None => None,
            Some(Value::Array(a)) => Some(a.as_slice()),
            Some(_) => return Err(format!("\"hooks.{event}\" in settings.json must be an array")),
        };
        if existing.is_some_and(has_bashboard_hook) {
            continue;
        }
        out.insert(event.to_string(), json!([group()]));
    }
    Ok(out)
}

fn merge(settings: &mut Value, additions: &Map<String, Value>) -> Result<(), String> {
    let root = settings.as_object_mut().ok_or("settings.json must contain a JSON object")?;
    if additions.is_empty() {
        return Ok(());
    }
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("\"hooks\" in settings.json must be an object")?;
    for (event, groups) in additions {
        let Some(new) = groups.as_array() else { continue };
        let slot = hooks.entry(event.clone()).or_insert_with(|| json!([]));
        slot.as_array_mut()
            .ok_or_else(|| format!("\"hooks.{event}\" in settings.json must be an array"))?
            .extend(new.iter().cloned());
    }
    Ok(())
}

/// Writes `<name>.tmp` then renames it over the target, so a crash never leaves a torn file.
pub(crate) fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Whether `bash.exe` sits in any directory of `path_var`.
fn bash_on_path(path_var: &OsStr) -> bool {
    std::env::split_paths(path_var).any(|dir| dir.join("bash.exe").is_file())
}

fn bash_available(shell: &crate::settings::Shell) -> bool {
    std::env::var_os("PATH").is_some_and(|p| bash_on_path(&p))
        || profiles::available_profiles(shell)
            .iter()
            .any(|p| p.id == profiles::GIT_BASH)
}

fn preview_in(claude_dir: &Path, bash_found: bool) -> Result<Preview, String> {
    let settings_path = settings_path(claude_dir);
    let script_path = script_path(claude_dir);
    let additions = additions(&read_settings(&settings_path)?)?;
    let script_current = std::fs::read_to_string(&script_path).is_ok_and(|s| s == SCRIPT);
    Ok(Preview {
        settings_path: settings_path.to_string_lossy().into_owned(),
        script_path: script_path.to_string_lossy().into_owned(),
        already_installed: additions.is_empty() && script_current,
        // Claude Code creates `~/.claude` on first run; without it there is nothing to hook.
        claude_detected: claude_dir.is_dir(),
        bash_found,
        additions,
    })
}

fn install_in(claude_dir: &Path, bash_found: bool) -> Result<(), String> {
    if !bash_found {
        return Err("Git for Windows is required: the hooks run through bash, which was not found.              Install Git for Windows, then try again."
            .into());
    }
    let settings_path = settings_path(claude_dir);
    // Validate before writing anything so a bad settings.json leaves the disk untouched.
    let mut settings = read_settings(&settings_path)?;
    let additions = additions(&settings)?;

    write_atomic(&script_path(claude_dir), SCRIPT)?;

    if additions.is_empty() {
        return Ok(());
    }
    merge(&mut settings, &additions)?;
    let mut text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    text.push('\n');
    write_atomic(&settings_path, &text)
}

#[tauri::command]
pub fn hooks_install_preview(settings: State<'_, SettingsState>) -> Result<Preview, String> {
    preview_in(&claude_dir()?, bash_available(&settings.current().shell))
}

#[tauri::command]
pub fn hooks_install(settings: State<'_, SettingsState>) -> Result<(), String> {
    install_in(&claude_dir()?, bash_available(&settings.current().shell))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bashboard-hook-install-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_json(dir: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap()
    }

    fn count_ours(settings: &Value, event: &str) -> usize {
        settings["hooks"][event]
            .as_array()
            .unwrap()
            .iter()
            .filter(|g| has_bashboard_hook(std::slice::from_ref(g)))
            .count()
    }

    const USER_SETTINGS: &str = r#"{
  "env": { "DUMMY": "x" },
  "permissions": { "allow": ["Bash(ls)"] },
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "toast.sh" }] },
      { "hooks": [{ "type": "command", "command": "bell.sh" }] }
    ]
  },
  "model": "m"
}"#;

    #[test]
    fn missing_settings_creates_all_five_events_and_script() {
        let dir = temp_dir("missing");
        let p = preview_in(&dir, true).unwrap();
        assert_eq!(p.additions.len(), 5);
        assert!(!p.already_installed);
        install_in(&dir, true).unwrap();
        let settings = read_json(&dir);
        for event in EVENTS {
            assert_eq!(count_ours(&settings, event), 1, "{event}");
        }
        assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0]["timeout"], 5);
        let script = std::fs::read_to_string(script_path(&dir)).unwrap();
        assert_eq!(script, SCRIPT);
        assert!(!script.contains('\r'));
        assert!(std::fs::read_to_string(dir.join("settings.json")).unwrap().ends_with('\n'));
    }

    #[test]
    fn existing_shape_is_preserved_and_one_group_appended_per_event() {
        let dir = temp_dir("shape");
        std::fs::write(dir.join("settings.json"), USER_SETTINGS).unwrap();
        install_in(&dir, true).unwrap();
        let settings = read_json(&dir);
        let keys: Vec<&String> = settings.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["env", "permissions", "hooks", "model"]);
        assert_eq!(settings["env"]["DUMMY"], "x");
        assert_eq!(settings["permissions"]["allow"][0], "Bash(ls)");
        let notif = settings["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 3);
        assert_eq!(notif[0]["hooks"][0]["command"], "toast.sh");
        assert_eq!(notif[1]["hooks"][0]["command"], "bell.sh");
        let hook_keys: Vec<&String> = settings["hooks"].as_object().unwrap().keys().collect();
        assert_eq!(hook_keys[0], "Notification");
        for event in EVENTS {
            assert_eq!(count_ours(&settings, event), 1, "{event}");
        }
    }

    #[test]
    fn second_install_adds_nothing_and_reports_installed() {
        let dir = temp_dir("twice");
        std::fs::write(dir.join("settings.json"), USER_SETTINGS).unwrap();
        install_in(&dir, true).unwrap();
        let first = std::fs::read(dir.join("settings.json")).unwrap();
        let p = preview_in(&dir, true).unwrap();
        assert!(p.additions.is_empty());
        assert!(p.already_installed);
        install_in(&dir, true).unwrap();
        assert_eq!(std::fs::read(dir.join("settings.json")).unwrap(), first);
    }

    #[test]
    fn stale_script_is_not_already_installed_and_is_refreshed() {
        let dir = temp_dir("stale");
        install_in(&dir, true).unwrap();
        std::fs::write(script_path(&dir), "old").unwrap();
        assert!(!preview_in(&dir, true).unwrap().already_installed);
        install_in(&dir, true).unwrap();
        assert_eq!(std::fs::read_to_string(script_path(&dir)).unwrap(), SCRIPT);
    }

    #[test]
    fn event_with_existing_bashboard_hook_is_skipped() {
        let dir = temp_dir("skip");
        let text = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"sh /x/bashboard-hook.sh"}]}]}}"#;
        std::fs::write(dir.join("settings.json"), text).unwrap();
        let p = preview_in(&dir, true).unwrap();
        assert!(!p.additions.contains_key("Stop"));
        assert_eq!(p.additions.len(), 4);
        install_in(&dir, true).unwrap();
        let settings = read_json(&dir);
        assert_eq!(settings["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn invalid_json_errors_and_leaves_file_untouched() {
        let dir = temp_dir("invalid");
        let text = "{\n  // comment\n  \"hooks\": {}\n}\n";
        std::fs::write(dir.join("settings.json"), text).unwrap();
        let err = install_in(&dir, true).unwrap_err();
        assert!(err.contains("settings.json"), "{err}");
        assert!(preview_in(&dir, true).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), text);
        assert!(!script_path(&dir).exists());
    }

    #[test]
    fn non_object_root_or_hooks_errors_and_writes_nothing() {
        for (tag, text) in [("arr", "[]"), ("hooks", r#"{"hooks":[]}"#), ("event", r#"{"hooks":{"Stop":{}}}"#)] {
            let dir = temp_dir(tag);
            std::fs::write(dir.join("settings.json"), text).unwrap();
            assert!(install_in(&dir, true).is_err(), "{tag}");
            assert_eq!(std::fs::read_to_string(dir.join("settings.json")).unwrap(), text);
            assert!(!script_path(&dir).exists());
        }
    }

    #[test]
    fn missing_claude_dir_is_not_detected() {
        let dir = temp_dir("absent").join("no-claude");
        assert!(!preview_in(&dir, true).unwrap().claude_detected);
    }

    #[test]
    fn install_without_bash_errors_and_writes_nothing() {
        let dir = temp_dir("nobash");
        std::fs::write(dir.join("settings.json"), USER_SETTINGS).unwrap();
        let err = install_in(&dir, false).unwrap_err();
        assert!(err.contains("Git for Windows"), "{err}");
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            USER_SETTINGS
        );
        assert!(!script_path(&dir).exists());
        assert!(!preview_in(&dir, false).unwrap().bash_found);
    }

    #[test]
    fn bash_on_path_finds_bash_exe_in_any_listed_dir() {
        let root = temp_dir("path");
        let with = root.join("with");
        let without = root.join("without");
        std::fs::create_dir_all(&with).unwrap();
        std::fs::create_dir_all(&without).unwrap();
        std::fs::write(with.join("bash.exe"), "").unwrap();
        let joined = std::env::join_paths([&without, &with]).unwrap();
        assert!(bash_on_path(&joined));
        assert!(!bash_on_path(
            &std::env::join_paths([&without, &root.join("missing")]).unwrap()
        ));
        assert!(!bash_on_path(OsStr::new("")));
    }

    #[test]
    fn preview_serializes_camel_case() {
        let dir = temp_dir("wire");
        let v = serde_json::to_value(preview_in(&dir, true).unwrap()).unwrap();
        assert!(v["settingsPath"].is_string());
        assert!(v["scriptPath"].is_string());
        assert_eq!(v["alreadyInstalled"], false);
        assert_eq!(v["claudeDetected"], true);
        assert_eq!(v["bashFound"], true);
        assert!(v["additions"]["Stop"].is_array());
    }
}
