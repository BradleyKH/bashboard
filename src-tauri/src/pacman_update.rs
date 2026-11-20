//! Updates an Arch package install with pacman (docs/design/app.md section 3.16).
//!
//! The updater plugin installs only `.deb`, `.rpm`, and AppImage updates, picking one by the
//! package type the bundler stamped into the binary. The Arch package carries the `.rpm`'s binary,
//! so left to the plugin it would look up the `.rpm` entry and run `rpm -U` on Arch. Instead the
//! front end asks `update_target` first: on a pacman install it checks `linux-x86_64-arch`, and
//! installs through `update_install_pacman`, which downloads with the plugin (so the signature is
//! still verified) and hands the package to `pkexec pacman -U`.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde::Serialize;
use tauri::ipc::Channel;

/// The `latest.json` key the release workflow gives the Arch package.
const ARCH_TARGET: &str = "linux-x86_64-arch";

/// The plugin's own download event shape, so `updateNotice.ts` handles both the same way.
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

/// The update target to check instead of the plugin's own, or `None` to let it choose.
#[tauri::command]
pub fn update_target() -> Option<&'static str> {
    installed_by_pacman().then_some(ARCH_TARGET)
}

/// Downloads the Arch package update and installs it with pacman. The front end relaunches after.
#[tauri::command]
pub async fn update_install_pacman(
    app: tauri::AppHandle,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        install(app, on_event).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, on_event);
        Err("pacman updates are Linux only".into())
    }
}

#[cfg(target_os = "linux")]
async fn install(app: tauri::AppHandle, on_event: Channel<DownloadEvent>) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater_builder()
        .target(ARCH_TARGET)
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no update is available")?;
    let mut started = false;
    // `download` verifies the signature against the public key in tauri.conf.json.
    let bytes = update
        .download(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    let version = update.version.clone();
    tauri::async_runtime::spawn_blocking(move || install_bytes(&bytes, &version))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes the package where root can read it and runs pacman through polkit.
#[cfg(target_os = "linux")]
fn install_bytes(bytes: &[u8], version: &str) -> Result<(), String> {
    use std::process::Command;

    let dir = std::env::temp_dir().join(format!("bashboard-update-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not stage the update: {e}"))?;
    // pacman -U reads the compression from the file name.
    let pkg = dir.join(format!(
        "bashboard-{}-1-x86_64.pkg.tar.zst",
        version.replace('-', "_")
    ));
    let result = (|| {
        std::fs::write(&pkg, bytes).map_err(|e| format!("could not stage the update: {e}"))?;
        let mut cmd = Command::new("pkexec");
        cmd.args(["pacman", "-U", "--noconfirm"]).arg(&pkg);
        let out = crate::child_process::prepare(&mut cmd)
            .output()
            .map_err(|e| {
                format!("could not run pkexec ({e}); install polkit, or update with pacman")
            })?;
        pacman_result(out.status.code(), &String::from_utf8_lossy(&out.stderr))
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

/// pkexec exits 126 when the prompt is dismissed and 127 when authentication fails. The wording
/// of both errors matches the plugin's, which `updateErrorModel.ts` recognizes.
fn pacman_result(code: Option<i32>, stderr: &str) -> Result<(), String> {
    match code {
        Some(0) => Ok(()),
        Some(126 | 127) => Err("Authentication failed or was cancelled".into()),
        _ => {
            let detail = stderr
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            Err(format!("Failed to install package: {detail}"))
        }
    }
}

/// Whether pacman owns the running binary. Asked once, before an update could replace it.
fn installed_by_pacman() -> bool {
    #[cfg(target_os = "linux")]
    {
        use std::sync::OnceLock;
        static OWNED: OnceLock<bool> = OnceLock::new();
        *OWNED.get_or_init(|| {
            if std::env::var_os("APPIMAGE").is_some() {
                return false;
            }
            let Ok(exe) = std::env::current_exe() else {
                return false;
            };
            let mut cmd = std::process::Command::new("pacman");
            cmd.arg("-Qqo").arg(&exe);
            crate::child_process::prepare(&mut cmd)
                .output()
                .is_ok_and(|out| {
                    out.status.success()
                        && String::from_utf8_lossy(&out.stdout).trim() == "bashboard"
                })
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkexec_refusals_read_as_cancelled() {
        for code in [126, 127] {
            assert_eq!(
                pacman_result(Some(code), ""),
                Err("Authentication failed or was cancelled".into())
            );
        }
    }

    #[test]
    fn pacman_failure_keeps_its_last_line() {
        let err = pacman_result(
            Some(1),
            "loading packages...\nerror: failed to commit transaction\n\n",
        )
        .unwrap_err();
        assert_eq!(
            err,
            "Failed to install package: error: failed to commit transaction"
        );
        assert_eq!(pacman_result(Some(0), "warning"), Ok(()));
    }

    #[test]
    fn download_events_match_the_plugin() {
        let json = |e| serde_json::to_string(&e).unwrap();
        assert_eq!(
            json(DownloadEvent::Started {
                content_length: Some(5)
            }),
            r#"{"event":"Started","data":{"contentLength":5}}"#
        );
        assert_eq!(
            json(DownloadEvent::Progress { chunk_length: 3 }),
            r#"{"event":"Progress","data":{"chunkLength":3}}"#
        );
        assert_eq!(json(DownloadEvent::Finished), r#"{"event":"Finished"}"#);
    }
}
