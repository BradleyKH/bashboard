//! Agent descriptors (docs/design/sessions.md sections 3.2 to 3.4): one `Agent` per supported
//! coding agent (Claude Code, Codex, Copilot), parsed once from `src/agents.json` (shared with the
//! front end), carrying the facts the roster, hook installer, and transcript reader share: where
//! the agent keeps its home folder, which executables are the agent, how to recognize its
//! process, and which shell runs its hook command.
//!
//! Detection is the home folder existing. It never consults `PATH`: VS Code installs a
//! `copilot-shim\copilot.exe` launcher there that is not the Copilot CLI.
//!
//! Every function that reads the environment takes it as an argument, so tests never touch the
//! real home folder or process environment.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    #[default]
    Claude,
    Codex,
    Copilot,
}

impl AgentId {
    pub const ALL: [AgentId; 3] = [AgentId::Claude, AgentId::Codex, AgentId::Copilot];

    pub fn parse(s: &str) -> Option<AgentId> {
        match s {
            "claude" => Some(AgentId::Claude),
            "codex" => Some(AgentId::Codex),
            "copilot" => Some(AgentId::Copilot),
            _ => None,
        }
    }

    pub fn agent(self) -> &'static Agent {
        table()
            .iter()
            .find(|row| row.id == self)
            .expect("every AgentId has a row in src/agents.json")
    }
}

/// The shell an agent runs its hook command line through, which decides how the hook command
/// names the profile folder and whether it needs a call operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookShell {
    Cmd,
    Powershell,
    Sh,
}

/// One row of `src/agents.json`, the table the front end reads too. Fields only the front end
/// uses (launch and resume commands, `statusApp`) are not read here.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct Agent {
    id: AgentId,
    name: String,
    preview: bool,
    home: Home,
    process: Process,
    hook_shell: HookShellRow,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Home {
    /// Default home folder name under the user profile.
    dir: String,
    /// Environment variable that relocates the home folder, if the agent honors one.
    env: Option<String>,
    /// An entry inside the home folder that only the agent itself writes, when the folder alone
    /// is not proof: VS Code's Copilot extension creates `~/.copilot` (a `config.json` and
    /// `logs/`) on machines that have never run the Copilot CLI.
    detect_marker: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Process {
    /// Executable names, lowercase and without `.exe`, so one list serves every OS.
    executables: Vec<String>,
    /// A `node` host counts when its command line contains this text.
    node_marker: Option<String>,
}

#[derive(Debug, Deserialize)]
struct HookShellRow {
    windows: HookShell,
    #[allow(dead_code)]
    posix: HookShell,
}

const AGENTS_JSON: &str = include_str!("../../src/agents.json");

fn table() -> &'static [Agent] {
    static TABLE: OnceLock<Vec<Agent>> = OnceLock::new();
    TABLE.get_or_init(|| {
        serde_json::from_str(AGENTS_JSON).expect("src/agents.json is the agent table")
    })
}

/// A process's executable name, lowercase and without `.exe`: `Claude.exe` and `claude` are
/// both `claude`.
pub(crate) fn program_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

impl Agent {
    // The table's name, preview flag, and per-platform shell have no Rust caller yet; the
    // accessors are the table's Rust surface, so they are kept rather than rediscovered.
    #[allow(dead_code)]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[allow(dead_code)]
    pub fn preview(&self) -> bool {
        self.preview
    }

    #[allow(dead_code)]
    pub fn executables(&self) -> &[String] {
        &self.process.executables
    }

    /// The shell that runs the hook command on Windows. Hook installers build the Windows command
    /// on every platform, so they read this rather than the cfg-gated `hook_shell`.
    pub fn hook_shell_windows(&self) -> HookShell {
        self.hook_shell.windows
    }

    /// The shell that runs the hook command on this platform.
    #[allow(dead_code)]
    pub fn hook_shell(&self) -> HookShell {
        if cfg!(windows) {
            self.hook_shell.windows
        } else {
            self.hook_shell.posix
        }
    }

    /// The agent's home folder. `env` looks up a variable (the real one is `std::env::var_os`);
    /// `userprofile` is the user's profile folder, as the rest of the core resolves it.
    pub fn home_with(
        &self,
        env: impl Fn(&str) -> Option<OsString>,
        userprofile: Option<&Path>,
    ) -> Option<PathBuf> {
        if let Some(var) = self.home.env.as_deref() {
            if let Some(v) = env(var).filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(v));
            }
        }
        userprofile.map(|p| p.join(&self.home.dir))
    }

    pub fn home(&self) -> Option<PathBuf> {
        let profile = crate::platform::user_home();
        self.home_with(|k| std::env::var_os(k), profile.as_deref())
    }

    /// Whether a process is this agent. `name` is the executable file name; `cmdline` is the
    /// full command line when known.
    pub fn matches_process(&self, name: &str, cmdline: Option<&str>) -> bool {
        let stem = program_stem(name);
        if self.process.executables.contains(&stem) {
            return true;
        }
        match (self.process.node_marker.as_deref(), cmdline) {
            // npm on Windows launches the CLI by a backslash path (`node_modules\@github\copilot`).
            (Some(marker), Some(cmd)) => stem == "node" && cmd.replace('\\', "/").contains(marker),
            _ => false,
        }
    }
}

impl Agent {
    /// Whether the agent has run with `home` as its home folder.
    pub fn detected_at(&self, home: Option<&Path>) -> bool {
        home.is_some_and(|h| {
            h.is_dir() && self.home.detect_marker.as_deref().is_none_or(|m| h.join(m).exists())
        })
    }
}

pub fn detected(id: AgentId) -> bool {
    let agent = id.agent();
    agent.detected_at(agent.home().as_deref())
}

#[tauri::command]
pub fn agents_detected() -> Vec<AgentId> {
    AgentId::ALL
        .into_iter()
        .filter(|id| detected(*id))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_env(_: &str) -> Option<OsString> {
        None
    }

    #[test]
    fn table_has_exactly_one_row_per_agent_id() {
        let rows = table();
        assert_eq!(rows.len(), AgentId::ALL.len());
        for id in AgentId::ALL {
            assert_eq!(rows.iter().filter(|r| r.id == id).count(), 1, "{id:?}");
            let json = serde_json::to_value(id).unwrap();
            assert_eq!(AgentId::parse(json.as_str().unwrap()), Some(id));
            assert_eq!(id.agent().id, id);
        }
    }

    #[test]
    fn table_exposes_name_preview_and_hook_shell() {
        let claude = AgentId::Claude.agent();
        assert_eq!((claude.name(), claude.preview()), ("Claude Code", false));
        assert!(AgentId::Codex.agent().preview() && AgentId::Copilot.agent().preview());
        assert_eq!(AgentId::Codex.agent().hook_shell_windows(), HookShell::Cmd);
        assert_eq!(AgentId::Copilot.agent().hook_shell_windows(), HookShell::Powershell);
        assert_eq!(AgentId::Copilot.agent().executables(), ["copilot"]);
        let expect = if cfg!(windows) { HookShell::Powershell } else { HookShell::Sh };
        assert_eq!(AgentId::Copilot.agent().hook_shell(), expect);
    }

    #[test]
    fn parse_known_and_unknown() {
        assert_eq!(AgentId::parse("claude"), Some(AgentId::Claude));
        assert_eq!(AgentId::parse("codex"), Some(AgentId::Codex));
        assert_eq!(AgentId::parse("copilot"), Some(AgentId::Copilot));
        assert_eq!(AgentId::parse("Claude"), None);
        assert_eq!(AgentId::parse(""), None);
    }

    #[test]
    fn serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&AgentId::Copilot).unwrap(),
            "\"copilot\""
        );
    }

    #[test]
    fn default_homes_under_profile() {
        let p = Path::new("C:/Users/u");
        assert_eq!(AgentId::Claude.agent().home_with(no_env, Some(p)), Some(p.join(".claude")));
        assert_eq!(AgentId::Codex.agent().home_with(no_env, Some(p)), Some(p.join(".codex")));
        assert_eq!(AgentId::Copilot.agent().home_with(no_env, Some(p)), Some(p.join(".copilot")));
        assert_eq!(AgentId::Claude.agent().home_with(no_env, None), None);
    }

    #[test]
    fn home_env_overrides() {
        let p = Path::new("C:/Users/u");
        let env = |k: &str| match k {
            "CODEX_HOME" => Some(OsString::from("D:/codex")),
            "COPILOT_HOME" => Some(OsString::from("D:/copilot")),
            _ => None,
        };
        assert_eq!(
            AgentId::Codex.agent().home_with(env, Some(p)),
            Some(PathBuf::from("D:/codex"))
        );
        assert_eq!(
            AgentId::Copilot.agent().home_with(env, Some(p)),
            Some(PathBuf::from("D:/copilot"))
        );
        // Claude has no override variable.
        assert_eq!(AgentId::Claude.agent().home_with(env, Some(p)), Some(p.join(".claude")));
        // An empty override is ignored.
        let empty = |_: &str| Some(OsString::new());
        assert_eq!(AgentId::Codex.agent().home_with(empty, Some(p)), Some(p.join(".codex")));
    }

    #[test]
    fn matches_exe_names_case_insensitively() {
        assert!(AgentId::Claude.agent().matches_process("Claude.EXE", None));
        assert!(AgentId::Codex.agent().matches_process("codex.exe", None));
        assert!(AgentId::Copilot.agent().matches_process("COPILOT.exe", None));
        assert!(!AgentId::Codex.agent().matches_process("claude.exe", None));
    }

    #[test]
    fn executables_match_without_exe_as_on_macos_and_linux() {
        assert!(AgentId::Claude.agent().matches_process("claude", None));
        assert!(AgentId::Claude.agent().matches_process("Claude.exe", None));
        assert!(!AgentId::Claude.agent().matches_process("claude-helper", None));
        let cmd = "node /opt/homebrew/lib/node_modules/@github/copilot/index.js";
        assert!(AgentId::Copilot.agent().matches_process("node", Some(cmd)));
        assert!(!AgentId::Copilot.agent().matches_process("node", Some("node server.js")));
    }

    #[test]
    fn copilot_node_host_needs_marker() {
        let cmd = "node.exe /x/node_modules/@github/copilot/index.js";
        assert!(AgentId::Copilot.agent().matches_process("node.exe", Some(cmd)));
        let win = r#""C:\Users\me\AppData\Roaming\npm\node_modules\@github\copilot\index.js""#;
        assert!(AgentId::Copilot.agent().matches_process("node.exe", Some(win)));
        assert!(AgentId::Copilot.agent().matches_process("NODE.EXE", Some(cmd)));
        assert!(!AgentId::Copilot.agent().matches_process("node.exe", Some("node.exe server.js")));
        assert!(!AgentId::Copilot.agent().matches_process("node.exe", None));
        assert!(!AgentId::Codex.agent().matches_process("node.exe", Some(cmd)));
    }

    #[test]
    fn detected_checks_folder_exists() {
        let dir = std::env::temp_dir().join(format!("bashboard-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!AgentId::Claude.agent().detected_at(Some(&dir)));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(AgentId::Claude.agent().detected_at(Some(&dir)));
        assert!(!AgentId::Claude.agent().detected_at(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copilot_needs_session_state_not_just_its_folder() {
        let dir = std::env::temp_dir().join(format!("bashboard-agents-cp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("config.json"), "{}").unwrap();
        assert!(!AgentId::Copilot.agent().detected_at(Some(&dir)));
        std::fs::create_dir_all(dir.join("session-state")).unwrap();
        assert!(AgentId::Copilot.agent().detected_at(Some(&dir)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
