//! Agent descriptors (docs/design/sessions.md sections 3.2 to 3.4): one static `Agent` per
//! supported coding agent (Claude Code, Codex, Copilot), carrying the facts the roster, hook
//! installer, and transcript reader share: where the agent keeps its home folder, which executables
//! are the agent, and how to recognize its process.
//!
//! Detection is the home folder existing. It never consults `PATH`: VS Code installs a
//! `copilot-shim\copilot.exe` launcher there that is not the Copilot CLI.
//!
//! Every function that reads the environment takes it as an argument, so tests never touch the
//! real home folder or process environment.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize)]
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
        match self {
            AgentId::Claude => &CLAUDE,
            AgentId::Codex => &CODEX,
            AgentId::Copilot => &COPILOT,
        }
    }
}

pub struct Agent {
    /// Default home folder name under the user profile.
    home_dir_name: &'static str,
    /// Environment variable that relocates the home folder, if the agent honors one.
    home_env: Option<&'static str>,
    /// Executable file names, lowercase.
    pub executables: &'static [&'static str],
    /// A `node.exe` host counts when its command line contains this text.
    node_marker: Option<&'static str>,
    /// An entry inside the home folder that only the agent itself writes, when the folder alone
    /// is not proof: VS Code's Copilot extension creates `~/.copilot` (a `config.json` and
    /// `logs/`) on machines that have never run the Copilot CLI.
    detect_marker: Option<&'static str>,
}

pub static CLAUDE: Agent = Agent {
    home_dir_name: ".claude",
    home_env: None,
    executables: &["claude.exe"],
    node_marker: None,
    detect_marker: None,
};

pub static CODEX: Agent = Agent {
    home_dir_name: ".codex",
    home_env: Some("CODEX_HOME"),
    executables: &["codex.exe"],
    node_marker: None,
    detect_marker: None,
};

pub static COPILOT: Agent = Agent {
    home_dir_name: ".copilot",
    home_env: Some("COPILOT_HOME"),
    executables: &["copilot.exe"],
    node_marker: Some("@github/copilot"),
    // The CLI writes one folder per session here on its first interactive run.
    detect_marker: Some("session-state"),
};

impl Agent {
    /// The agent's home folder. `env` looks up a variable (the real one is `std::env::var_os`);
    /// `userprofile` is the user's profile folder, as the rest of the core resolves it.
    pub fn home_with(
        &self,
        env: impl Fn(&str) -> Option<OsString>,
        userprofile: Option<&Path>,
    ) -> Option<PathBuf> {
        if let Some(var) = self.home_env {
            if let Some(v) = env(var).filter(|v| !v.is_empty()) {
                return Some(PathBuf::from(v));
            }
        }
        userprofile.map(|p| p.join(self.home_dir_name))
    }

    pub fn home(&self) -> Option<PathBuf> {
        let profile = crate::platform::user_home();
        self.home_with(|k| std::env::var_os(k), profile.as_deref())
    }

    /// Whether a process is this agent. `name` is the executable file name; `cmdline` is the
    /// full command line when known.
    pub fn matches_process(&self, name: &str, cmdline: Option<&str>) -> bool {
        let lower = name.to_ascii_lowercase();
        if self.executables.contains(&lower.as_str()) {
            return true;
        }
        match (self.node_marker, cmdline) {
            // npm on Windows launches the CLI by a backslash path (`node_modules\@github\copilot`).
            (Some(marker), Some(cmd)) => {
                lower == "node.exe" && cmd.replace('\\', "/").contains(marker)
            }
            _ => false,
        }
    }
}

impl Agent {
    /// Whether the agent has run with `home` as its home folder.
    pub fn detected_at(&self, home: Option<&Path>) -> bool {
        home.is_some_and(|h| {
            h.is_dir() && self.detect_marker.is_none_or(|m| h.join(m).exists())
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
        assert_eq!(CLAUDE.home_with(no_env, Some(p)), Some(p.join(".claude")));
        assert_eq!(CODEX.home_with(no_env, Some(p)), Some(p.join(".codex")));
        assert_eq!(COPILOT.home_with(no_env, Some(p)), Some(p.join(".copilot")));
        assert_eq!(CLAUDE.home_with(no_env, None), None);
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
            CODEX.home_with(env, Some(p)),
            Some(PathBuf::from("D:/codex"))
        );
        assert_eq!(
            COPILOT.home_with(env, Some(p)),
            Some(PathBuf::from("D:/copilot"))
        );
        // Claude has no override variable.
        assert_eq!(CLAUDE.home_with(env, Some(p)), Some(p.join(".claude")));
        // An empty override is ignored.
        let empty = |_: &str| Some(OsString::new());
        assert_eq!(CODEX.home_with(empty, Some(p)), Some(p.join(".codex")));
    }

    #[test]
    fn matches_exe_names_case_insensitively() {
        assert!(CLAUDE.matches_process("Claude.EXE", None));
        assert!(CODEX.matches_process("codex.exe", None));
        assert!(COPILOT.matches_process("COPILOT.exe", None));
        assert!(!CODEX.matches_process("claude.exe", None));
    }

    #[test]
    fn copilot_node_host_needs_marker() {
        let cmd = "node.exe /x/node_modules/@github/copilot/index.js";
        assert!(COPILOT.matches_process("node.exe", Some(cmd)));
        let win = r#""C:\Users\me\AppData\Roaming\npm\node_modules\@github\copilot\index.js""#;
        assert!(COPILOT.matches_process("node.exe", Some(win)));
        assert!(COPILOT.matches_process("NODE.EXE", Some(cmd)));
        assert!(!COPILOT.matches_process("node.exe", Some("node.exe server.js")));
        assert!(!COPILOT.matches_process("node.exe", None));
        assert!(!CODEX.matches_process("node.exe", Some(cmd)));
    }

    #[test]
    fn detected_checks_folder_exists() {
        let dir = std::env::temp_dir().join(format!("bashboard-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!CLAUDE.detected_at(Some(&dir)));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(CLAUDE.detected_at(Some(&dir)));
        assert!(!CLAUDE.detected_at(None));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copilot_needs_session_state_not_just_its_folder() {
        let dir = std::env::temp_dir().join(format!("bashboard-agents-cp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("config.json"), "{}").unwrap();
        assert!(!COPILOT.detected_at(Some(&dir)));
        std::fs::create_dir_all(dir.join("session-state")).unwrap();
        assert!(COPILOT.detected_at(Some(&dir)));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
