//! Installs the Bashboard hook and registers it with each coding agent (design section 3.3).
//! The hook is a copy of the `bb` program beside the app, written into the agent's `hooks`
//! folder as `bashboard-hook` and run as `bashboard-hook hook <agent>`, so no hook depends on a
//! shell. It is merged into Claude Code's `settings.json` and Codex's `hooks.json`, and written
//! whole as Copilot's `hooks/bashboard.json`. Everything works over a base directory so tests
//! never touch the real home; the Tauri commands resolve the agent's home and delegate.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::agents::{self, AgentId};
use crate::atomic_file::write_atomic;
use crate::hook_client::{self, HOOK_VERSION};

const HOOK_STEM: &str = "bashboard-hook";
/// The shell script the hook used to be. Install points entries naming it at the binary and
/// deletes it.
const LEGACY_SCRIPT: &str = "bashboard-hook.sh";
const COMMAND_FIELDS: [&str; 2] = ["command", "commandWindows"];
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

/// The installed hook binary against this app's, by the version marker embedded in it.
/// Comparing versions rather than bytes keeps an older app from overwriting a newer app's hook,
/// which would leave two installed builds swapping it back and forth.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ScriptState {
    Missing,
    /// No readable marker or a lower version.
    Outdated,
    /// The same version, even when the bytes differ.
    Current,
    /// Written by a newer Bashboard; never replaced.
    Newer,
}

impl ScriptState {
    fn installed(self) -> bool {
        matches!(self, ScriptState::Current | ScriptState::Newer)
    }
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub agent: AgentId,
    /// The agent's hook config file: `settings.json`, `hooks.json`, or `hooks/bashboard.json`.
    pub settings_path: String,
    /// The installed hook binary.
    pub script_path: String,
    /// Events install would append to or rewrite, each with the group it would register.
    pub additions: Map<String, Value>,
    pub already_installed: bool,
    pub script_state: ScriptState,
    /// Whether the agent's home folder exists, i.e. the agent has run on this machine.
    pub detected: bool,
    /// `detected` for Claude, false for other agents; kept for callers that predate `detected`.
    pub claude_detected: bool,
    /// Codex only, once Bashboard's hooks are in `hooks.json`; None otherwise.
    pub trust: Option<CodexTrust>,
}

/// Where one agent's files live. `default_home` says the home is the agent's usual folder under
/// the user profile, so commands can name it through the profile variable instead of a path.
struct Target {
    agent: AgentId,
    home: PathBuf,
    default_home: bool,
}

fn claude_dir() -> Result<PathBuf, String> {
    let home = crate::platform::user_home().ok_or("could not find the home directory")?;
    Ok(home.join(".claude"))
}

fn target(agent: AgentId) -> Result<Target, String> {
    if agent == AgentId::Claude {
        return Ok(Target {
            agent,
            home: claude_dir()?,
            default_home: true,
        });
    }
    let a = agent.agent();
    let home = a.home().ok_or("could not find the home directory")?;
    let profile = crate::platform::user_home();
    let default_home = a.home_with(|_| None, profile.as_deref()).as_deref() == Some(home.as_path());
    Ok(Target {
        agent,
        home,
        default_home,
    })
}

/// The `bb` installed beside the app, which is the hook's source.
fn bundled_hook() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("could not locate Bashboard: {e}"))?;
    let dir = exe.parent().ok_or("could not locate Bashboard's folder")?;
    Ok(dir.join(crate::platform::exe_name("bb")))
}

fn settings_path(claude_dir: &Path) -> PathBuf {
    claude_dir.join("settings.json")
}

fn hook_path(home: &Path) -> PathBuf {
    home.join("hooks").join(hook_client::binary_name())
}

fn legacy_script_path(home: &Path) -> PathBuf {
    home.join("hooks").join(LEGACY_SCRIPT)
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

/// Bashboard's commands name `bashboard-hook` as a whole word (`LEGACY_SCRIPT` included), so a
/// user's `bashboard-hooks` is not taken for ours.
fn is_bashboard_command(command: &str) -> bool {
    command.match_indices(HOOK_STEM).any(|(i, m)| {
        command[i + m.len()..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
    })
}

fn is_bashboard_handler(h: &Value) -> bool {
    COMMAND_FIELDS.iter().any(|field| {
        h.get(*field)
            .and_then(Value::as_str)
            .is_some_and(is_bashboard_command)
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

fn agent_id(agent: AgentId) -> String {
    serde_json::to_value(agent)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// Claude Code runs hooks through its own bash on Windows too, so `~` expands there.
fn claude_command() -> String {
    format!("~/.claude/hooks/{} hook claude", hook_client::binary_name())
}

fn group() -> Value {
    json!({ "hooks": [{ "type": "command", "command": claude_command(), "timeout": 5 }] })
}

/// The POSIX and Windows commands that run the installed hook for `t.agent`. Codex runs the
/// Windows one through `cmd /C` and Copilot through PowerShell, so each names the profile folder
/// in that shell's syntax; `~` would not expand there.
fn agent_commands(t: &Target) -> (String, String) {
    let id = agent_id(t.agent);
    let exe = format!("{HOOK_STEM}.exe");
    // Codex wraps the whole line in quotes for `cmd /C`, so a leading quoted path survives;
    // PowerShell needs the call operator to run one.
    let call = if t.agent == AgentId::Copilot {
        "& "
    } else {
        ""
    };
    if t.default_home {
        let dir = file_label(&t.home);
        let profile = if t.agent == AgentId::Copilot {
            "$env:USERPROFILE"
        } else {
            "%USERPROFILE%"
        };
        (
            format!("~/{dir}/hooks/{HOOK_STEM} hook {id}"),
            format!("{call}\"{profile}\\{dir}\\hooks\\{exe}\" hook {id}"),
        )
    } else {
        let hooks = t.home.join("hooks");
        let shown = hooks.to_string_lossy();
        (
            format!("\"{}/{HOOK_STEM}\" hook {id}", shown.replace('\\', "/")),
            format!("{call}\"{}\\{exe}\" hook {id}", shown.replace('/', "\\")),
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

/// Sets the command fields of every Bashboard handler to `handler`'s, in place so group and
/// handler indexes (Codex's trust keys) stay where they were. Returns the events it changed.
fn rewrite_ours(settings: &mut Value, handler: &Value) -> Vec<String> {
    let fields: Vec<(&String, &Value)> = handler
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(k, _)| COMMAND_FIELDS.contains(&k.as_str()))
        .collect();
    let mut changed = Vec::new();
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return changed;
    };
    for (event, groups) in hooks.iter_mut() {
        let Some(groups) = groups.as_array_mut() else {
            continue;
        };
        let mut touched = false;
        for group in groups {
            let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                continue;
            };
            for h in handlers.iter_mut().filter(|h| is_bashboard_handler(h)) {
                let Some(obj) = h.as_object_mut() else {
                    continue;
                };
                for (k, v) in &fields {
                    if obj.get(*k) != Some(*v) {
                        obj.insert((*k).clone(), (*v).clone());
                        touched = true;
                    }
                }
            }
        }
        if touched {
            changed.push(event.clone());
        }
    }
    changed
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

/// The hook file as install would leave it, and the preview's additions: events gaining a group
/// plus events whose Bashboard handler is rewritten. Empty additions mean nothing changes.
fn merged(
    settings: &Value,
    events: &[&str],
    new_group: &Value,
    label: &str,
) -> Result<(Value, Map<String, Value>), String> {
    let mut additions = additions_for(settings, events, new_group, label)?;
    let mut out = settings.clone();
    let rewritten = rewrite_ours(&mut out, &new_group["hooks"][0]);
    merge_into(&mut out, &additions, label)?;
    for event in rewritten {
        additions
            .entry(event)
            .or_insert_with(|| json!([new_group.clone()]));
    }
    Ok((out, additions))
}

fn pretty(value: &Value) -> Result<String, String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    text.push('\n');
    Ok(text)
}

fn hook_state(path: &Path) -> ScriptState {
    let Ok(bytes) = std::fs::read(path) else {
        return ScriptState::Missing;
    };
    match hook_client::version_in(&bytes) {
        Some(v) if v > HOOK_VERSION => ScriptState::Newer,
        Some(v) if v == HOOK_VERSION => ScriptState::Current,
        _ => ScriptState::Outdated,
    }
}

/// Copies `source` over the installed hook unless that one is current or newer, so an install
/// started from an older app never downgrades it.
fn write_hook(path: &Path, source: &Path) -> Result<(), String> {
    let name = hook_client::binary_name();
    let aside = path.with_file_name(format!("{name}.old"));
    // Left by the previous install; it stays locked while a hook started before then still runs.
    let _ = std::fs::remove_file(&aside);
    if hook_state(path).installed() {
        return Ok(());
    }
    if !source.is_file() {
        return Err(format!(
            "{} was not found, so the hook cannot be installed. Reinstall Bashboard, then try again.",
            source.display()
        ));
    }
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} has no parent folder", path.display()))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let tmp = path.with_file_name(format!("{name}.tmp"));
    std::fs::copy(source, &tmp).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!(
            "could not copy {} to {}: {e}",
            source.display(),
            dir.display()
        )
    })?;
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("could not make {} executable: {e}", tmp.display()));
        }
    }
    // Windows refuses to overwrite an exe a hook is running at this moment, but lets it be
    // renamed aside.
    if path.exists() {
        if let Err(e) = std::fs::rename(path, &aside) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("could not replace {}: {e}", path.display()));
        }
    }
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::rename(&aside, path);
        format!("could not install {}: {e}", path.display())
    })
}

/// Best effort: nothing runs the script once its entries point at the binary.
fn remove_legacy_script(home: &Path) {
    let _ = std::fs::remove_file(legacy_script_path(home));
}

fn preview_in(claude_dir: &Path) -> Result<Preview, String> {
    let settings_path = settings_path(claude_dir);
    let hook_path = hook_path(claude_dir);
    let (_, additions) = merged(
        &read_settings(&settings_path)?,
        &EVENTS,
        &group(),
        "settings.json",
    )?;
    let script_state = hook_state(&hook_path);
    // Claude Code creates `~/.claude` on first run; without it there is nothing to hook.
    let detected = agents::CLAUDE.detected_at(Some(claude_dir));
    Ok(Preview {
        agent: AgentId::Claude,
        settings_path: settings_path.to_string_lossy().into_owned(),
        script_path: hook_path.to_string_lossy().into_owned(),
        already_installed: additions.is_empty() && script_state.installed(),
        script_state,
        detected,
        claude_detected: detected,
        additions,
        trust: None,
    })
}

fn install_in(claude_dir: &Path, source: &Path) -> Result<(), String> {
    let settings_path = settings_path(claude_dir);
    // Validate before writing anything so a bad settings.json leaves the disk untouched.
    let (settings, additions) = merged(
        &read_settings(&settings_path)?,
        &EVENTS,
        &group(),
        "settings.json",
    )?;

    write_hook(&hook_path(claude_dir), source)?;

    if !additions.is_empty() {
        write_atomic(&settings_path, pretty(&settings)?)?;
    }
    remove_legacy_script(claude_dir);
    Ok(())
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

/// `<event label>:<group index>:<handler index>` for each Bashboard handler in `hooks.json`.
fn codex_our_keys(hooks: &Value) -> Vec<String> {
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
    ours
}

/// Codex keys each hook as `<hooks.json path>:<event label>:<group index>:<handler index>`, and
/// its trust hash covers the hook's declaration (event, matcher, handler fields), not the
/// binary's contents. A present `trusted_hash` is taken as trusted, which misses one case:
/// install rewriting an older command in place, after which Codex asks for trust again.
fn codex_trust(hooks_path: &Path, hooks: &Value, config: Option<&str>) -> Option<CodexTrust> {
    let ours = codex_our_keys(hooks);
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

fn codex_preview(t: &Target) -> Result<Preview, String> {
    let hooks_path = codex_hooks_path(&t.home);
    let hook_path = hook_path(&t.home);
    let hooks = read_settings(&hooks_path)?;
    let (_, additions) = merged(&hooks, &CODEX_EVENTS, &codex_group(t), "hooks.json")?;
    let config = std::fs::read_to_string(t.home.join("config.toml")).ok();
    let script_state = hook_state(&hook_path);
    Ok(Preview {
        agent: AgentId::Codex,
        settings_path: hooks_path.to_string_lossy().into_owned(),
        script_path: hook_path.to_string_lossy().into_owned(),
        already_installed: additions.is_empty() && script_state.installed(),
        script_state,
        detected: t.agent.agent().detected_at(Some(&t.home)),
        claude_detected: false,
        trust: codex_trust(&hooks_path, &hooks, config.as_deref()),
        additions,
    })
}

fn codex_install(t: &Target, source: &Path) -> Result<(), String> {
    let hooks_path = codex_hooks_path(&t.home);
    let (hooks, additions) = merged(
        &read_settings(&hooks_path)?,
        &CODEX_EVENTS,
        &codex_group(t),
        "hooks.json",
    )?;

    write_hook(&hook_path(&t.home), source)?;

    if !additions.is_empty() {
        write_atomic(&hooks_path, pretty(&hooks)?)?;
    }
    remove_legacy_script(&t.home);
    Ok(())
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

fn copilot_preview(t: &Target) -> Result<Preview, String> {
    let file_path = copilot_file_path(&t.home);
    let hook_path = hook_path(&t.home);
    let expected = copilot_file(t);
    let current = std::fs::read_to_string(&file_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());
    let file_current = current.as_ref() == Some(&expected);
    let script_state = hook_state(&hook_path);
    let additions = if file_current {
        Map::new()
    } else {
        copilot_hooks(t)
    };
    Ok(Preview {
        agent: AgentId::Copilot,
        settings_path: file_path.to_string_lossy().into_owned(),
        script_path: hook_path.to_string_lossy().into_owned(),
        already_installed: file_current && script_state.installed(),
        script_state,
        detected: t.agent.agent().detected_at(Some(&t.home)),
        claude_detected: false,
        additions,
        trust: None,
    })
}

/// Bashboard owns `hooks/bashboard.json`, so it is written whole rather than merged.
fn copilot_install(t: &Target, source: &Path) -> Result<(), String> {
    write_hook(&hook_path(&t.home), source)?;
    write_atomic(&copilot_file_path(&t.home), pretty(&copilot_file(t))?)?;
    remove_legacy_script(&t.home);
    Ok(())
}

fn preview_for(t: &Target) -> Result<Preview, String> {
    match t.agent {
        AgentId::Claude => preview_in(&t.home),
        AgentId::Codex => codex_preview(t),
        AgentId::Copilot => copilot_preview(t),
    }
}

fn install_for(t: &Target, source: &Path) -> Result<(), String> {
    match t.agent {
        AgentId::Claude => install_in(&t.home, source),
        AgentId::Codex => codex_install(t, source),
        AgentId::Copilot => copilot_install(t, source),
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
pub fn hooks_install_preview(agent: Option<String>) -> Result<Preview, String> {
    preview_for(&target(parse_agent(agent)?)?)
}

#[tauri::command]
pub fn hooks_install(agent: Option<String>) -> Result<(), String> {
    install_for(&target(parse_agent(agent)?)?, &bundled_hook()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-hook-install-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Stand-in binary bytes carrying a version marker the way a linked `bb` does.
    fn binary(v: u32) -> Vec<u8> {
        format!("MZ\0fake bb\0{}{v};\0tail", hook_client::VERSION_PREFIX).into_bytes()
    }

    /// One shared stand-in for the `bb` beside the app, at this app's hook version.
    fn src() -> &'static Path {
        static SRC: OnceLock<PathBuf> = OnceLock::new();
        SRC.get_or_init(|| {
            let path = temp_dir("source").join(crate::platform::exe_name("bb"));
            std::fs::write(&path, binary(HOOK_VERSION)).unwrap();
            path
        })
    }

    fn installed_bytes(home: &Path) -> Vec<u8> {
        std::fs::read(hook_path(home)).unwrap()
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
    fn missing_settings_creates_all_five_events_and_the_hook() {
        let dir = temp_dir("missing");
        let p = preview_in(&dir).unwrap();
        assert_eq!(p.additions.len(), 5);
        assert!(!p.already_installed);
        assert_eq!(p.script_state, ScriptState::Missing);
        install_in(&dir, src()).unwrap();
        let settings = read_json(&dir);
        for event in EVENTS {
            assert_eq!(count_ours(&settings, event), 1, "{event}");
        }
        let h = &settings["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(h["command"], claude_command());
        assert_eq!(h["timeout"], 5);
        assert_eq!(installed_bytes(&dir), binary(HOOK_VERSION));
        assert!(
            !dir.join("hooks")
                .join(format!("{}.tmp", hook_client::binary_name()))
                .exists()
        );
        assert!(
            std::fs::read_to_string(dir.join("settings.json"))
                .unwrap()
                .ends_with('\n')
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn installed_hook_is_executable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        install_in(&dir, src()).unwrap();
        let mode = std::fs::metadata(hook_path(&dir))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }

    #[test]
    fn existing_shape_is_preserved_and_one_group_appended_per_event() {
        let dir = temp_dir("shape");
        std::fs::write(dir.join("settings.json"), USER_SETTINGS).unwrap();
        install_in(&dir, src()).unwrap();
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
        install_in(&dir, src()).unwrap();
        let first = std::fs::read(dir.join("settings.json")).unwrap();
        let p = preview_in(&dir).unwrap();
        assert!(p.additions.is_empty());
        assert!(p.already_installed);
        install_in(&dir, src()).unwrap();
        assert_eq!(std::fs::read(dir.join("settings.json")).unwrap(), first);
    }

    #[test]
    fn hook_state_reads_the_embedded_version() {
        let dir = temp_dir("state");
        let path = dir.join("hook");
        assert_eq!(hook_state(&path), ScriptState::Missing);
        for (bytes, want) in [
            (b"no marker".to_vec(), ScriptState::Outdated),
            (binary(HOOK_VERSION - 1), ScriptState::Outdated),
            (binary(HOOK_VERSION), ScriptState::Current),
            (binary(HOOK_VERSION + 1), ScriptState::Newer),
        ] {
            std::fs::write(&path, bytes).unwrap();
            assert_eq!(hook_state(&path), want);
        }
    }

    #[test]
    fn stale_hook_is_set_aside_replaced_and_the_old_copy_cleaned_up_next_time() {
        let dir = temp_dir("stale");
        install_in(&dir, src()).unwrap();
        std::fs::write(hook_path(&dir), "old").unwrap();
        let p = preview_in(&dir).unwrap();
        assert_eq!(p.script_state, ScriptState::Outdated);
        assert!(p.additions.is_empty() && !p.already_installed);
        assert_eq!(serde_json::to_value(&p).unwrap()["scriptState"], "outdated");
        install_in(&dir, src()).unwrap();
        assert_eq!(installed_bytes(&dir), binary(HOOK_VERSION));
        let aside = dir
            .join("hooks")
            .join(format!("{}.old", hook_client::binary_name()));
        assert_eq!(std::fs::read(&aside).unwrap(), b"old");
        install_in(&dir, src()).unwrap();
        assert!(!aside.exists());
    }

    #[test]
    fn older_hook_is_outdated_and_is_replaced() {
        let dir = temp_dir("hook-older");
        install_in(&dir, src()).unwrap();
        std::fs::write(hook_path(&dir), binary(HOOK_VERSION - 1)).unwrap();
        assert_eq!(
            preview_in(&dir).unwrap().script_state,
            ScriptState::Outdated
        );
        install_in(&dir, src()).unwrap();
        assert_eq!(installed_bytes(&dir), binary(HOOK_VERSION));
    }

    #[test]
    fn missing_hook_with_entries_in_settings_offers_the_hook_only() {
        let dir = temp_dir("hook-missing");
        install_in(&dir, src()).unwrap();
        std::fs::remove_file(hook_path(&dir)).unwrap();
        let p = preview_in(&dir).unwrap();
        assert_eq!(p.script_state, ScriptState::Missing);
        assert!(p.additions.is_empty() && !p.already_installed);
        install_in(&dir, src()).unwrap();
        assert_eq!(installed_bytes(&dir), binary(HOOK_VERSION));
    }

    #[test]
    fn same_version_with_other_bytes_is_current_and_kept() {
        let dir = temp_dir("hook-equal");
        install_in(&dir, src()).unwrap();
        let mut other = binary(HOOK_VERSION);
        other.extend_from_slice(b"another build");
        std::fs::write(hook_path(&dir), &other).unwrap();
        let p = preview_in(&dir).unwrap();
        assert_eq!(p.script_state, ScriptState::Current);
        assert!(p.already_installed);
        install_in(&dir, src()).unwrap();
        assert_eq!(installed_bytes(&dir), other);
    }

    #[test]
    fn newer_hook_counts_as_installed_and_is_never_downgraded() {
        let newer = binary(HOOK_VERSION + 1);
        for agent in [AgentId::Claude, AgentId::Codex, AgentId::Copilot] {
            let home = temp_dir(&format!("hook-newer-{agent:?}"));
            std::fs::create_dir_all(home.join("hooks")).unwrap();
            std::fs::write(hook_path(&home), &newer).unwrap();
            let t = target_in(agent, &home);
            // The config still lacks entries: install adds them but leaves the hook alone.
            let p = preview_for(&t).unwrap();
            assert_eq!(p.script_state, ScriptState::Newer, "{agent:?}");
            assert!(!p.additions.is_empty() && !p.already_installed, "{agent:?}");
            install_for(&t, src()).unwrap();
            assert_eq!(installed_bytes(&home), newer, "{agent:?}");
            let p = preview_for(&t).unwrap();
            assert!(p.already_installed && p.additions.is_empty(), "{agent:?}");
        }
    }

    #[test]
    fn other_agents_report_an_outdated_hook() {
        for agent in [AgentId::Codex, AgentId::Copilot] {
            let home = temp_dir(&format!("hook-outdated-{agent:?}"));
            let t = target_in(agent, &home);
            install_for(&t, src()).unwrap();
            std::fs::write(hook_path(&home), "old").unwrap();
            let p = preview_for(&t).unwrap();
            assert_eq!(p.script_state, ScriptState::Outdated, "{agent:?}");
            assert!(p.additions.is_empty() && !p.already_installed, "{agent:?}");
            install_for(&t, src()).unwrap();
            assert_eq!(installed_bytes(&home), binary(HOOK_VERSION));
        }
    }

    #[test]
    fn missing_source_errors_and_writes_nothing() {
        let dir = temp_dir("no-source");
        std::fs::write(dir.join("settings.json"), USER_SETTINGS).unwrap();
        let missing = dir.join("nowhere").join("bb");
        let err = install_in(&dir, &missing).unwrap_err();
        assert!(err.contains("Reinstall Bashboard"), "{err}");
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            USER_SETTINGS
        );
        assert!(!hook_path(&dir).exists());
        // Preview never needs the source.
        assert!(preview_in(&dir).is_ok());
        for agent in [AgentId::Codex, AgentId::Copilot] {
            let home = temp_dir(&format!("no-source-{agent:?}"));
            assert!(install_for(&target_in(agent, &home), &missing).is_err());
            assert!(!hook_path(&home).exists());
        }
    }

    #[test]
    fn bashboard_commands_are_recognized_as_a_whole_word() {
        for ours in [
            "bash ~/.claude/hooks/bashboard-hook.sh",
            r#"bash "%USERPROFILE%\.codex\hooks\bashboard-hook.sh" codex"#,
            "~/.claude/hooks/bashboard-hook.exe hook claude",
            r#""D:/tools/codex/hooks/bashboard-hook" hook codex"#,
            "/x/bashboard-hook",
        ] {
            assert!(is_bashboard_command(ours), "{ours}");
        }
        for theirs in ["bashboard-hooks.sh", "/x/bashboard-hook_2", "notify.sh", ""] {
            assert!(!is_bashboard_command(theirs), "{theirs}");
        }
    }

    #[test]
    fn claude_script_era_entries_are_rewritten_in_place() {
        let dir = temp_dir("claude-migrate");
        let old = "bash ~/.claude/hooks/bashboard-hook.sh";
        let mut settings: Value = serde_json::from_str(USER_SETTINGS).unwrap();
        let hooks = settings["hooks"].as_object_mut().unwrap();
        for event in EVENTS {
            let groups = hooks.entry(event).or_insert_with(|| json!([]));
            groups
                .as_array_mut()
                .unwrap()
                .push(json!({ "hooks": [{ "type": "command", "command": old, "timeout": 5 }] }));
        }
        // One of ours shares a group with a foreign handler, after it.
        hooks["Stop"] = json!([{ "hooks": [
            { "type": "command", "command": "notify.sh" },
            { "type": "command", "command": old, "timeout": 5 }
        ] }]);
        std::fs::write(dir.join("settings.json"), pretty(&settings).unwrap()).unwrap();
        std::fs::create_dir_all(dir.join("hooks")).unwrap();
        std::fs::write(legacy_script_path(&dir), "#!/usr/bin/env bash\n").unwrap();

        let p = preview_in(&dir).unwrap();
        assert_eq!(p.additions.len(), EVENTS.len());
        assert!(!p.already_installed);
        install_in(&dir, src()).unwrap();

        let after = read_json(&dir);
        let keys: Vec<&String> = after.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["env", "permissions", "hooks", "model"]);
        let hook_keys: Vec<&String> = after["hooks"].as_object().unwrap().keys().collect();
        let before_keys: Vec<&String> = settings["hooks"].as_object().unwrap().keys().collect();
        assert_eq!(hook_keys, before_keys);
        for event in EVENTS {
            assert_eq!(count_ours(&after, event), 1, "{event}");
        }
        let notif = after["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 3);
        assert_eq!(notif[0]["hooks"][0]["command"], "toast.sh");
        assert_eq!(notif[2]["hooks"][0]["command"], claude_command());
        let stop = after["hooks"]["Stop"][0]["hooks"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["command"], "notify.sh");
        assert_eq!(stop[1]["command"], claude_command());
        assert!(!legacy_script_path(&dir).exists());
        assert!(preview_in(&dir).unwrap().already_installed);
    }

    #[test]
    fn invalid_json_errors_and_leaves_file_untouched() {
        let dir = temp_dir("invalid");
        let text = "{\n  // comment\n  \"hooks\": {}\n}\n";
        std::fs::write(dir.join("settings.json"), text).unwrap();
        let err = install_in(&dir, src()).unwrap_err();
        assert!(err.contains("settings.json"), "{err}");
        assert!(preview_in(&dir).is_err());
        assert_eq!(
            std::fs::read_to_string(dir.join("settings.json")).unwrap(),
            text
        );
        assert!(!hook_path(&dir).exists());
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
            assert!(install_in(&dir, src()).is_err(), "{tag}");
            assert_eq!(
                std::fs::read_to_string(dir.join("settings.json")).unwrap(),
                text
            );
            assert!(!hook_path(&dir).exists());
        }
    }

    #[test]
    fn missing_claude_dir_is_not_detected() {
        let dir = temp_dir("absent").join("no-claude");
        assert!(!preview_in(&dir).unwrap().claude_detected);
    }

    #[test]
    fn preview_serializes_camel_case() {
        let dir = temp_dir("wire");
        let v = serde_json::to_value(preview_in(&dir).unwrap()).unwrap();
        assert!(v["settingsPath"].is_string());
        assert!(v["scriptPath"].is_string());
        assert_eq!(v["scriptState"], "missing");
        assert_eq!(v["alreadyInstalled"], false);
        assert_eq!(v["claudeDetected"], true);
        assert!(v.get("bashFound").is_none());
        assert!(v["additions"]["Stop"].is_array());
    }

    fn target_in(agent: AgentId, home: &Path) -> Target {
        Target {
            agent,
            home: home.to_path_buf(),
            default_home: true,
        }
    }

    fn read_file(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn claude_preview_reports_agent_and_detected() {
        let dir = temp_dir("claude-agent");
        let p = preview_for(&target_in(AgentId::Claude, &dir)).unwrap();
        assert_eq!(p.agent, AgentId::Claude);
        assert!(p.detected && p.claude_detected);
        assert_eq!(p.trust, None);
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["agent"], "claude");
        assert!(v["trust"].is_null());
    }

    #[test]
    fn claude_group_runs_the_binary() {
        let command = if cfg!(windows) {
            "~/.claude/hooks/bashboard-hook.exe hook claude"
        } else {
            "~/.claude/hooks/bashboard-hook hook claude"
        };
        assert_eq!(
            group(),
            json!({ "hooks": [{ "type": "command", "command": command, "timeout": 5 }] })
        );
    }

    #[test]
    fn parse_agent_defaults_to_claude_and_rejects_unknown() {
        assert_eq!(parse_agent(None), Ok(AgentId::Claude));
        assert_eq!(parse_agent(Some("codex".into())), Ok(AgentId::Codex));
        assert!(parse_agent(Some("gemini".into())).is_err());
    }

    #[test]
    fn commands_use_profile_variable_for_default_home() {
        let dir = temp_dir("codex-cmd");
        let (posix, windows) = agent_commands(&target_in(AgentId::Codex, &dir.join(".codex")));
        assert_eq!(posix, "~/.codex/hooks/bashboard-hook hook codex");
        assert_eq!(
            windows,
            r#""%USERPROFILE%\.codex\hooks\bashboard-hook.exe" hook codex"#
        );
        let (bash, ps) = agent_commands(&target_in(AgentId::Copilot, &dir.join(".copilot")));
        assert_eq!(bash, "~/.copilot/hooks/bashboard-hook hook copilot");
        assert_eq!(
            ps,
            r#"& "$env:USERPROFILE\.copilot\hooks\bashboard-hook.exe" hook copilot"#
        );
    }

    #[test]
    fn commands_use_absolute_path_for_custom_home() {
        let mut t = Target {
            agent: AgentId::Codex,
            home: PathBuf::from(r"D:\tools\codex"),
            default_home: false,
        };
        let (posix, windows) = agent_commands(&t);
        assert_eq!(posix, r#""D:/tools/codex/hooks/bashboard-hook" hook codex"#);
        assert_eq!(
            windows,
            r#""D:\tools\codex\hooks\bashboard-hook.exe" hook codex"#
        );
        t.agent = AgentId::Copilot;
        let (bash, ps) = agent_commands(&t);
        assert_eq!(
            bash,
            r#""D:/tools/codex/hooks/bashboard-hook" hook copilot"#
        );
        assert_eq!(
            ps,
            r#"& "D:\tools\codex\hooks\bashboard-hook.exe" hook copilot"#
        );
    }

    #[test]
    fn codex_merge_into_empty_home() {
        let home = temp_dir("codex-empty").join(".codex");
        std::fs::create_dir_all(&home).unwrap();
        let t = target_in(AgentId::Codex, &home);
        let p = preview_for(&t).unwrap();
        assert_eq!(p.agent, AgentId::Codex);
        assert!(p.detected && !p.claude_detected);
        assert_eq!(p.additions.len(), CODEX_EVENTS.len());
        assert_eq!(p.trust, None);
        install_for(&t, src()).unwrap();
        let hooks = read_file(&home.join("hooks.json"));
        for event in CODEX_EVENTS {
            assert_eq!(count_ours(&hooks, event), 1, "{event}");
        }
        let h = &hooks["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(h["type"], "command");
        assert_eq!(h["command"], "~/.codex/hooks/bashboard-hook hook codex");
        assert_eq!(
            h["commandWindows"],
            r#""%USERPROFILE%\.codex\hooks\bashboard-hook.exe" hook codex"#
        );
        assert_eq!(h["timeout"], 5);
        assert_eq!(installed_bytes(&home), binary(HOOK_VERSION));
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
        install_for(&t, src()).unwrap();
        let hooks = read_file(&home.join("hooks.json"));
        let before: Value = serde_json::from_str(CODEX_FOREIGN).unwrap();
        assert_eq!(hooks["description"], "mine");
        assert_eq!(hooks["hooks"]["PreToolUse"], before["hooks"]["PreToolUse"]);
        let stop = hooks["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0], before["hooks"]["Stop"][0]);
        assert_eq!(count_ours(&hooks, "Stop"), 1);

        let first = std::fs::read(home.join("hooks.json")).unwrap();
        let p = preview_for(&t).unwrap();
        assert!(p.additions.is_empty());
        assert!(p.already_installed);
        install_for(&t, src()).unwrap();
        assert_eq!(std::fs::read(home.join("hooks.json")).unwrap(), first);
    }

    #[test]
    fn codex_script_era_entries_are_rewritten_and_keep_their_trust_keys() {
        let home = temp_dir("codex-migrate").join(".codex");
        std::fs::create_dir_all(home.join("hooks")).unwrap();
        let old = json!({
            "type": "command",
            "command": "bash ~/.codex/hooks/bashboard-hook.sh codex",
            "commandWindows": r#""C:\Program Files\Git\bin\bash.exe" "%USERPROFILE%\.codex\hooks\bashboard-hook.sh" codex"#,
            "timeout": 5
        });
        let mut hooks: Value = serde_json::from_str(CODEX_FOREIGN).unwrap();
        let map = hooks["hooks"].as_object_mut().unwrap();
        for event in CODEX_EVENTS {
            let groups = map.entry(event).or_insert_with(|| json!([]));
            groups
                .as_array_mut()
                .unwrap()
                .push(json!({ "hooks": [old.clone()] }));
        }
        // Handler index 1 in SessionStart, behind a foreign handler in the same group.
        map["SessionStart"] = json!([{ "hooks": [
            { "type": "command", "command": "warm.sh" },
            old.clone()
        ] }]);
        let original = pretty(&hooks).unwrap();
        std::fs::write(home.join("hooks.json"), &original).unwrap();
        std::fs::write(legacy_script_path(&home), "#!/usr/bin/env bash\n").unwrap();
        let keys_before = codex_our_keys(&hooks);
        assert!(keys_before.contains(&"stop:1:0".to_string()));
        assert!(keys_before.contains(&"session_start:0:1".to_string()));

        let t = target_in(AgentId::Codex, &home);
        let p = preview_for(&t).unwrap();
        assert_eq!(p.additions.len(), CODEX_EVENTS.len());
        install_for(&t, src()).unwrap();

        let after = read_file(&home.join("hooks.json"));
        assert_eq!(codex_our_keys(&after), keys_before);
        let (command, windows) = agent_commands(&t);
        for event in CODEX_EVENTS {
            assert_eq!(count_ours(&after, event), 1, "{event}");
        }
        let h = &after["hooks"]["SessionStart"][0]["hooks"][1];
        assert_eq!(h["command"], command);
        assert_eq!(h["commandWindows"], windows);
        assert_eq!(
            after["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "warm.sh"
        );
        assert_eq!(after["hooks"]["Stop"][1]["hooks"][0]["command"], command);
        assert_eq!(after["hooks"]["PreToolUse"], hooks["hooks"]["PreToolUse"]);
        let hook_keys: Vec<&String> = after["hooks"].as_object().unwrap().keys().collect();
        let before_keys: Vec<&String> = hooks["hooks"].as_object().unwrap().keys().collect();
        assert_eq!(hook_keys, before_keys);
        assert!(!legacy_script_path(&home).exists());
        assert!(preview_for(&t).unwrap().already_installed);
    }

    #[test]
    fn codex_non_json_file_is_refused() {
        let home = temp_dir("codex-invalid");
        let text = "{ hooks: {} }";
        std::fs::write(home.join("hooks.json"), text).unwrap();
        let t = target_in(AgentId::Codex, &home);
        let err = install_for(&t, src()).unwrap_err();
        assert!(err.contains("hooks.json"), "{err}");
        assert!(preview_for(&t).is_err());
        assert_eq!(
            std::fs::read_to_string(home.join("hooks.json")).unwrap(),
            text
        );
        assert!(!hook_path(&home).exists());
    }

    #[test]
    fn codex_trust_reads_state_tables() {
        let home = temp_dir("codex-trust");
        let t = target_in(AgentId::Codex, &home);
        std::fs::write(home.join("hooks.json"), CODEX_FOREIGN).unwrap();
        install_for(&t, src()).unwrap();
        // Without config.toml nothing is trusted yet.
        assert_eq!(preview_for(&t).unwrap().trust, Some(CodexTrust::Untrusted));

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
        assert_eq!(preview_for(&t).unwrap().trust, Some(CodexTrust::Untrusted));

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
        assert_eq!(preview_for(&t).unwrap().trust, Some(CodexTrust::Trusted));

        // An inline form is not parsed, so the answer is unknown rather than a guess.
        std::fs::write(
            home.join("config.toml"),
            "[hooks.state]\n\"k:stop:1:0\" = { trusted_hash = \"a\" }\n",
        )
        .unwrap();
        assert_eq!(preview_for(&t).unwrap().trust, Some(CodexTrust::Unknown));
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
        let p = preview_for(&t).unwrap();
        assert_eq!(p.agent, AgentId::Copilot);
        assert!(p.detected && !p.already_installed);
        assert_eq!(p.additions.len(), COPILOT_EVENTS.len());
        assert!(p.settings_path.ends_with(COPILOT_FILE));
        install_for(&t, src()).unwrap();
        let file_path = home.join("hooks").join(COPILOT_FILE);
        let file = read_file(&file_path);
        assert_eq!(file["version"], 1);
        let keys: Vec<&String> = file["hooks"].as_object().unwrap().keys().collect();
        assert_eq!(keys, COPILOT_EVENTS);
        let e = &file["hooks"]["Notification"][0];
        assert_eq!(e["type"], "command");
        assert_eq!(e["bash"], "~/.copilot/hooks/bashboard-hook hook copilot");
        assert_eq!(
            e["powershell"],
            r#"& "$env:USERPROFILE\.copilot\hooks\bashboard-hook.exe" hook copilot"#
        );
        assert_eq!(e["timeoutSec"], 5);
        assert_eq!(installed_bytes(&home), binary(HOOK_VERSION));
        let p = preview_for(&t).unwrap();
        assert!(p.already_installed && p.additions.is_empty());

        let first = std::fs::read(&file_path).unwrap();
        std::fs::write(&file_path, "garbage").unwrap();
        assert!(!preview_for(&t).unwrap().already_installed);
        install_for(&t, src()).unwrap();
        assert_eq!(std::fs::read(&file_path).unwrap(), first);
        assert!(!home.join("hooks").join("bashboard.json.tmp").exists());
    }

    #[test]
    fn copilot_script_era_file_is_replaced_and_the_script_removed() {
        let home = temp_dir("copilot-migrate").join(".copilot");
        std::fs::create_dir_all(home.join("hooks")).unwrap();
        let entry = json!({
            "type": "command",
            "bash": "bash ~/.copilot/hooks/bashboard-hook.sh copilot",
            "powershell": r#"& "C:\Program Files\Git\bin\bash.exe" "$env:USERPROFILE\.copilot\hooks\bashboard-hook.sh" copilot"#,
            "timeoutSec": 5
        });
        let hooks: Map<String, Value> = COPILOT_EVENTS
            .iter()
            .map(|e| (e.to_string(), json!([entry.clone()])))
            .collect();
        let old = json!({ "version": 1, "hooks": hooks });
        std::fs::write(copilot_file_path(&home), pretty(&old).unwrap()).unwrap();
        std::fs::write(legacy_script_path(&home), "#!/usr/bin/env bash\n").unwrap();
        let t = target_in(AgentId::Copilot, &home);
        let p = preview_for(&t).unwrap();
        assert_eq!(p.additions.len(), COPILOT_EVENTS.len());
        assert!(!p.already_installed);
        install_for(&t, src()).unwrap();
        assert_eq!(read_file(&copilot_file_path(&home)), copilot_file(&t));
        assert!(!legacy_script_path(&home).exists());
        assert!(preview_for(&t).unwrap().already_installed);
    }
}
