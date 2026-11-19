//! The default output device's volume and mute on Linux, for the dashboard's Media section
//! (docs/design/dashboard.md section 3.29).
//!
//! The section's volume controls act on the system volume on every OS, since a browser shares
//! one audio stream across its tabs, and Chromium and Firefox report a fixed MPRIS `Volume` and
//! ignore writes to it. Linux has two sound servers in scope: PipeWire (Ubuntu 22.10 and later,
//! Debian 12, Fedora, Arch, RHEL 10), whose `wpctl` comes with WirePlumber, and PulseAudio
//! (Ubuntu 22.04), whose `pactl` PipeWire systems do not always install. The tools are run rather
//! than linked, so the packages gain no library dependency; neither has a change feed both share,
//! so the media worker rereads the volume each second while a player shows, as on Windows.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Clone, Debug, PartialEq)]
pub enum Tool {
    Wpctl(PathBuf),
    Pactl(PathBuf),
}

const WPCTL_SINK: &str = "@DEFAULT_AUDIO_SINK@";
const PACTL_SINK: &str = "@DEFAULT_SINK@";

/// The first tool on the `PATH` a child sees: `wpctl`, else `pactl`.
pub fn find() -> Option<Tool> {
    let path = crate::child_process::var("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    let on_path = |exe: &str| dirs.iter().map(|d| d.join(exe)).find(|p| p.is_file());
    on_path("wpctl")
        .map(Tool::Wpctl)
        .or_else(|| on_path("pactl").map(Tool::Pactl))
}

impl Tool {
    /// The volume, 0 to 1 (a boosted volume reads as 1), and whether the device is muted.
    pub fn read(&self) -> Option<(f32, bool)> {
        match self {
            Tool::Wpctl(exe) => parse_wpctl(&output(exe, &["get-volume", WPCTL_SINK])?),
            Tool::Pactl(exe) => {
                let volume = parse_pactl_volume(&output(exe, &["get-sink-volume", PACTL_SINK])?)?;
                let muted = parse_pactl_mute(&output(exe, &["get-sink-mute", PACTL_SINK])?)?;
                Some((volume, muted))
            }
        }
    }

    /// Sets the volume, 0 to 1, leaving mute alone.
    pub fn set(&self, level: f32) -> Result<(), String> {
        let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 0.0 };
        match self {
            Tool::Wpctl(exe) => run(exe, &["set-volume", WPCTL_SINK, &format!("{level:.3}")]),
            Tool::Pactl(exe) => {
                let percent = format!("{}%", (level * 100.0).round());
                run(exe, &["set-sink-volume", PACTL_SINK, &percent])
            }
        }
    }

    pub fn toggle_mute(&self) -> Result<(), String> {
        match self {
            Tool::Wpctl(exe) => run(exe, &["set-mute", WPCTL_SINK, "toggle"]),
            Tool::Pactl(exe) => run(exe, &["set-sink-mute", PACTL_SINK, "toggle"]),
        }
    }
}

fn command(exe: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(exe);
    cmd.args(args);
    crate::child_process::prepare(&mut cmd);
    cmd
}

fn output(exe: &Path, args: &[&str]) -> Option<String> {
    let out = command(exe, args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run(exe: &Path, args: &[&str]) -> Result<(), String> {
    let out = command(exe, args)
        .output()
        .map_err(|e| format!("{}: {e}", exe.display()))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `wpctl get-volume`: `Volume: 0.45`, with ` [MUTED]` after it when muted.
fn parse_wpctl(out: &str) -> Option<(f32, bool)> {
    let rest = out.trim().strip_prefix("Volume:")?.trim();
    let number = rest.split_whitespace().next()?;
    let volume: f32 = number.parse().ok()?;
    Some((volume.clamp(0.0, 1.0), rest.contains("[MUTED]")))
}

/// `pactl get-sink-volume`: the mean of the channels' percentages, as in
/// `Volume: front-left: 29491 /  45% / -20.81 dB,   front-right: 29491 /  45% / -20.81 dB`.
fn parse_pactl_volume(out: &str) -> Option<f32> {
    let line = out.lines().find(|l| l.trim_start().starts_with("Volume:"))?;
    let percents: Vec<f32> = line
        .split('/')
        .filter_map(|part| part.trim().strip_suffix('%')?.trim().parse().ok())
        .collect();
    if percents.is_empty() {
        return None;
    }
    let mean = percents.iter().sum::<f32>() / percents.len() as f32;
    Some((mean / 100.0).clamp(0.0, 1.0))
}

/// `pactl get-sink-mute`: `Mute: yes` or `Mute: no`.
fn parse_pactl_mute(out: &str) -> Option<bool> {
    match out.trim().strip_prefix("Mute:")?.trim() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wpctl_reads_volume_and_mute() {
        assert_eq!(parse_wpctl("Volume: 0.45\n"), Some((0.45, false)));
        assert_eq!(parse_wpctl("Volume: 0.30 [MUTED]\n"), Some((0.30, true)));
        assert_eq!(parse_wpctl("Volume: 1.25\n"), Some((1.0, false)));
        assert_eq!(parse_wpctl("Translate ID error\n"), None);
    }

    #[test]
    fn pactl_averages_the_channels() {
        let out = concat!(
            "Volume: front-left: 29491 /  45% / -20.81 dB,   ",
            "front-right: 26214 /  40% / -23.88 dB\n        balance -0.11\n",
        );
        assert_eq!(parse_pactl_volume(out), Some(0.425));
        assert_eq!(parse_pactl_volume("Volume: mono: 65536 / 100% / 0.00 dB\n"), Some(1.0));
        assert_eq!(parse_pactl_volume("Volume: mono: 98304 / 150% / 10.57 dB\n"), Some(1.0));
        assert_eq!(parse_pactl_volume("Connection failure\n"), None);
    }

    #[test]
    fn pactl_reads_mute() {
        assert_eq!(parse_pactl_mute("Mute: yes\n"), Some(true));
        assert_eq!(parse_pactl_mute("Mute: no\n"), Some(false));
        assert_eq!(parse_pactl_mute(""), None);
    }
}
