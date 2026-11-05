//! Local model servers for the dashboard's Local AI models section (docs/design.md section 3.19).
//!
//! The front end polls `model_servers_poll` while the section is wanted; each call asks Ollama
//! and LM Studio over loopback HTTP with short timeouts. A server that does not answer is simply
//! absent from the snapshot, never an error.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;

use crate::settings::SettingsState;

const OLLAMA_DEFAULT_URL: &str = "http://127.0.0.1:11434";
const LM_STUDIO_DEFAULT_URL: &str = "http://127.0.0.1:1234";
// Loopback answers in milliseconds; a longer wait only stalls the 5 second poll.
const TIMEOUT: Duration = Duration::from_millis(800);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedModel {
    pub name: String,
    /// Total bytes of the loaded model; 0 when the server does not say.
    pub size: u64,
    /// Bytes resident in GPU memory; `None` when the server does not say (LM Studio).
    pub size_vram: Option<u64>,
    pub context_length: Option<u64>,
    /// RFC 3339 time at which Ollama unloads the model.
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub url: String,
    pub version: Option<String>,
    pub models: Vec<LoadedModel>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelServersSnapshot {
    pub ollama: Option<ServerInfo>,
    pub lm_studio: Option<ServerInfo>,
    pub ollama_on_path: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub name: String,
    pub size: u64,
}

/// Turns an `OLLAMA_HOST`-style value into a base URL, as Ollama's own client does: a bind
/// address (`0.0.0.0`, `[::]`, or no host) becomes loopback, a missing scheme is `http`, and a
/// missing port is 11434, or the scheme's own port when a scheme was written.
fn normalize_host(raw: &str) -> Option<String> {
    let s = raw.trim().trim_end_matches('/');
    if s.is_empty() {
        return None;
    }
    let (scheme, rest, scheme_given) = if let Some(r) = s.strip_prefix("https://") {
        ("https", r, true)
    } else if let Some(r) = s.strip_prefix("http://") {
        ("http", r, true)
    } else {
        ("http", s, false)
    };
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        match after.split_once(']') {
            Some((h, tail)) => (format!("[{h}]"), tail.strip_prefix(':').unwrap_or("")),
            None => return None,
        }
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p),
            None => (authority.to_string(), ""),
        }
    };
    let host = match host.as_str() {
        "" | "0.0.0.0" | "[::]" => "127.0.0.1".to_string(),
        _ => host,
    };
    let port = if !port.is_empty() {
        port
    } else if !scheme_given {
        "11434"
    } else if scheme == "https" {
        "443"
    } else {
        "80"
    };
    Some(format!("{scheme}://{host}:{port}"))
}

/// The setting wins, then `OLLAMA_HOST`, then the standard loopback address.
fn resolve_ollama_url(setting: &str, env_host: Option<&str>) -> String {
    normalize_host(setting)
        .or_else(|| env_host.and_then(normalize_host))
        .unwrap_or_else(|| OLLAMA_DEFAULT_URL.to_string())
}

fn resolve_lm_studio_url(setting: &str) -> String {
    let s = setting.trim().trim_end_matches('/');
    if s.is_empty() {
        LM_STUDIO_DEFAULT_URL.to_string()
    } else if s.contains("://") {
        s.to_string()
    } else {
        format!("http://{s}")
    }
}

/// The body of a 2xx reply; any other status, or no answer, is `None`.
fn get(url: &str) -> Option<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        // Loopback servers never sit behind a proxy, so an `HTTPS_PROXY` must not reroute them.
        .proxy(None)
        .http_status_as_error(false)
        .build()
        .into();
    let resp = agent.get(url).call().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.into_body().read_to_string().ok()
}

#[derive(Deserialize)]
struct OllamaPs {
    #[serde(default)]
    models: Vec<OllamaPsModel>,
}

#[derive(Deserialize)]
struct OllamaPsModel {
    name: String,
    #[serde(default)]
    size: u64,
    size_vram: Option<u64>,
    context_length: Option<u64>,
    expires_at: Option<String>,
}

fn parse_ollama_ps(body: &str) -> Vec<LoadedModel> {
    serde_json::from_str::<OllamaPs>(body)
        .map(|p| {
            p.models
                .into_iter()
                .map(|m| LoadedModel {
                    name: m.name,
                    size: m.size,
                    size_vram: m.size_vram,
                    context_length: m.context_length,
                    expires_at: m.expires_at,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_ollama_version(body: &str) -> Option<String> {
    serde_json::from_str::<Value>(body).ok()?.get("version")?.as_str().map(str::to_string)
}

fn parse_ollama_tags(body: &str) -> Vec<InstalledModel> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    v.get("models")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| {
                    Some(InstalledModel {
                        name: m.get("name")?.as_str()?.to_string(),
                        size: m.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One row per loaded instance; `loaded_instances` is empty for models that are only on disk.
fn parse_lm_studio_models(body: &str) -> Vec<LoadedModel> {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return Vec::new() };
    let Some(models) = v.get("models").and_then(Value::as_array) else { return Vec::new() };
    let mut out = Vec::new();
    for m in models {
        let size = m.get("size_bytes").and_then(Value::as_u64).unwrap_or(0);
        let Some(instances) = m.get("loaded_instances").and_then(Value::as_array) else { continue };
        for inst in instances {
            let Some(name) = inst.get("id").and_then(Value::as_str) else { continue };
            out.push(LoadedModel {
                name: name.to_string(),
                size,
                size_vram: None,
                context_length: inst.pointer("/config/context_length").and_then(Value::as_u64),
                expires_at: None,
            });
        }
    }
    out
}

fn poll_ollama(url: &str) -> Option<ServerInfo> {
    get(&format!("{url}/"))?;
    let version = get(&format!("{url}/api/version")).as_deref().and_then(parse_ollama_version);
    let models = get(&format!("{url}/api/ps")).as_deref().map(parse_ollama_ps).unwrap_or_default();
    Some(ServerInfo { url: url.to_string(), version, models })
}

fn poll_lm_studio(url: &str) -> Option<ServerInfo> {
    let body = get(&format!("{url}/api/v1/models"))?;
    // A reply without a `models` array is some other server on the port.
    serde_json::from_str::<Value>(&body).ok()?.get("models")?.as_array()?;
    Some(ServerInfo { url: url.to_string(), version: None, models: parse_lm_studio_models(&body) })
}

fn ollama_on_path() -> bool {
    let Some(path) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&path).any(|dir| {
        ["ollama.exe", "ollama.cmd", "ollama"].iter().any(|n| {
            let p: PathBuf = dir.join(n);
            p.is_file()
        })
    })
}

fn ollama_url_now(state: &SettingsState) -> String {
    let setting = state.current().local_models.ollama_url;
    resolve_ollama_url(&setting, std::env::var("OLLAMA_HOST").ok().as_deref())
}

#[tauri::command]
pub async fn model_servers_poll(state: State<'_, SettingsState>) -> Result<ModelServersSnapshot, String> {
    let lm_url = resolve_lm_studio_url(&state.current().local_models.lm_studio_url);
    let ollama_url = ollama_url_now(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let (ollama, lm_studio) = std::thread::scope(|s| {
            let o = s.spawn(|| poll_ollama(&ollama_url));
            let l = s.spawn(|| poll_lm_studio(&lm_url));
            (o.join().ok().flatten(), l.join().ok().flatten())
        });
        ModelServersSnapshot { ollama, lm_studio, ollama_on_path: ollama_on_path() }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Installed Ollama models, for the launcher; empty when the server does not answer.
#[tauri::command]
pub async fn model_servers_ollama_models(state: State<'_, SettingsState>) -> Result<Vec<InstalledModel>, String> {
    let url = ollama_url_now(&state);
    tauri::async_runtime::spawn_blocking(move || {
        get(&format!("{url}/api/tags")).as_deref().map(parse_ollama_tags).unwrap_or_default()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Bodies captured from Ollama 0.40.14.
    const PS: &str = r#"{"models":[{"name":"gemma4:e2b","model":"gemma4:e2b","size":330783784,"digest":"b37049369adfe3d2b653af0ab301a062ca5cbe96ace6aa0d3f2559ee9b563fc2","details":{"parent_model":"","format":"gguf","family":"gemma4","families":["gemma4"],"parameter_size":"4.6B","quantization_level":"Q4_K_M"},"expires_at":"2026-11-04T16:48:06.0815902-06:00","size_vram":330783784,"context_length":4096,"runner":"llamacpp"}]}"#;
    const TAGS: &str = r#"{"models":[{"name":"gemma4:e2b","model":"gemma4:e2b","modified_at":"2026-11-04T15:50:32.849122-06:00","size":4587156505,"digest":"b37049369adfe3d2b653af0ab301a062ca5cbe96ace6aa0d3f2559ee9b563fc2","details":{"parent_model":"x","format":"gguf","family":"gemma4","families":["gemma4"],"parameter_size":"4.6B","quantization_level":"Q4_K_M","context_length":131072},"capabilities":["completion"]}]}"#;
    // Shape from LM Studio's REST list-models docs.
    const LM: &str = r#"{"models":[{"type":"llm","publisher":"google","key":"google/gemma-4-26b-a4b","display_name":"Gemma 4 26B A4B","size_bytes":17990911801,"loaded_instances":[{"id":"google/gemma-4-26b-a4b","config":{"context_length":4096,"parallel":4}}],"max_context_length":262144},{"type":"llm","key":"deepseek/r1","size_bytes":5,"loaded_instances":[]}]}"#;

    fn url(setting: &str, env: Option<&str>) -> String {
        resolve_ollama_url(setting, env)
    }

    #[test]
    fn ollama_url_defaults() {
        assert_eq!(url("", None), "http://127.0.0.1:11434");
        assert_eq!(url("", Some("")), "http://127.0.0.1:11434");
        assert_eq!(url("  ", Some("  ")), "http://127.0.0.1:11434");
    }

    #[test]
    fn ollama_host_forms() {
        assert_eq!(url("", Some("0.0.0.0")), "http://127.0.0.1:11434");
        assert_eq!(url("", Some("0.0.0.0:11435")), "http://127.0.0.1:11435");
        assert_eq!(url("", Some(":8080")), "http://127.0.0.1:8080");
        assert_eq!(url("", Some("[::]")), "http://127.0.0.1:11434");
        assert_eq!(url("", Some("[::1]:9000")), "http://[::1]:9000");
        assert_eq!(url("", Some("myhost")), "http://myhost:11434");
        assert_eq!(url("", Some("myhost:1234")), "http://myhost:1234");
        assert_eq!(url("", Some("http://myhost")), "http://myhost:80");
        assert_eq!(url("", Some("https://myhost")), "https://myhost:443");
        assert_eq!(url("", Some("https://myhost:8443/")), "https://myhost:8443");
        assert_eq!(url("", Some("http://0.0.0.0:11434/api")), "http://127.0.0.1:11434");
    }

    #[test]
    fn setting_wins_over_env() {
        assert_eq!(url("http://box:1", Some("other:2")), "http://box:1");
    }

    #[test]
    fn lm_studio_url_forms() {
        assert_eq!(resolve_lm_studio_url(""), "http://127.0.0.1:1234");
        assert_eq!(resolve_lm_studio_url("localhost:4321/"), "http://localhost:4321");
        assert_eq!(resolve_lm_studio_url("http://box:1234"), "http://box:1234");
    }

    #[test]
    fn parses_ps() {
        let m = parse_ollama_ps(PS);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "gemma4:e2b");
        assert_eq!(m[0].size, 330783784);
        assert_eq!(m[0].size_vram, Some(330783784));
        assert_eq!(m[0].context_length, Some(4096));
        assert_eq!(m[0].expires_at.as_deref(), Some("2026-11-04T16:48:06.0815902-06:00"));
        assert!(parse_ollama_ps(r#"{"models":[]}"#).is_empty());
        assert!(parse_ollama_ps("not json").is_empty());
    }

    #[test]
    fn parses_version_and_tags() {
        assert_eq!(parse_ollama_version(r#"{"version":"0.40.14"}"#).as_deref(), Some("0.40.14"));
        assert_eq!(parse_ollama_version("nope"), None);
        let t = parse_ollama_tags(TAGS);
        assert_eq!(t, vec![InstalledModel { name: "gemma4:e2b".into(), size: 4587156505 }]);
    }

    #[test]
    fn parses_lm_studio_loaded_instances() {
        let m = parse_lm_studio_models(LM);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].name, "google/gemma-4-26b-a4b");
        assert_eq!(m[0].context_length, Some(4096));
        assert_eq!(m[0].size_vram, None);
    }
}
