//! Installs the Bashboard hook script and registers it with each coding agent (design section
//! 3.3): merged into Claude Code's `settings.json` and Codex's `hooks.json`, and written whole as
//! Copilot's `hooks/bashboard.json`. Everything works over a base directory so tests never touch
//! the real home; the Tauri commands resolve the agent's home and delegate.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::State;

use crate::agents::{self, AgentId};
use crate::profiles;
use crate::settings::SettingsState;

const SCRIPT: &str = include_str!("../../hooks/bashboard-hook.sh");
const SCRIPT_NAME: &str = "bashboard-hook.sh";
const COMMAND: &str = "bash ~/.claude/hooks/bashboard-hook.sh";
const EVENTS: [&str; 5] = [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "Stop",
    "SessionEnd",
];
const CODEX_EVENTS: [&str; 7] = [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "SessionEnd",
    "Interrupt",
];
// PascalCase names select Copilot's VS Code-compatible payload (snake_case fields and
// `hook_event_name`), the shape the receiver parses.
const COPILOT_EVENTS: [&str; 6] = [
    "SessionStart",
    "UserPromptSubmit",
    "Notification",
    "PostToolUse",
    "Stop",
    "SessionEnd",
];
const COPILOT_FILE: &str = "bashboard.json";

/// Whether Codex will run the installed hooks, read from `config.toml`'s `[hooks.state]` table.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CodexTrust {
    Trusted,
    Untrusted,
    /// The state table is in a form this reader does not parse.
    Unknown,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub agent: AgentId,
    /// The agent's hook config file: `settings.json`, `hooks.json`, or `hooks/bashboard.json`.
    pub settings_path: String,
    pub script_path: String,
    pub additions: Map<String, Value>,
    pub already_installed: bool,
    /// Whether the agent's home folder exists, i.e. the agent has run on this machine.
    pub detected: bool,
    /// `detected` for Claude, false for other agents; kept for callers that predate `detected`.
    pub claude_detected: bool,
    /// The registered command runs through bash; without it every hook call fails.
    pub bash_found: bool,
    /// Codex only, once Bashboard's hooks are in `hooks.json`; None otherwise.
    pub trust: Option<CodexTrust>,
}

/// Where one agent's files live. `default_home` says the home is the agent's usual folder under
/// the user profile, so commands can name it through the profile variable instead of a path.
struct Target {
    agent: AgentId,
    home: PathBuf,
    default_home: bool,
    /// Git Bash, named in full in the Windows commands: a bare `bash` under `cmd` or PowerShell
    /// can resolve to WSL's `System32\bash.exe`, which sits earlier on `PATH`.
    git_bash: Option<PathBuf>,
}

fn claude_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("USERPROFILE")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|h| !h.is_empty()))
        .ok_or("could not find the home directory")?;
    Ok(PathBuf::from(home).join(".claude"))
}

fn git_bash(shell: &crate::settings::Shell) -> Option<PathBuf> {
    profiles::available_profiles(shell)
        .into_iter()
        .find(|p| p.id == profiles::GIT_BASH)
        .map(|p| PathBuf::from(p.path))
}

fn target(agent: AgentId, shell: &crate::settings::Shell) -> Result<Target, String> {
    if agent == AgentId::Claude {
        return Ok(Target {
            agent,
            home: claude_dir()?,
            default_home: true,
            git_bash: None,
        });
    }
    let a = agent.agent();
    let home = a.home().ok_or("could not find the home directory")?;
    let profile = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let default_home = a.home_with(|_| None, profile.as_deref()).as_deref() == Some(home.as_path());
    Ok(Target {
        agent,
        home,
        default_home,
        git_bash: git_bash(shell),
    })
}

fn settings_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("settings.json")
}

fn script_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("hooks").join(SCRIPT_NAME)
}

fn file_label(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A missing file reads as an empty object; anything that is not a strict JSON object (or whose
/// `hooks` is not an object) is an error so we never rewrite a file we do not understand.
fn read_settings(path: &Path) -> Result<Value, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let value: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "{} is not valid JSON ({e}); fix it and try again",
            path.display()
        )
    })?;
    let Some(root) = value.as_object() else {
        return Err(format!("{} must contain a JSON object", path.display()));
    };
    match root.get("hooks") {
        None | Some(Value::Object(_)) => {}
        Some(_) => return Err(format!("\"hooks\" in {} must be an object", path.display())),
    }
    Ok(value)
}

fn is_bashboard_handler(h: &Value) -> bool {
    ["command", "commandWindows"].iter().any(|field| {
        h.get(*field)
            .and_then(Value::as_str)
            .is_some_and(|c| c.contains(SCRIPT_NAME))
    })
}

fn has_bashboard_hook(groups: &[Value]) -> bool {
    groups.iter().any(|group| {
        group
            .get("hooks")
            .and_then(Value::as_array)
            .is_some_and(|hooks| hooks.iter().any(is_bashboard_handler))
    })
}

fn group() -> Value {
    json!({ "hooks": [{ "type": "command", "command": COMMAND, "timeout": 5 }] })
}

/// The POSIX and Windows commands that run the installed script for `t.agent`. Codex runs the
/// Windows one through `cmd /C` and Copilot through PowerShell, so each names the profile folder
/// in that shell's syntax; `~` would not expand there.
fn agent_commands(t: &Target) -> (String, String) {
    let id = serde_json::to_value(t.agent)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let dir = file_label(&t.home);
    // Codex wraps the whole line in quotes for `cmd /C`, so a leading quoted path survives;
    // PowerShell needs the call operator to run one.
    let win_bash = match (&t.git_bash, t.agent) {
        (Some(p), AgentId::Copilot) => format!("& \"{}\"", p.display()),
        (Some(p), _) => format!("\"{}\"", p.display()),
        (None, _) => "bash".to_string(),
    };
    if t.default_home {
        let profile = if t.agent == AgentId::Copilot {
            "$env:USERPROFILE"
        } else {
            "%USERPROFILE%"
        };
        (
            format!("bash ~/{dir}/hooks/{SCRIPT_NAME} {id}"),
            format!("{win_bash} \"{profile}\\{dir}\\hooks\\{SCRIPT_NAME}\" {id}"),
        )
    } else {
        let script = t.home.join("hooks").join(SCRIPT_NAME);
        let shown = script.to_string_lossy().into_owned();
        (
            format!("bash \"{}\" {id}", shown.replace('\\', "/")),
            format!("{win_bash} \"{}\" {id}", shown.replace('/', "\\")),
        )
    }
}

fn codex_group(t: &Target) -> Value {
    let (command, windows) = agent_commands(t);
    json!({ "hooks": [{
        "type": "command",
        "command": command,
        "commandWindows": windows,
        "timeout": 5
    }] })
}

/// The groups install would append, keyed by event; events already registered are omitted.
fn additions_for(
    settings: &Value,
    events: &[&str],
    new_group: &Value,
    label: &str,
) -> Result<Map<String, Value>, String> {
    let hooks = settings.get("hooks").and_then(Value::as_object);
    let mut out = Map::new();
    for event in events {
        let existing = match hooks.and_then(|h| h.get(*event)) {
            None => None,
            Some(Value::Array(a)) => Some(a.as_slice()),
            Some(_) => return Err(format!("\"hooks.{event}\" in {label} must be an array")),
        };
        if existing.is_some_and(has_bashboard_hook) {
            continue;
        }
        out.insert(event.to_string(), json!([new_group.clone()]));
    }
    Ok(out)
}

fn additions(settings: &Value) -> Result<Map<String, Value>, String> {
    additions_for(settings, &EVENTS, &group(), "settings.json")
}

fn merge_into(
    settings: &mut Value,
    additions: &Map<String, Value>,
    label: &str,
) -> Result<(), String> {
    let root = settings
        .as_object_mut()
        .ok_or_else(|| format!("{label} must contain a JSON object"))?;
    if additions.is_empty() {
        return Ok(());
    }
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("\"hooks\" in {label} must be an object"))?;
    for (event, groups) in additions {
        let Some(new) = groups.as_array() else {
            continue;
        };
        let slot = hooks.entry(event.clone()).or_insert_with(|| json!([]));
        slot.as_array_mut()
            .ok_or_else(|| format!("\"hooks.{event}\" in {label} must be an array"))?
            .extend(new.iter().cloned());
    }
    Ok(())
}

/// Writes `<name>.tmp` then renames it over the target, so a crash never leaves a torn file.
pub(crate) fn write_atomic(path: &Path, text: impl AsRef<[u8]>) -> Result<(), String> {
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

fn pretty(value: &Value) -> Result<String, String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok(text)
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

fn require_bash(bash_found: bool) -> Result<(), String> {
    if bash_found {
        Ok(())
    } else {
        Err("Git for Windows is required: the hooks run through bash, which was not found.              Install Git for Windows, then try again."
            .into())
    }
}

fn script_current(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|s| s == SCRIPT)
}

fn preview_in(claude_dir: &Path, bash_found: bool) -> Result<Preview, String> {
    let settings_path = settings_path(claude_dir);
    let script_path = script_path(claude_dir);
    let additions = additions(&read_settings(&settings_path)?)?;
    let script_current = script_current(&script_path);
    // Claude Code creates `~/.claude` on first run; without it there is nothing to hook.
    let detected = agents::CLAUDE.detected_at(Some(claude_dir));
    Ok(Preview {
        agent: AgentId::Claude,
        settings_path: settings_path.to_string_lossy().into_owned(),
        script_path: script_path.to_string_lossy().into_owned(),
        already_installed: additions.is_empty() && script_current,
        detected,
        claude_detected: detected,
        bash_found,
        additions,
        trust: None,
    })
}

fn install_in(claude_dir: &Path, bash_found: bool) -> Result<(), String> {
    require_bash(bash_found)?;
    let settings_path = settings_path(claude_dir);
    // Validate before writing anything so a bad settings.json leaves the disk untouched.
    let mut settings = read_settings(&settings_path)?;
    let additions = additions(&settings)?;

    write_atomic(&script_path(claude_dir), SCRIPT)?;

    if additions.is_empty() {
        return Ok(());
    }
    merge_into(&mut settings, &additions, "settings.json")?;
    write_atomic(&settings_path, pretty(&settings)?)
}

fn codex_hooks_path(home: &Path) -> PathBuf {
    home.join("hooks.json")
}

/// Codex's state key label for an event (`hook_event_key_label` in codex-rs).
fn codex_event_label(event: &str) -> String {
    let mut out = String::new();
    for (i, c) in event.chars().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn normalize_path(s: &str) -> String {
    let s = s.strip_prefix(r"\\?\").unwrap_or(s);
    s.replace('\\', "/").to_lowercase()
}

/// Decodes a TOML quoted key (`"..."` or `'...'`), returning it and the rest of the line.
fn toml_quoted(s: &str) -> Option<(String, &str)> {
    let quote = s.chars().next().filter(|c| *c == '"' || *c == '\'')?;
    let body = &s[1..];
    let mut out = String::new();
    let mut chars = body.char_indices();
    while let Some((i, c)) = chars.next() {
        if c == quote {
            return Some((out, &body[i + 1..]));
        }
        if c == '\\' && quote == '"' {
            match chars.next()?.1 {
                'n' => out.push('\n'),
                't' => out.push('\t'),
                other => out.push(other),
            }
        } else {
            out.push(c);
        }
    }
    None
}

/// Keys of `[hooks.state."<key>"]` tables that set `trusted_hash`, or None when `trusted_hash`
/// appears anywhere else (inline tables, dotted keys), which this reader does not follow.
fn trusted_state_keys(config: &str) -> Option<Vec<String>> {
    let mut trusted = Vec::new();
    let mut current: Option<String> = None;
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            current = line
                .strip_prefix("[hooks.state.")
                .and_then(toml_quoted)
                .filter(|(_, rest)| rest.trim_start().starts_with(']'))
                .map(|(key, _)| key);
            continue;
        }
        if line.starts_with('#') || !line.contains("trusted_hash") {
            continue;
        }
        let plain_key = line
            .strip_prefix("trusted_hash")
            .is_some_and(|rest| rest.trim_start().starts_with('='));
        match &current {
            Some(key) if plain_key => trusted.push(key.clone()),
            _ => return None,
        }
    }
    Some(trusted)
}

/// Codex keys each hook as `<hooks.json path>:<event label>:<group index>:<handler index>`, and
/// its trust hash covers the hook's declaration (event, matcher, handler fields), not the
/// script's contents. A present `trusted_hash` is taken as trusted: Bashboard never edits its
/// entries after install, so the hash cannot go stale on its account.
fn codex_trust(hooks_path: &Path, hooks: &Value, config: Option<&str>) -> Option<CodexTrust> {
    let mut ours = Vec::new();
    for event in CODEX_EVENTS {
        let Some(groups) = hooks
            .get("hooks")
            .and_then(|h| h.get(event))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for (g, group) in groups.iter().enumerate() {
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                continue;
            };
            for (h, handler) in handlers.iter().enumerate() {
                if is_bashboard_handler(handler) {
                    ours.push(format!("{}:{g}:{h}", codex_event_label(event)));
                }
            }
        }
    }
    if ours.is_empty() {
        return None;
    }
    let Some(config) = config else {
        return Some(CodexTrust::Untrusted);
    };
    let Some(keys) = trusted_state_keys(config) else {
        return Some(CodexTrust::Unknown);
    };
    let want_path = normalize_path(&hooks_path.to_string_lossy());
    let trusted: Vec<String> = keys
        .iter()
        .filter_map(|key| {
            let mut parts = key.rsplitn(4, ':');
            let (h, g, label, path) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
            (normalize_path(path) == want_path).then(|| format!("{label}:{g}:{h}"))
        })
        .collect();
    let all = ours.iter().all(|k| trusted.contains(k));
    Some(if all {
        CodexTrust::Trusted
    } else {
        CodexTrust::Untrusted
    })
}

fn codex_preview(t: &Target, bash_found: bool) -> Result<Preview, String> {
    let hooks_path = codex_hooks_path(&t.home);
    let script_path = script_path(&t.home);
    let hooks = read_settings(&hooks_path)?;
    let additions = additions_for(&hooks, &CODEX_EVENTS, &codex_group(t), "hooks.json")?;
    let config = std::fs::read_to_string(t.home.join("config.toml")).ok();
    Ok(Preview {
        agent: AgentId::Codex,
        settings_path: hooks_path.to_string_lossy().into_owned(),
        script_path: script_path.to_string_lossy().into_owned(),
        already_installed: additions.is_empty() && script_current(&script_path),
        detected: t.agent.agent().detected_at(Some(&t.home)),
        claude_detected: false,
        bash_found,
        trust: codex_trust(&hooks_path, &hooks, config.as_deref()),
        additions,
    })
}

fn codex_install(t: &Target, bash_found: bool) -> Result<(), String> {
    require_bash(bash_found)?;
    let hooks_path = codex_hooks_path(&t.home);
    let mut hooks = read_settings(&hooks_path)?;
    let additions = additions_for(&hooks, &CODEX_EVENTS, &codex_group(t), "hooks.json")?;

    write_atomic(&script_path(&t.home), SCRIPT)?;

    if additions.is_empty() {
        return Ok(());
    }
    merge_into(&mut hooks, &additions, "hooks.json")?;
    write_atomic(&hooks_path, pretty(&hooks)?)
}

fn copilot_file_path(home: &Path) -> PathBuf {
    home.join("hooks").join(COPILOT_FILE)
}

fn copilot_hooks(t: &Target) -> Map<String, Value> {
    let (bash, powershell) = agent_commands(t);
    let entry = json!({
        "type": "command",
        "bash": bash,
        "powershell": powershell,
        "timeoutSec": 5
    });
    COPILOT_EVENTS
        .iter()
        .map(|e| (e.to_string(), json!([entry.clone()])))
        .collect()
}

fn copilot_file(t: &Target) -> Value {
    json!({ "version": 1, "hooks": copilot_hooks(t) })
}

fn copilot_preview(t: &Target, bash_found: bool) -> Result<Preview, String> {
    let file_path = copilot_file_path(&t.home);
    let script_path = script_path(&t.home);
    let expected = copilot_file(t);
    let current = std::fs::read_to_string(&file_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let file_current = current.as_ref() == Some(&expected);
    let additions = if file_current {
        Map::new()
    } else {
        copilot_hooks(t)
    };
    Ok(Preview {
        agent: AgentId::Copilot,
        settings_path: file_path.to_string_lossy().into_owned(),
        script_path: script_path.to_string_lossy().into_owned(),
        already_installed: file_current && script_current(&script_path),
        detected: t.agent.agent().detected_at(Some(&t.home)),
        claude_detected: false,
        bash_found,
        additions,
        trust: None,
    })
}

/// Bashboard owns `hooks/bashboard.json`, so it is written whole rather than merged.
fn copilot_install(t: &Target, bash_found: bool) -> Result<(), String> {
    require_bash(bash_found)?;
    write_atomic(&script_path(&t.home), SCRIPT)?;
    write_atomic(&copilot_file_path(&t.home), pretty(&copilot_file(t))?)
}

fn preview_for(t: &Target, bash_found: bool) -> Result<Preview, String> {
    match t.agent {
        AgentId::Claude => preview_in(&t.home, bash_found),
        AgentId::Codex => codex_preview(t, bash_found),
        AgentId::Copilot => copilot_preview(t, bash_found),
    }
}

fn install_for(t: &Target, bash_found: bool) -> Result<(), String> {
    match t.agent {
        AgentId::Claude => install_in(&t.home, bash_found),
        AgentId::Codex => codex_install(t, bash_found),
        AgentId::Copilot => copilot_install(t, bash_found),
    }
}

/// An absent agent means Claude, which callers from before per-agent installs rely on.
fn parse_agent(agent: Option<String>) -> Result<AgentId, String> {
    match agent {
        None => Ok(AgentId::Claude),
        Some(s) => AgentId::parse(&s).ok_or_else(|| format!("unknown agent \"{s}\"")),
    }
}

#[tauri::command]
pub fn hooks_install_preview(
    settings: State<'_, SettingsState>,
    agent: Option<String>,
) -> Result<Preview, String> {
    let shell = settings.current().shell.clone();
    let t = target(parse_agent(agent)?, &shell)?;
    preview_for(&t, bash_available(&shell))
}

#[tauri::command]
pub fn hooks_install(
    settings: State<'_, SettingsState>,
    agent: Option<String>,
) -> Result<(), String> {
    let shell = settings.current().shell.clone();
    let t = target(parse_agent(agent)?, &shell)?;
    install_for(&t, bash_available(&shell))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-hook-install-{tag}-{}",
            std::process::id()
        ));
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
        assert!(
            std::fs::read_to_string(dir.join("settings.json"))
                .unwrap()
                .ends_with('\n')
        );
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
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            text
        );
        assert!(!script_path(&dir).exists());
    }

    #[test]
    fn non_object_root_or_hooks_errors_and_writes_nothing() {
        for (tag, text) in [
            ("arr", "[]"),
            ("hooks", r#"{"hooks":[]}"#),
            ("event", r#"{"hooks":{"Stop":{}}}"#),
        ] {
            let dir = temp_dir(tag);
            std::fs::write(dir.join("settings.json"), text).unwrap();
            assert!(install_in(&dir, true).is_err(), "{tag}");
            assert_eq!(
                std::fs::read_to_string(dir.join("settings.json")).unwrap(),
                text
            );
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

    fn target_in(agent: AgentId, home: &Path) -> Target {
        Target {
            agent,
            home: home.to_path_buf(),
            default_home: true,
            git_bash: None,
        }
    }

    fn read_file(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn claude_preview_reports_agent_and_detected() {
        let dir = temp_dir("claude-agent");
        let p = preview_for(&target_in(AgentId::Claude, &dir), true).unwrap();
        assert_eq!(p.agent, AgentId::Claude);
        assert!(p.detected && p.claude_detected);
        assert_eq!(p.trust, None);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["agent"], "claude");
        assert!(v["trust"].is_null());
    }

    #[test]
    fn claude_group_is_unchanged() {
        assert_eq!(
            group(),
            json!({ "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/bashboard-hook.sh", "timeout": 5 }] })
        );
    }

    #[test]
    fn parse_agent_defaults_to_claude_and_rejects_unknown() {
        assert_eq!(parse_agent(None), Ok(AgentId::Claude));
        assert_eq!(parse_agent(Some("codex".into())), Ok(AgentId::Codex));
        assert!(parse_agent(Some("gemini".into())).is_err());
    }

    #[test]
    fn codex_commands_use_profile_variable_for_default_home() {
        let dir = temp_dir("codex-cmd");
        let (posix, windows) = agent_commands(&target_in(AgentId::Codex, &dir.join(".codex")));
        assert_eq!(posix, "bash ~/.codex/hooks/bashboard-hook.sh codex");
        assert_eq!(
            windows,
            r#"bash "%USERPROFILE%\.codex\hooks\bashboard-hook.sh" codex"#
        );
        let (bash, ps) = agent_commands(&target_in(AgentId::Copilot, &dir.join(".copilot")));
        assert_eq!(bash, "bash ~/.copilot/hooks/bashboard-hook.sh copilot");
        assert_eq!(
            ps,
            r#"bash "$env:USERPROFILE\.copilot\hooks\bashboard-hook.sh" copilot"#
        );
    }

    #[test]
    fn windows_commands_name_git_bash_in_full_when_found() {
        let dir = temp_dir("git-bash-cmd");
        let bash = PathBuf::from(r"C:\Program Files\Git\bin\bash.exe");
        let mut t = target_in(AgentId::Codex, &dir.join(".codex"));
        t.git_bash = Some(bash.clone());
        let (posix, windows) = agent_commands(&t);
        assert_eq!(posix, "bash ~/.codex/hooks/bashboard-hook.sh codex");
        assert_eq!(
            windows,
            r#""C:\Program Files\Git\bin\bash.exe" "%USERPROFILE%\.codex\hooks\bashboard-hook.sh" codex"#
        );
        let mut t = target_in(AgentId::Copilot, &dir.join(".copilot"));
        t.git_bash = Some(bash);
        let (_, ps) = agent_commands(&t);
        assert_eq!(
            ps,
            r#"& "C:\Program Files\Git\bin\bash.exe" "$env:USERPROFILE\.copilot\hooks\bashboard-hook.sh" copilot"#
        );
    }

    #[test]
    fn codex_commands_use_absolute_path_for_custom_home() {
        let t = Target {
            agent: AgentId::Codex,
            home: PathBuf::from(r"D:\tools\codex"),
            default_home: false,
            git_bash: None,
        };
        let (posix, windows) = agent_commands(&t);
        assert_eq!(
            posix,
            r#"bash "D:/tools/codex/hooks/bashboard-hook.sh" codex"#
        );
        assert_eq!(
            windows,
            r#"bash "D:\tools\codex\hooks\bashboard-hook.sh" codex"#
        );
    }

    #[test]
    fn codex_merge_into_empty_home() {
        let home = temp_dir("codex-empty").join(".codex");
        std::fs::create_dir_all(&home).unwrap();
        let t = target_in(AgentId::Codex, &home);
        let p = preview_for(&t, true).unwrap();
        assert_eq!(p.agent, AgentId::Codex);
        assert!(p.detected && !p.claude_detected);
        assert_eq!(p.additions.len(), CODEX_EVENTS.len());
        assert_eq!(p.trust, None);
        install_for(&t, true).unwrap();
        let hooks = read_file(&home.join("hooks.json"));
        for event in CODEX_EVENTS {
            assert_eq!(count_ours(&hooks, event), 1, "{event}");
        }
        let h = &hooks["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(h["type"], "command");
        assert_eq!(h["command"], "bash ~/.codex/hooks/bashboard-hook.sh codex");
        assert_eq!(
            h["commandWindows"],
            r#"bash "%USERPROFILE%\.codex\hooks\bashboard-hook.sh" codex"#
        );
        assert_eq!(h["timeout"], 5);
        assert_eq!(
            std::fs::read_to_string(home.join("hooks").join(SCRIPT_NAME)).unwrap(),
            SCRIPT
        );
    }

    const CODEX_FOREIGN: &str = r#"{
  "description": "mine",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "policy.py", "timeout": 30 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "notify.sh" }] }
    ]
  }
}"#;

    #[test]
    fn codex_merge_leaves_foreign_groups_untouched_and_second_install_is_noop() {
        let home = temp_dir("codex-foreign");
        std::fs::write(home.join("hooks.json"), CODEX_FOREIGN).unwrap();
        let t = target_in(AgentId::Codex, &home);
        install_for(&t, true).unwrap();
        let hooks = read_file(&home.join("hooks.json"));
        let before: Value = serde_json::from_str(CODEX_FOREIGN).unwrap();
        assert_eq!(hooks["description"], "mine");
        assert_eq!(hooks["hooks"]["PreToolUse"], before["hooks"]["PreToolUse"]);
        let stop = hooks["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0], before["hooks"]["Stop"][0]);
        assert_eq!(count_ours(&hooks, "Stop"), 1);

        let first = std::fs::read(home.join("hooks.json")).unwrap();
        let p = preview_for(&t, true).unwrap();
        assert!(p.additions.is_empty());
        assert!(p.already_installed);
        install_for(&t, true).unwrap();
        assert_eq!(std::fs::read(home.join("hooks.json")).unwrap(), first);
    }

    #[test]
    fn codex_non_json_file_is_refused() {
        let home = temp_dir("codex-invalid");
        let text = "{ hooks: {} }";
        std::fs::write(home.join("hooks.json"), text).unwrap();
        let t = target_in(AgentId::Codex, &home);
        let err = install_for(&t, true).unwrap_err();
        assert!(err.contains("hooks.json"), "{err}");
        assert!(preview_for(&t, true).is_err());
        assert_eq!(
            std::fs::read_to_string(home.join("hooks.json")).unwrap(),
            text
        );
        assert!(!script_path(&home).exists());
    }

    #[test]
    fn codex_trust_reads_state_tables() {
        let home = temp_dir("codex-trust");
        let t = target_in(AgentId::Codex, &home);
        std::fs::write(home.join("hooks.json"), CODEX_FOREIGN).unwrap();
        install_for(&t, true).unwrap();
        // Without config.toml nothing is trusted yet.
        assert_eq!(
            preview_for(&t, true).unwrap().trust,
            Some(CodexTrust::Untrusted)
        );

        // Ours sit at group 0 everywhere except Stop, where the foreign group is 0.
        let path = home
            .join("hooks.json")
            .to_string_lossy()
            .replace('\\', "\\\\");
        let mut config =
            String::from("model = \"gpt\"\n\n[hooks.state.\"x:stop:0:0\"]\ntrusted_hash = \"a\"\n");
        for event in CODEX_EVENTS {
            let g = if event == "Stop" { 1 } else { 0 };
            if event == "Interrupt" {
                continue;
            }
            config.push_str(&format!(
                "\n[hooks.state.\"{path}:{}:{g}:0\"]\nenabled = true\ntrusted_hash = \"sha256:abc\"\n",
                codex_event_label(event)
            ));
        }
        std::fs::write(home.join("config.toml"), &config).unwrap();
        assert_eq!(
            preview_for(&t, true).unwrap().trust,
            Some(CodexTrust::Untrusted)
        );

        // A literal-string key with forward slashes and other casing still matches.
        let literal = home
            .join("hooks.json")
            .to_string_lossy()
            .replace('\\', "/")
            .to_uppercase();
        config.push_str(&format!(
            "\n[hooks.state.'{literal}:interrupt:0:0']\ntrusted_hash = \"z\"\n"
        ));
        std::fs::write(home.join("config.toml"), &config).unwrap();
        assert_eq!(
            preview_for(&t, true).unwrap().trust,
            Some(CodexTrust::Trusted)
        );

        // An inline form is not parsed, so the answer is unknown rather than a guess.
        std::fs::write(
            home.join("config.toml"),
            "[hooks.state]\n\"k:stop:1:0\" = { trusted_hash = \"a\" }\n",
        )
        .unwrap();
        assert_eq!(
            preview_for(&t, true).unwrap().trust,
            Some(CodexTrust::Unknown)
        );
    }

    #[test]
    fn codex_event_labels_match_codex() {
        assert_eq!(codex_event_label("SessionStart"), "session_start");
        assert_eq!(codex_event_label("UserPromptSubmit"), "user_prompt_submit");
        assert_eq!(codex_event_label("PermissionRequest"), "permission_request");
        assert_eq!(codex_event_label("Stop"), "stop");
    }

    #[test]
    fn copilot_file_written_and_overwritten_cleanly() {
        let home = temp_dir("copilot").join(".copilot");
        std::fs::create_dir_all(home.join("session-state")).unwrap();
        let t = target_in(AgentId::Copilot, &home);
        let p = preview_for(&t, true).unwrap();
        assert_eq!(p.agent, AgentId::Copilot);
        assert!(p.detected && !p.already_installed);
        assert_eq!(p.additions.len(), COPILOT_EVENTS.len());
        assert!(p.settings_path.ends_with(COPILOT_FILE));
        install_for(&t, true).unwrap();
        let file_path = home.join("hooks").join(COPILOT_FILE);
        let file = read_file(&file_path);
        assert_eq!(file["version"], 1);
        let keys: Vec<&String> = file["hooks"].as_object().unwrap().keys().collect();
        assert_eq!(keys, COPILOT_EVENTS);
        let e = &file["hooks"]["Notification"][0];
        assert_eq!(e["type"], "command");
        assert_eq!(e["bash"], "bash ~/.copilot/hooks/bashboard-hook.sh copilot");
        assert_eq!(
            e["powershell"],
            r#"bash "$env:USERPROFILE\.copilot\hooks\bashboard-hook.sh" copilot"#
        );
        assert_eq!(e["timeoutSec"], 5);
        assert_eq!(
            std::fs::read_to_string(home.join("hooks").join(SCRIPT_NAME)).unwrap(),
            SCRIPT
        );
        let p = preview_for(&t, true).unwrap();
        assert!(p.already_installed && p.additions.is_empty());

        let first = std::fs::read(&file_path).unwrap();
        std::fs::write(&file_path, "garbage").unwrap();
        assert!(!preview_for(&t, true).unwrap().already_installed);
        install_for(&t, true).unwrap();
        assert_eq!(std::fs::read(&file_path).unwrap(), first);
        assert!(!home.join("hooks").join("bashboard.json.tmp").exists());
    }

    #[test]
    fn other_agents_need_bash_too() {
        let home = temp_dir("agents-nobash");
        for agent in [AgentId::Codex, AgentId::Copilot] {
            let err = install_for(&target_in(agent, &home), false).unwrap_err();
            assert!(err.contains("Git for Windows"), "{err}");
        }
        assert!(!script_path(&home).exists());
    }
}
