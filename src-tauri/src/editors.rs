//! Editor detection, `open_in_editor`, and `open_with_default_app` (docs/design/files.md
//! section 3.12).
//!
//! Every editor runs from its `.exe` with an argument list, never through a shell (section 9).
//! VS Code, Cursor, Windsurf, VS Code Insiders, and VSCodium put only `.cmd` shims on `PATH`, so a
//! shim found there is traded for the exe one folder up. JetBrains IDEs are found by exe name on
//! `PATH`, through a Toolbox App script on `PATH`, or in install folders by `product-info.json`
//! version (`find_jetbrains`). Vim and Neovim run inside a terminal, so `open_in_editor` returns
//! their argument list for the front end to run in a pane rather than starting them itself.
//!
//! Off Windows, `detect_posix` replaces all of that: each editor's own CLI inside its macOS app
//! bundle (`bundle_executable`), else a bare CLI name on `PATH` and in the Homebrew folders, else a
//! JetBrains Toolbox script. On Linux the search adds `~/.local/bin` and `/snap/bin`, Flatpak's
//! exported launchers, and last the `Exec=` program of an editor's `.desktop` file (an AppImage or
//! tarball install). The tables are plain functions over `SearchEnv`, so they are tested on every
//! platform. Beyond the table, `editors` adds the editors the system itself lists: Linux desktop
//! entries (`editor_desktop`) and macOS app bundles (`editor_bundles`), each skipping what the
//! table covers (`table_covers_desktop_id`, `table_covers_bundle`). Files whose default app would run them open as text through
//! `/usr/bin/open -t` on macOS, and on Linux through the `Exec=` line of the default `text/plain`
//! app's `.desktop` file, instead of Notepad.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::State;

use crate::settings::SettingsState;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Editor {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct Opened {
    fallback: bool,
    /// For a terminal editor, what the front end runs in a new pane; nothing has been started.
    #[serde(skip_serializing_if = "Option::is_none")]
    terminal: Option<TerminalLaunch>,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct TerminalLaunch {
    argv: Vec<String>,
    cwd: String,
}

const NAMES: [(&str, &str); 20] = [
    ("zed", "Zed"),
    ("vscode", "VS Code"),
    ("cursor", "Cursor"),
    ("visualStudio", "Visual Studio"),
    ("notepadpp", "Notepad++"),
    ("sublime", "Sublime Text"),
    ("rider", "Rider"),
    ("intellij", "IntelliJ IDEA"),
    ("webstorm", "WebStorm"),
    ("pycharm", "PyCharm"),
    ("rustrover", "RustRover"),
    ("goland", "GoLand"),
    ("clion", "CLion"),
    ("phpstorm", "PhpStorm"),
    ("windsurf", "Windsurf"),
    ("vscodeInsiders", "VS Code Insiders"),
    ("vscodium", "VSCodium"),
    ("vim", "Vim"),
    ("nvim", "Neovim"),
    ("default", "The file's default app"),
];

/// The folders detection looks in, gathered once so tests can point them at temp folders.
#[derive(Debug, Default)]
struct SearchEnv {
    path: Vec<PathBuf>,
    /// Folders holding `.app` bundles (macOS only).
    applications: Vec<PathBuf>,
    /// Folders searched after `PATH` off Windows: a macOS app started from the Dock gets a minimal
    /// `PATH`, so Homebrew's folders are checked by hand.
    bin_dirs: Vec<PathBuf>,
    /// Where the JetBrains Toolbox App writes its launcher scripts (macOS and Linux only).
    toolbox_scripts: Option<PathBuf>,
    /// Flatpak's `exports/bin` folders, whose launchers forward their arguments to `flatpak run`
    /// (Linux only).
    flatpak_bins: Vec<PathBuf>,
    /// Folders searched for `.desktop` files (Linux only).
    desktop_dirs: Vec<PathBuf>,
    local_app_data: Option<PathBuf>,
    program_files: Option<PathBuf>,
    program_files_x86: Option<PathBuf>,
}

impl SearchEnv {
    fn from_process() -> Self {
        let var = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        let home = var("HOME");
        let mac_home = home.clone().filter(|_| cfg!(target_os = "macos"));
        let linux_home = home.filter(|_| cfg!(target_os = "linux"));
        let (flatpak_bins, desktop_dirs) = match linux_home.as_deref() {
            Some(home) => {
                let data = user_data_home(crate::child_process::var("XDG_DATA_HOME").as_deref(), home);
                (
                    flatpak_bin_dirs(&data),
                    linux_desktop_dirs(crate::desktop_entry::system_application_dirs(), &data),
                )
            }
            None => (vec![], vec![]),
        };
        Self {
            path: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            applications: if cfg!(target_os = "macos") {
                application_dirs(mac_home.as_deref())
            } else {
                vec![]
            },
            bin_dirs: if cfg!(windows) {
                vec![]
            } else {
                posix_bin_dirs(linux_home.as_deref())
            },
            toolbox_scripts: mac_home
                .as_deref()
                .map(toolbox_scripts_dir)
                .or_else(|| linux_home.as_deref().map(linux_toolbox_scripts_dir)),
            flatpak_bins,
            desktop_dirs,
            local_app_data: var("LOCALAPPDATA"),
            program_files: var("ProgramFiles"),
            program_files_x86: var("ProgramFiles(x86)"),
        }
    }
}

/// Where macOS apps install: system-wide, and per user (the JetBrains Toolbox App installs there).
fn application_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    dirs.extend(home.map(|h| h.join("Applications")));
    dirs
}

fn toolbox_scripts_dir(home: &Path) -> PathBuf {
    home.join("Library/Application Support/JetBrains/Toolbox/scripts")
}

fn linux_toolbox_scripts_dir(home: &Path) -> PathBuf {
    home.join(".local/share/JetBrains/Toolbox/scripts")
}

/// The folders checked by hand after `PATH`. `linux_home` is set only on Linux, which adds Snap's
/// command folder and the per-user `~/.local/bin` that `pip`, `npm`, and tarball installers use.
fn posix_bin_dirs(linux_home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        .into_iter()
        .map(PathBuf::from)
        .collect();
    if let Some(home) = linux_home {
        dirs.push(home.join(".local/bin"));
        dirs.push(PathBuf::from("/snap/bin"));
    }
    dirs
}

/// `$XDG_DATA_HOME`, else `~/.local/share`; Flatpak's per-user installation lives under it.
fn user_data_home(xdg_data_home: Option<&str>, home: &Path) -> PathBuf {
    match xdg_data_home.filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => home.join(".local/share"),
    }
}

/// Flatpak's exported launcher folders: system-wide, then per user.
fn flatpak_bin_dirs(user_data: &Path) -> Vec<PathBuf> {
    vec![
        PathBuf::from("/var/lib/flatpak/exports/bin"),
        user_data.join("flatpak/exports/bin"),
    ]
}

/// The XDG application folders plus the ones Flatpak and Snap export their `.desktop` files to,
/// which a session not started through a login shell may leave out of `XDG_DATA_DIRS`.
fn linux_desktop_dirs(xdg: Vec<PathBuf>, user_data: &Path) -> Vec<PathBuf> {
    let mut dirs = xdg;
    let extra = [
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
        user_data.join("flatpak/exports/share/applications"),
        PathBuf::from("/var/lib/snapd/desktop/applications"),
    ];
    for dir in extra {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// CLI names looked for on `PATH` off Windows. A JetBrains name is also its launcher's name in
/// the bundle and its Toolbox script's name.
fn posix_path_names(id: &str) -> &'static [&'static str] {
    match id {
        "zed" => &["zed"],
        "vscode" => &["code"],
        "cursor" => &["cursor"],
        "sublime" => &["subl"],
        "windsurf" => &["windsurf"],
        "vscodeInsiders" => &["code-insiders"],
        "vscodium" => &["codium"],
        "rider" => &["rider"],
        "intellij" => &["idea"],
        "webstorm" => &["webstorm"],
        "pycharm" => &["pycharm"],
        "rustrover" => &["rustrover"],
        "goland" => &["goland"],
        "clion" => &["clion"],
        "phpstorm" => &["phpstorm"],
        _ => &[],
    }
}

/// An editor's CLI inside its macOS app bundle, relative to an Applications folder, in the order
/// tried. These are the editors' own launchers, which take the arguments `table_args` builds and
/// hand the file to a running instance. Visual Studio and Notepad++ have no macOS build. The
/// free and paid editions of IntelliJ IDEA and PyCharm ship different bundle names but the same
/// launcher name, so either counts.
fn bundle_candidates(id: &str) -> &'static [&'static str] {
    match id {
        "zed" => &["Zed.app/Contents/MacOS/cli"],
        "vscode" => &["Visual Studio Code.app/Contents/Resources/app/bin/code"],
        "vscodeInsiders" => &[
            "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
            "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code",
        ],
        "cursor" => &[
            "Cursor.app/Contents/Resources/app/bin/cursor",
            "Cursor.app/Contents/Resources/app/bin/code",
        ],
        "windsurf" => &["Windsurf.app/Contents/Resources/app/bin/windsurf"],
        "vscodium" => &["VSCodium.app/Contents/Resources/app/bin/codium"],
        "sublime" => &["Sublime Text.app/Contents/SharedSupport/bin/subl"],
        "intellij" => &[
            "IntelliJ IDEA.app/Contents/MacOS/idea",
            "IntelliJ IDEA CE.app/Contents/MacOS/idea",
        ],
        "pycharm" => &[
            "PyCharm.app/Contents/MacOS/pycharm",
            "PyCharm CE.app/Contents/MacOS/pycharm",
            "PyCharm Professional Edition.app/Contents/MacOS/pycharm",
        ],
        "rider" => &["Rider.app/Contents/MacOS/rider"],
        "webstorm" => &["WebStorm.app/Contents/MacOS/webstorm"],
        "rustrover" => &["RustRover.app/Contents/MacOS/rustrover"],
        "goland" => &["GoLand.app/Contents/MacOS/goland"],
        "clion" => &["CLion.app/Contents/MacOS/clion"],
        "phpstorm" => &["PhpStorm.app/Contents/MacOS/phpstorm"],
        _ => &[],
    }
}

/// The first existing CLI from `bundle_candidates`, trying each Applications folder in order.
fn bundle_executable(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    env.applications
        .iter()
        .flat_map(|apps| bundle_candidates(id).iter().map(move |rel| apps.join(rel)))
        .find(|p| p.is_file())
}

/// Command names Snap gives editors whose snap is not named like the CLI: the JetBrains IDEs
/// that ship in separate Community and paid snaps. The others (`code`, `codium`, `subl`,
/// `webstorm`, ...) keep their `posix_path_names` name.
fn snap_command_names(id: &str) -> &'static [&'static str] {
    match id {
        "intellij" => &["intellij-idea-community", "intellij-idea-ultimate"],
        "pycharm" => &["pycharm-community", "pycharm-professional"],
        _ => &[],
    }
}

fn find_on_path_posix(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    let names = || posix_path_names(id).iter().chain(snap_command_names(id));
    env.path
        .iter()
        .chain(&env.bin_dirs)
        .flat_map(|dir| names().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
}

/// The Toolbox App's launcher script for a JetBrains IDE. It is a shell script, so unlike the
/// Windows one it is run directly rather than read.
fn toolbox_script(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    jetbrains(id)?;
    let name = posix_path_names(id).first()?;
    let script = env.toolbox_scripts.as_ref()?.join(name);
    script.is_file().then_some(script)
}

/// Flatpak application ids per editor. Cursor and Windsurf have no Flatpak, and VS Code Insiders
/// has no id worth guessing.
fn flatpak_app_ids(id: &str) -> &'static [&'static str] {
    match id {
        "vscode" => &["com.visualstudio.code"],
        "vscodium" => &["com.vscodium.codium"],
        "sublime" => &["com.sublimetext.three"],
        "zed" => &["dev.zed.Zed"],
        "intellij" => &[
            "com.jetbrains.IntelliJ-IDEA-Community",
            "com.jetbrains.IntelliJ-IDEA-Ultimate",
        ],
        "pycharm" => &[
            "com.jetbrains.PyCharm-Community",
            "com.jetbrains.PyCharm-Professional",
        ],
        "rider" => &["com.jetbrains.Rider"],
        "webstorm" => &["com.jetbrains.WebStorm"],
        "goland" => &["com.jetbrains.GoLand"],
        "clion" => &["com.jetbrains.CLion"],
        "phpstorm" => &["com.jetbrains.PhpStorm"],
        "rustrover" => &["com.jetbrains.RustRover"],
        _ => &[],
    }
}

/// A Flatpak's exported launcher, which hands its arguments to `flatpak run`.
fn flatpak_launcher(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    env.flatpak_bins
        .iter()
        .flat_map(|dir| flatpak_app_ids(id).iter().map(move |app| dir.join(app)))
        .find(|p| p.is_file())
}

/// Desktop ids of the editors a package, tarball, or AppImage installs with a fixed name. The
/// JetBrains IDEs are matched by `jetbrains_desktop_prefix` instead.
fn desktop_ids(id: &str) -> &'static [&'static str] {
    match id {
        "vscode" => &["code.desktop"],
        "vscodeInsiders" => &["code-insiders.desktop"],
        "vscodium" => &["codium.desktop"],
        "cursor" => &["cursor.desktop"],
        "windsurf" => &["windsurf.desktop"],
        "sublime" => &["sublime_text.desktop"],
        "zed" => &["zed.desktop", "dev.zed.Zed.desktop"],
        _ => &[],
    }
}

/// What a JetBrains IDE's `.desktop` file name starts with. The Toolbox App appends a hash
/// (`jetbrains-idea-3f9c2a1.desktop`) and tarball installs add `-ce` and the like.
fn jetbrains_desktop_prefix(id: &str) -> Option<&'static str> {
    Some(match id {
        "intellij" => "jetbrains-idea",
        "pycharm" => "jetbrains-pycharm",
        "rider" => "jetbrains-rider",
        "webstorm" => "jetbrains-webstorm",
        "rustrover" => "jetbrains-rustrover",
        "goland" => "jetbrains-goland",
        "clion" => "jetbrains-clion",
        "phpstorm" => "jetbrains-phpstorm",
        _ => return None,
    })
}

/// Whether `name` is `<prefix>.desktop` or `<prefix>-<anything>.desktop`, so `jetbrains-idea`
/// matches `jetbrains-idea-ce.desktop` and not another product that merely starts the same way.
fn is_jetbrains_desktop_name(prefix: &str, name: &str) -> bool {
    name.strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(".desktop"))
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('-'))
}

/// Programs an `Exec=` line starts to run something else, which the Flatpak and Snap launchers
/// above cover.
const WRAPPERS: [&str; 5] = ["flatpak", "env", "sh", "bash", "snap"];

/// The program a `.desktop` entry runs, when it is the editor itself: an absolute path, not a
/// wrapper, and not a terminal program. A bare name is left to `PATH`, which was searched already.
fn desktop_program(entry: &crate::desktop_entry::Entry) -> Option<PathBuf> {
    if entry.terminal {
        return None;
    }
    let program = PathBuf::from(crate::desktop_entry::exec_program(entry)?);
    let wrapper = program
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| WRAPPERS.contains(&n));
    (program.has_root() && !wrapper).then_some(program)
}

/// The editor's program, with the arguments its `Exec=` line puts before the file (an AppImage's
/// `--no-sandbox`), from the first `.desktop` file in `env.desktop_dirs` that names an existing
/// program.
fn desktop_executable(id: &str, env: &SearchEnv) -> Option<(PathBuf, Vec<String>)> {
    for dir in &env.desktop_dirs {
        let mut files: Vec<PathBuf> = desktop_ids(id).iter().map(|f| dir.join(f)).collect();
        if let Some(prefix) = jetbrains_desktop_prefix(id) {
            let mut names: Vec<String> = std::fs::read_dir(dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| is_jetbrains_desktop_name(prefix, n))
                .collect();
            names.sort();
            files.extend(names.into_iter().map(|n| dir.join(n)));
        }
        for file in files {
            let found = std::fs::read_to_string(&file)
                .ok()
                .and_then(|text| crate::desktop_entry::parse(&text))
                .and_then(|entry| {
                    let program = desktop_program(&entry)?;
                    Some((program, crate::desktop_entry::exec_args_before_field(&entry)))
                });
            if let Some(found) = found.filter(|(p, _)| p.is_file()) {
                return Some(found);
            }
        }
    }
    None
}

/// `detect` off Windows. A bundle comes first because a `PATH` entry for the same CLI is usually
/// a symlink into it, and the bundle works when the Dock-launched app has no such `PATH`.
#[cfg(test)]
fn detect_posix(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    detect_posix_with_args(id, env).map(|(p, _)| p)
}

/// `detect_posix` and the arguments to put before the file's own: only a `.desktop` match has
/// any.
fn detect_posix_with_args(id: &str, env: &SearchEnv) -> Option<(PathBuf, Vec<String>)> {
    if is_terminal_editor(id) {
        return find_terminal_editor(id, env).map(|p| (p, Vec::new()));
    }
    bundle_executable(id, env)
        .or_else(|| find_on_path_posix(id, env))
        .or_else(|| toolbox_script(id, env))
        .or_else(|| flatpak_launcher(id, env))
        .map(|p| (p, Vec::new()))
        .or_else(|| desktop_executable(id, env))
}

/// Executable names looked for on `PATH`, and `(shim, exe)` pairs where a `.cmd` shim on `PATH`
/// stands for an exe in its parent folder.
fn path_names(
    id: &str,
) -> (
    &'static [&'static str],
    &'static [(&'static str, &'static str)],
) {
    match id {
        "zed" => (&["zed.exe"], &[]),
        "vscode" => (&["Code.exe"], &[("code.cmd", "Code.exe")]),
        "cursor" => (&["Cursor.exe"], &[("cursor.cmd", "Cursor.exe")]),
        "notepadpp" => (&["notepad++.exe"], &[]),
        "sublime" => (&["subl.exe"], &[]),
        "windsurf" => (&["Windsurf.exe"], &[("windsurf.cmd", "Windsurf.exe")]),
        "vscodeInsiders" => (
            &["Code - Insiders.exe"],
            &[("code-insiders.cmd", "Code - Insiders.exe")],
        ),
        "vscodium" => (&["VSCodium.exe"], &[("codium.cmd", "VSCodium.exe")]),
        _ => (&[], &[]),
    }
}

/// Usual install locations, first match wins. Zed's `bin\zed.exe` is its CLI, which understands
/// `<path>:<line>` and hands off to a running instance.
fn install_candidates(id: &str, env: &SearchEnv) -> Vec<PathBuf> {
    let under = |base: &Option<PathBuf>, rel: &str| base.as_ref().map(|b| b.join(rel));
    let list = match id {
        "zed" => vec![under(&env.local_app_data, r"Programs\Zed\bin\zed.exe")],
        "vscode" => vec![
            under(&env.local_app_data, r"Programs\Microsoft VS Code\Code.exe"),
            under(&env.program_files, r"Microsoft VS Code\Code.exe"),
        ],
        "cursor" => vec![under(&env.local_app_data, r"Programs\cursor\Cursor.exe")],
        "notepadpp" => vec![
            under(&env.program_files, r"Notepad++\notepad++.exe"),
            under(&env.program_files_x86, r"Notepad++\notepad++.exe"),
        ],
        "sublime" => vec![
            under(&env.program_files, r"Sublime Text\subl.exe"),
            under(&env.program_files, r"Sublime Text 3\subl.exe"),
        ],
        "windsurf" => vec![under(
            &env.local_app_data,
            r"Programs\Windsurf\Windsurf.exe",
        )],
        "vscodeInsiders" => vec![
            under(
                &env.local_app_data,
                r"Programs\Microsoft VS Code Insiders\Code - Insiders.exe",
            ),
            under(
                &env.program_files,
                r"Microsoft VS Code Insiders\Code - Insiders.exe",
            ),
        ],
        "vscodium" => vec![
            under(&env.local_app_data, r"Programs\VSCodium\VSCodium.exe"),
            under(&env.program_files, r"VSCodium\VSCodium.exe"),
        ],
        _ => vec![],
    };
    list.into_iter().flatten().collect()
}

fn find_on_path(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    let (exes, shims) = path_names(id);
    for dir in &env.path {
        for exe in exes {
            let p = dir.join(exe);
            if p.is_file() {
                return Some(p);
            }
        }
        for (shim, exe) in shims {
            if dir.join(shim).is_file() {
                if let Some(p) = dir.parent().map(|d| d.join(exe)).filter(|p| p.is_file()) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Visual Studio has no fixed folder or `PATH` entry; its installer's `vswhere.exe` reports the
/// latest instance's `devenv.exe`.
fn find_devenv(env: &SearchEnv) -> Option<PathBuf> {
    let vswhere = env
        .program_files_x86
        .as_ref()?
        .join(r"Microsoft Visual Studio\Installer\vswhere.exe");
    if !vswhere.is_file() {
        return None;
    }
    let mut cmd = Command::new(vswhere);
    cmd.args(["-latest", "-property", "productPath"])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    crate::child_process::prepare(&mut cmd);
    let out = cmd.output().ok()?;
    let path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    path.is_file().then_some(path)
}

/// A JetBrains IDE's `(exe, Toolbox App script)` names.
fn jetbrains(id: &str) -> Option<(&'static str, &'static str)> {
    Some(match id {
        "rider" => ("rider64.exe", "rider.cmd"),
        "intellij" => ("idea64.exe", "idea.cmd"),
        "webstorm" => ("webstorm64.exe", "webstorm.cmd"),
        "pycharm" => ("pycharm64.exe", "pycharm.cmd"),
        "rustrover" => ("rustrover64.exe", "rustrover.cmd"),
        "goland" => ("goland64.exe", "goland.cmd"),
        "clion" => ("clion64.exe", "clion.cmd"),
        "phpstorm" => ("phpstorm64.exe", "phpstorm.cmd"),
        _ => return None,
    })
}

fn names_exe(candidate: &str, exe: &str) -> bool {
    Path::new(candidate)
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(exe))
}

/// The exe path a Toolbox App script names, such as `start "" "C:\...\bin\rider64.exe" %*`: the
/// first double-quoted string ending in `exe`, else the first bare token that does.
fn toolbox_exe(script_text: &str, exe: &str) -> Option<PathBuf> {
    let quoted = script_text
        .split('"')
        .skip(1)
        .step_by(2)
        .find(|s| names_exe(s, exe));
    quoted
        .or_else(|| script_text.split_whitespace().find(|s| names_exe(s, exe)))
        .map(PathBuf::from)
}

/// The top-level `"version"` of a JetBrains `product-info.json`.
fn product_version(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("version")?.as_str().map(String::from)
}

fn version_key(v: &str) -> Vec<u64> {
    v.split('.').map(|s| s.parse().unwrap_or(0)).collect()
}

/// The install with the highest version; one without a version ranks below any with one, and
/// ties keep the first found.
fn pick_install(found: Vec<(PathBuf, Option<String>)>) -> Option<PathBuf> {
    let mut best: Option<(PathBuf, Option<Vec<u64>>)> = None;
    for (path, version) in found {
        let key = version.as_deref().map(version_key);
        if best.as_ref().is_none_or(|(_, b)| key > *b) {
            best = Some((path, key));
        }
    }
    best.map(|(p, _)| p)
}

/// A JetBrains IDE: its exe on `PATH`, then the exe a Toolbox App script names (looked for on
/// `PATH`, then in the Toolbox scripts folder), then the highest-versioned install folder. The
/// script is read, never run, since running it would go through `cmd.exe` (section 9). Install folders are matched by `bin\<exe>` only, because their
/// names carry the version and the Toolbox App lets them move.
fn find_jetbrains(exe: &str, script: &str, env: &SearchEnv) -> Option<PathBuf> {
    if let Some(p) = env.path.iter().map(|d| d.join(exe)).find(|p| p.is_file()) {
        return Some(p);
    }
    // The Toolbox App writes its scripts here whether or not the folder is on PATH.
    let toolbox_scripts = env
        .local_app_data
        .as_ref()
        .map(|b| b.join(r"JetBrains\Toolbox\scripts"));
    for dir in env.path.iter().chain(toolbox_scripts.iter()) {
        let Ok(bytes) = std::fs::read(dir.join(script)) else {
            continue;
        };
        if let Some(p) = toolbox_exe(&String::from_utf8_lossy(&bytes), exe).filter(|p| p.is_file())
        {
            return Some(p);
        }
    }
    let roots = [
        env.local_app_data.as_ref().map(|b| b.join("Programs")),
        env.program_files.as_ref().map(|b| b.join("JetBrains")),
    ];
    let mut found = Vec::new();
    for root in roots.into_iter().flatten() {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for d in entries.flatten().map(|e| e.path()) {
            let bin = d.join("bin").join(exe);
            if bin.is_file() {
                let version = std::fs::read_to_string(d.join("product-info.json"))
                    .ok()
                    .and_then(|j| product_version(&j));
                found.push((bin, version));
            }
        }
    }
    pick_install(found)
}

fn is_terminal_editor(id: &str) -> bool {
    matches!(id, "vim" | "nvim")
}

/// A terminal editor on `PATH`, else in its usual install folders. Git for Windows ships
/// `vim.exe` in `<root>\usr\bin`, which is not on `PATH`, so that is found from the usual install
/// roots and from a `git.exe` on `PATH` in `<root>\cmd` or `<root>\bin`. A macOS app started from
/// the Dock gets a minimal `PATH`, so the Homebrew folders are checked by hand.
fn find_terminal_editor(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{id}.exe") } else { id.to_string() };
    let mut candidates: Vec<PathBuf> = env.path.iter().map(|dir| dir.join(&exe)).collect();
    if cfg!(windows) {
        if id == "vim" {
            let git_on_path = env
                .path
                .iter()
                .filter(|dir| dir.join("git.exe").is_file())
                .filter(|dir| {
                    dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| {
                        n.eq_ignore_ascii_case("cmd") || n.eq_ignore_ascii_case("bin")
                    })
                })
                .filter_map(|dir| dir.parent().map(Path::to_path_buf));
            let roots = env
                .local_app_data
                .iter()
                .map(|d| d.join("Programs").join("Git"))
                .chain(env.program_files.iter().map(|d| d.join("Git")))
                .chain(git_on_path);
            candidates.extend(roots.map(|root| root.join("usr").join("bin").join("vim.exe")));
        } else {
            candidates.extend(
                env.program_files
                    .iter()
                    .map(|d| d.join("Neovim").join("bin").join("nvim.exe")),
            );
        }
    } else {
        candidates.extend(env.bin_dirs.iter().map(|dir| dir.join(&exe)));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// A terminal editor's argv after the program: `+<line>` jumps to the line in Vim and Neovim.
fn terminal_args(path: &Path, line: Option<u32>) -> Vec<String> {
    let p = path.display().to_string();
    match line {
        Some(l) => vec![format!("+{l}"), p],
        None => vec![p],
    }
}

/// The folder a terminal editor's pane starts in: the folder itself, or a file's parent.
fn terminal_cwd(path: &Path) -> String {
    let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    dir.display().to_string()
}

/// The editor's executable, or None when it is not installed. `default` has none.
fn detect(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    detect_with_args(id, env).map(|(p, _)| p)
}

/// `detect` and the arguments the editor's launcher needs before the file's own (empty off
/// Linux's `.desktop` matches).
fn detect_with_args(id: &str, env: &SearchEnv) -> Option<(PathBuf, Vec<String>)> {
    if !cfg!(windows) {
        return detect_posix_with_args(id, env);
    }
    detect_windows(id, env).map(|p| (p, Vec::new()))
}

fn detect_windows(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    if id == "visualStudio" {
        return find_devenv(env);
    }
    if let Some((exe, script)) = jetbrains(id) {
        return find_jetbrains(exe, script, env);
    }
    if is_terminal_editor(id) {
        return find_terminal_editor(id, env);
    }
    find_on_path(id, env).or_else(|| {
        install_candidates(id, env)
            .into_iter()
            .find(|p| p.is_file())
    })
}

/// Arguments after the program for a table editor (section 3.12). A line applies only to a file.
fn table_args(id: &str, path: &Path, line: Option<u32>) -> Vec<String> {
    let p = path.display().to_string();
    let at = |l: Option<u32>| match l {
        Some(l) => format!("{p}:{l}"),
        None => p.clone(),
    };
    match id {
        "zed" | "sublime" => vec![at(line)],
        "vscode" | "cursor" | "windsurf" | "vscodeInsiders" | "vscodium" => match line {
            Some(_) => vec!["-g".into(), at(line)],
            None => vec![p],
        },
        "visualStudio" => vec!["/edit".into(), p],
        "rider" | "intellij" | "webstorm" | "pycharm" | "rustrover" | "goland" | "clion"
        | "phpstorm" => match line {
            Some(l) => vec!["--line".into(), l.to_string(), p],
            None => vec![p],
        },
        "notepadpp" => match line {
            Some(l) => vec![format!("-n{l}"), p],
            None => vec![p],
        },
        _ => vec![p],
    }
}

/// Splits `editor.command` like a command line: whitespace separates arguments and double quotes
/// group (they are removed; `""` inside quotes is a literal quote). No shell expansion happens.
fn split_command(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = command.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                cur.push('"');
            }
            '"' => {
                quoted = !quoted;
                started = true;
            }
            c if c.is_whitespace() && !quoted => {
                if started {
                    args.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        args.push(cur);
    }
    args
}

/// `editor.command` split and filled in: `{path}` and `{line}` anywhere in an argument, with an
/// absent line filling `1`. The first argument is the program; None when the command is blank.
fn custom_argv(command: &str, path: &Path, line: Option<u32>) -> Option<Vec<String>> {
    let p = path.display().to_string();
    let l = line.unwrap_or(1).to_string();
    let argv: Vec<String> = split_command(command)
        .into_iter()
        .map(|a| a.replace("{path}", &p).replace("{line}", &l))
        .collect();
    (!argv.is_empty()).then_some(argv)
}

/// Starts the program detached. A `.cmd` or `.bat` program (only possible through
/// `editor.command`) is run by the standard library through `cmd.exe` with its batch-file
/// argument escaping, which refuses arguments it cannot quote safely.
fn launch(program: &Path, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::child_process::prepare(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    // Unix keeps an exited child as a zombie until it is waited on, and an editor's CLI exits at
    // once after handing off to the running instance.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn normalize_existing(path: &str) -> Result<PathBuf, String> {
    let p = crate::files::normalize(path)?;
    if !p.exists() {
        return Err(format!("{} does not exist", p.display()));
    }
    Ok(p)
}

/// Whether `desktop_id` is one of the table's editors, which `detect` finds by its own means: a
/// fixed desktop id, a JetBrains Toolbox or tarball entry, a Flatpak's, or a Snap's
/// (`<snap>_<app>.desktop`).
fn table_covers_desktop_id(desktop_id: &str) -> bool {
    let Some(stem) = desktop_id.strip_suffix(".desktop") else { return false };
    let snap_parts: Vec<&str> = stem.splitn(2, '_').collect();
    matches!(stem, "vim" | "nvim")
        || NAMES.iter().any(|(id, _)| {
            desktop_ids(id).contains(&desktop_id)
                || jetbrains_desktop_prefix(id).is_some_and(|p| is_jetbrains_desktop_name(p, desktop_id))
                || flatpak_app_ids(id).contains(&stem)
                || (snap_parts.len() == 2
                    && posix_path_names(id)
                        .iter()
                        .chain(snap_command_names(id))
                        .any(|n| snap_parts.contains(n)))
        })
}

/// Whether the macOS bundle with this file name is one of the table's editors.
fn table_covers_bundle(file_name: &str) -> bool {
    NAMES.iter().any(|(id, _)| {
        bundle_candidates(id).iter().any(|c| c.split('/').next() == Some(file_name))
    })
}

/// Where macOS editors are discovered: the Applications folders, and the system's own (TextEdit).
fn mac_discovery_dirs(env: &SearchEnv) -> Vec<PathBuf> {
    let mut dirs = env.applications.clone();
    dirs.push(PathBuf::from("/System/Applications"));
    dirs
}

/// The editors the system lists that the table does not cover.
fn discovered(env: &SearchEnv) -> Vec<Editor> {
    if cfg!(target_os = "linux") {
        let path_dirs: Vec<PathBuf> = env.path.iter().chain(&env.bin_dirs).cloned().collect();
        crate::editor_desktop::discover(&env.desktop_dirs, table_covers_desktop_id, |e| {
            crate::editor_desktop::runnable(e, &path_dirs)
        })
        .into_iter()
        .map(|f| Editor { id: f.id, name: f.name })
        .collect()
    } else if cfg!(target_os = "macos") {
        crate::editor_bundles::discover(&mac_discovery_dirs(env), table_covers_bundle)
            .into_iter()
            .map(|f| Editor { id: f.id, name: f.name })
            .collect()
    } else {
        vec![]
    }
}

/// How to open `path` with a discovered editor: `Some(Ok(terminal))` once started (with a pane to
/// open for a terminal program), `None` when `id` is not a discovered id or the editor is gone.
fn open_discovered(id: &str, path: &Path, env: &SearchEnv) -> Option<Result<Option<TerminalLaunch>, String>> {
    if crate::editor_desktop::is_id(id) {
        let (entry, entry_path) = crate::editor_desktop::find(id, &env.desktop_dirs)?;
        let argv = crate::desktop_entry::argv_for_file(&entry, path, &entry_path)?;
        if entry.terminal {
            return Some(Ok(Some(TerminalLaunch { argv, cwd: terminal_cwd(path) })));
        }
        return Some(launch(Path::new(&argv[0]), &argv[1..]).map(|()| None));
    }
    if crate::editor_bundles::is_id(id) {
        let app = crate::editor_bundles::find(id, &mac_discovery_dirs(env))?;
        let args = vec!["-a".to_string(), app.display().to_string(), path.display().to_string()];
        return Some(launch(Path::new("/usr/bin/open"), &args).map(|()| None));
    }
    None
}

/// The editors found on this machine: the table's in section 3.12's order, then the ones the
/// system lists by name; `default` is always last.
#[tauri::command]
pub fn editors() -> Vec<Editor> {
    let env = SearchEnv::from_process();
    let table = NAMES
        .iter()
        .filter(|(id, _)| *id != "default" && detect(id, &env).is_some())
        .map(|(id, name)| Editor {
            id: (*id).into(),
            name: (*name).into(),
        });
    let default = NAMES.iter().filter(|(id, _)| *id == "default").map(|(id, name)| Editor {
        id: (*id).into(),
        name: (*name).into(),
    });
    table.chain(discovered(&env)).chain(default).collect()
}

/// Opens a file or folder in the preferred editor. Falls back to the default app, and says so,
/// when the preferred editor is not installed or would not start.
#[tauri::command]
pub fn open_in_editor(
    app: tauri::AppHandle,
    settings: State<'_, SettingsState>,
    path: String,
    line: Option<u32>,
) -> Result<Opened, String> {
    let path = normalize_existing(&path)?;
    let editor = settings.current().editor;
    if let Some(argv) = custom_argv(&editor.command, &path, line) {
        launch(Path::new(&argv[0]), &argv[1..])?;
        return Ok(Opened { fallback: false, terminal: None });
    }
    let line = line.filter(|_| path.is_file());
    if let Some(Ok(terminal)) = open_discovered(&editor.preferred, &path, &SearchEnv::from_process()) {
        return Ok(Opened { fallback: false, terminal });
    }
    if editor.preferred != "default" {
        if let Some((exe, prefix)) = detect_with_args(&editor.preferred, &SearchEnv::from_process()) {
            if is_terminal_editor(&editor.preferred) {
                let mut argv = vec![exe.display().to_string()];
                argv.extend(terminal_args(&path, line));
                let terminal = Some(TerminalLaunch { argv, cwd: terminal_cwd(&path) });
                return Ok(Opened { fallback: false, terminal });
            }
            let mut args = prefix;
            args.extend(table_args(&editor.preferred, &path, line));
            if launch(&exe, &args).is_ok() {
                return Ok(Opened { fallback: false, terminal: None });
            }
        }
    }
    // A bundle is a folder, so it never reaches the viewer and `open` would launch it.
    if cfg!(target_os = "macos") && path.is_dir() && runs_when_opened_mac(&path) {
        return Err(format!("{} would run as a program, so it was not opened", path.display()));
    }
    // The default app for a script, shortcut, or program is to run it, so those open as text,
    // or not at all when no text viewer is known.
    if path.is_file() && runs_on_open(&path) {
        let (program, args) = text_viewer(&path).ok_or_else(|| {
            format!(
                "{} would run as a program and no text editor was found to show it, so it was not opened",
                path.display()
            )
        })?;
        launch(&program, &args)?;
    } else {
        crate::child_process::open_default(&app, &path.display().to_string(), false)?;
    }
    Ok(Opened {
        fallback: editor.preferred != "default",
        terminal: None,
    })
}

/// Whether `open_with_default_app` would open `path`: an existing file that does not run when
/// opened.
#[tauri::command]
pub fn can_open_with_default_app(path: String) -> bool {
    normalize_existing(&path).is_ok_and(|p| opens_safely(&p))
}

/// Opens a file in the app Windows associates with it. Refuses anything that would run as a
/// program, since this is a click in a preview, not a launch.
#[tauri::command]
pub fn open_with_default_app(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = normalize_existing(&path)?;
    if !opens_safely(&path) {
        return Err(format!("{} would run as a program, so it was not opened", path.display()));
    }
    crate::child_process::open_default(&app, &path.display().to_string(), false)
}

fn opens_safely(path: &Path) -> bool {
    path.is_file() && !runs_on_open(path)
}

/// Extensions Windows executes, or hands to an installer or script host, on a plain open.
const RUNNABLE: &[&str] = &[
    "appinstaller", "application", "appref-ms", "appx", "appxbundle", "bat", "chm", "cmd", "com",
    "cpl", "diagcab", "exe", "gadget", "hta", "inf", "jar", "js", "jse", "library-ms", "lnk",
    "msc", "msi", "msix", "msixbundle", "msp", "pif", "ps1", "psc1", "reg", "scf", "scr",
    "search-ms", "settingcontent-ms", "sys", "url", "vb", "vbe", "vbs", "website", "ws", "wsc",
    "wsf", "wsh", "xll",
];

/// Whether opening `path` with its default app would run it: a listed extension or one in
/// `PATHEXT` (`;`-separated, with dots, as Windows sets it).
fn runs_when_opened(path: &Path, pathext: &str) -> bool {
    let Some(ext) = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) else {
        return false;
    };
    RUNNABLE.contains(&ext.as_str())
        || pathext
            .split(';')
            .any(|p| p.trim().trim_start_matches('.').eq_ignore_ascii_case(&ext))
}

/// Extensions macOS launches, installs, or runs in Terminal on a plain open. A bundle (`app`,
/// `workflow`, `action`) is a folder, so these also name directories.
const RUNNABLE_MAC: &[&str] = &[
    "app", "command", "tool", "pkg", "mpkg", "terminal", "workflow", "action", "scpt",
    "applescript",
];

/// Extensions a Linux desktop launches or installs on a plain open whatever their mode: a
/// `.desktop` file runs its `Exec=` line, an AppImage launcher runs AppImages, Java runs a jar,
/// Wine runs Windows programs, and the software center installs packages.
const RUNNABLE_LINUX: &[&str] = &[
    "desktop", "appimage", "jar", "exe", "msi", "bat", "cmd", "com", "lnk", "deb", "rpm", "snap",
    "flatpak", "flatpakref", "flatpakrepo",
];

fn has_extension_in(path: &Path, list: &[&str]) -> bool {
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|ext| list.contains(&ext.as_str()))
}

fn runs_when_opened_mac(path: &Path) -> bool {
    has_extension_in(path, RUNNABLE_MAC)
}

/// Volume types that report every file as executable, so the bit says nothing there: macOS
/// names them `msdos`, `exfat`, and `ntfs`; Linux `vfat`, `exfat`, `ntfs3`, and `fuseblk` (ntfs-3g
/// and exfat-fuse).
const EXEC_BIT_MEANINGLESS: &[&str] = &["msdos", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk"];

/// macOS `open` runs any executable file in Terminal whatever its name, and a Linux file manager
/// may run one too, so an execute bit counts as runnable, except on a volume that marks every
/// file executable.
#[cfg_attr(not(any(target_os = "macos", target_os = "linux")), allow(dead_code))]
fn exec_bit_runs(mode: u32, fs_type: &str) -> bool {
    mode & 0o111 != 0 && !EXEC_BIT_MEANINGLESS.contains(&fs_type)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn has_exec_bit(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    exec_bit_runs(meta.permissions().mode(), &fs_type(path).unwrap_or_default())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn has_exec_bit(_path: &Path) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn fs_type(path: &Path) -> Option<String> {
    crate::mount_info::fs_type(path)
}

/// The volume's file system name (`apfs`, `msdos`, ...) from `statfs`.
#[cfg(target_os = "macos")]
fn fs_type(path: &Path) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: statfs is plain data; zeroed is a valid value for it.
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: c_path is NUL-terminated and st is a writable statfs.
    if unsafe { libc::statfs(c_path.as_ptr(), &mut st) } != 0 {
        return None;
    }
    // SAFETY: the kernel fills f_fstypename with a NUL-terminated name.
    let name = unsafe { std::ffi::CStr::from_ptr(st.f_fstypename.as_ptr()) };
    Some(name.to_string_lossy().into_owned())
}

/// Whether the platform's default app would run `path` rather than show it. Unix targets other
/// than macOS and Linux count everything as runnable, since nothing is known about them.
fn runs_on_open(path: &Path) -> bool {
    if cfg!(windows) {
        runs_when_opened(path, &std::env::var("PATHEXT").unwrap_or_default())
    } else if cfg!(target_os = "macos") {
        runs_when_opened_mac(path) || has_exec_bit(path)
    } else if cfg!(target_os = "linux") {
        has_extension_in(path, RUNNABLE_LINUX) || has_exec_bit(path)
    } else {
        true
    }
}

/// The program and arguments that show a file as text; None where none is known. `open -t` goes
/// by full path so a lookalike on `PATH` is not run.
fn text_viewer(path: &Path) -> Option<(PathBuf, Vec<String>)> {
    let p = path.display().to_string();
    if cfg!(windows) {
        Some((notepad(), vec![p]))
    } else if cfg!(target_os = "macos") {
        Some((PathBuf::from("/usr/bin/open"), vec!["-t".into(), p]))
    } else if cfg!(target_os = "linux") {
        linux_text_viewer(path)
    } else {
        None
    }
}

/// The default `text/plain` app's `Exec=` line, with the file as its argument. `xdg-open` cannot
/// stand in: it goes by the file's own type, so it would launch a `.desktop` file or an AppImage.
fn linux_text_viewer(path: &Path) -> Option<(PathBuf, Vec<String>)> {
    let mut cmd = Command::new("xdg-mime");
    cmd.args(["query", "default", "text/plain"]).stdin(Stdio::null()).stderr(Stdio::null());
    let out = crate::child_process::prepare(&mut cmd).output().ok()?;
    let id = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || id.is_empty() {
        return None;
    }
    let file = crate::desktop_entry::find_in(&id, &crate::desktop_entry::system_application_dirs(), Path::is_file)?;
    let entry = crate::desktop_entry::parse(&std::fs::read_to_string(&file).ok()?)?;
    let mut argv = crate::desktop_entry::command_for_file(&entry, path, &file)?.into_iter();
    Some((PathBuf::from(argv.next()?), argv.collect()))
}

/// Notepad by full path, so a `notepad.exe` in the working folder or early on `PATH` is not run.
fn notepad() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    PathBuf::from(root).join("System32").join("notepad.exe")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bashboard-editors-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }

    const FILE: &str = r"C:\repo\src\main file.rs";

    #[test]
    fn runnable_files_are_not_opened_with_their_default_app() {
        let pathext = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC;.PY";
        for name in ["setup.exe", "run.BAT", "x.cmd", "a.lnk", "b.url", "c.hta", "d.ps1", "e.py"] {
            assert!(runs_when_opened(Path::new(name), pathext), "{name}");
        }
        assert!(runs_when_opened(Path::new("x.Lnk"), ""));
        for name in ["README.md", "main.rs", "photo.png", "notes", "report.pdf"] {
            assert!(!runs_when_opened(Path::new(name), pathext), "{name}");
        }
    }

    #[test]
    fn default_app_opens_only_files_that_do_not_run() {
        let root = temp_dir("default-app");
        for name in ["report.pdf", "setup.exe", "go.lnk"] {
            touch(&root.join(name));
        }
        assert!(opens_safely(&root.join("report.pdf")));
        if cfg!(windows) {
            assert!(!opens_safely(&root.join("setup.exe")));
            assert!(!opens_safely(&root.join("go.lnk")));
        }
        assert!(!opens_safely(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn table_args_with_a_line() {
        let p = Path::new(FILE);
        let l = Some(12);
        assert_eq!(table_args("zed", p, l), [format!("{FILE}:12")]);
        assert_eq!(
            table_args("vscode", p, l),
            ["-g".to_string(), format!("{FILE}:12")]
        );
        assert_eq!(
            table_args("cursor", p, l),
            ["-g".to_string(), format!("{FILE}:12")]
        );
        assert_eq!(table_args("visualStudio", p, l), ["/edit", FILE]);
        assert_eq!(table_args("notepadpp", p, l), ["-n12", FILE]);
        assert_eq!(table_args("sublime", p, l), [format!("{FILE}:12")]);
        for id in JETBRAINS {
            assert_eq!(table_args(id, p, l), ["--line", "12", FILE], "{id}");
        }
        for id in ["windsurf", "vscodeInsiders", "vscodium"] {
            assert_eq!(
                table_args(id, p, l),
                ["-g".to_string(), format!("{FILE}:12")],
                "{id}"
            );
        }
    }

    const JETBRAINS: [&str; 8] = [
        "rider",
        "intellij",
        "webstorm",
        "pycharm",
        "rustrover",
        "goland",
        "clion",
        "phpstorm",
    ];

    #[test]
    fn table_args_without_a_line() {
        let p = Path::new(FILE);
        for id in ["zed", "vscode", "cursor", "notepadpp", "sublime"]
            .into_iter()
            .chain(JETBRAINS)
            .chain(["windsurf", "vscodeInsiders", "vscodium"])
        {
            assert_eq!(table_args(id, p, None), [FILE], "{id}");
        }
        assert_eq!(table_args("visualStudio", p, None), ["/edit", FILE]);
    }

    #[test]
    fn split_groups_quoted_paths_with_spaces() {
        assert_eq!(
            split_command(r#""C:\Program Files\Ed\ed.exe" --goto "{path}:{line}""#),
            [r"C:\Program Files\Ed\ed.exe", "--goto", "{path}:{line}"]
        );
        assert_eq!(
            split_command(r#"  a   "b c"d  "" "x""y" "#),
            ["a", "b cd", "", r#"x"y"#]
        );
        assert!(split_command("   ").is_empty());
    }

    #[test]
    fn custom_command_fills_path_and_line() {
        let p = Path::new(FILE);
        let argv = custom_argv(r#"ed.exe --file={path} +{line}"#, p, Some(7)).unwrap();
        assert_eq!(
            argv,
            ["ed.exe".to_string(), format!("--file={FILE}"), "+7".into()]
        );
    }

    #[test]
    fn custom_command_absent_line_fills_one() {
        let argv = custom_argv("ed.exe {path}:{line}", Path::new(FILE), None).unwrap();
        assert_eq!(argv, ["ed.exe".to_string(), format!("{FILE}:1")]);
        let argv = custom_argv("ed.exe {path}", Path::new(FILE), None).unwrap();
        assert_eq!(argv, ["ed.exe", FILE]);
    }

    #[test]
    fn empty_command_falls_through_to_the_table() {
        assert_eq!(custom_argv("", Path::new(FILE), Some(3)), None);
        assert_eq!(custom_argv("  \t ", Path::new(FILE), Some(3)), None);
    }

    #[cfg(windows)]
    #[test]
    fn detects_in_install_folders_and_on_path() {
        let root = temp_dir("detect");
        let env = SearchEnv {
            path: vec![root.join("vsc").join("bin"), root.join("npp")],
            local_app_data: Some(root.join("local")),
            program_files: Some(root.join("pf")),
            ..SearchEnv::default()
        };
        for (id, _) in NAMES {
            assert_eq!(detect(id, &env), None, "{id}");
        }

        touch(&root.join(r"local\Programs\Zed\bin\zed.exe"));
        touch(&root.join(r"pf\Sublime Text\subl.exe"));
        touch(&root.join(r"npp\notepad++.exe"));
        assert_eq!(
            detect("zed", &env),
            Some(root.join(r"local\Programs\Zed\bin\zed.exe"))
        );
        assert_eq!(
            detect("sublime", &env),
            Some(root.join(r"pf\Sublime Text\subl.exe"))
        );
        assert_eq!(
            detect("notepadpp", &env),
            Some(root.join(r"npp\notepad++.exe"))
        );

        // A shim alone is not an editor; the exe beside its folder is.
        touch(&root.join(r"vsc\bin\code.cmd"));
        assert_eq!(detect("vscode", &env), None);
        touch(&root.join(r"vsc\Code.exe"));
        assert_eq!(detect("vscode", &env), Some(root.join(r"vsc\Code.exe")));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    fn env_at(root: &Path, path: Vec<PathBuf>) -> SearchEnv {
        SearchEnv {
            path,
            local_app_data: Some(root.join("local")),
            program_files: Some(root.join("pf")),
            ..SearchEnv::default()
        }
    }

    #[cfg(windows)]
    #[test]
    fn vscode_family_shims_trade_for_the_exe_one_folder_up() {
        let root = temp_dir("vscfamily");
        for (id, shim, exe) in [
            ("windsurf", "windsurf.cmd", "Windsurf.exe"),
            ("vscodeInsiders", "code-insiders.cmd", "Code - Insiders.exe"),
            ("vscodium", "codium.cmd", "VSCodium.exe"),
        ] {
            let env = env_at(&root, vec![root.join(id).join("bin")]);
            touch(&root.join(id).join("bin").join(shim));
            assert_eq!(detect(id, &env), None, "{id}");
            touch(&root.join(id).join(exe));
            assert_eq!(detect(id, &env), Some(root.join(id).join(exe)), "{id}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn vscode_family_install_folders() {
        let root = temp_dir("vscinstall");
        let env = env_at(&root, vec![]);
        touch(&root.join(r"local\Programs\Windsurf\Windsurf.exe"));
        touch(&root.join(r"pf\Microsoft VS Code Insiders\Code - Insiders.exe"));
        touch(&root.join(r"local\Programs\VSCodium\VSCodium.exe"));
        assert_eq!(
            detect("windsurf", &env),
            Some(root.join(r"local\Programs\Windsurf\Windsurf.exe"))
        );
        assert_eq!(
            detect("vscodeInsiders", &env),
            Some(root.join(r"pf\Microsoft VS Code Insiders\Code - Insiders.exe"))
        );
        assert_eq!(
            detect("vscodium", &env),
            Some(root.join(r"local\Programs\VSCodium\VSCodium.exe"))
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn jetbrains_exe_on_path() {
        let root = temp_dir("jbpath");
        let env = env_at(&root, vec![root.join("bin")]);
        assert_eq!(detect("rider", &env), None);
        touch(&root.join(r"bin\rider64.exe"));
        assert_eq!(detect("rider", &env), Some(root.join(r"bin\rider64.exe")));
        assert_eq!(detect("webstorm", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn jetbrains_toolbox_script_on_path() {
        let root = temp_dir("jbtoolbox");
        let scripts = root.join("scripts");
        let env = env_at(&root, vec![scripts.clone()]);
        let exe = root.join(r"apps\Rider 2025.2\bin\rider64.exe");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(
            scripts.join("rider.cmd"),
            format!("@echo off\r\nstart \"\" \"{}\" %*\r\n", exe.display()),
        )
        .unwrap();
        assert_eq!(detect("rider", &env), None, "the named exe is missing");
        touch(&exe);
        assert_eq!(detect("rider", &env), Some(exe));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn jetbrains_toolbox_script_in_the_scripts_folder_off_path() {
        let root = temp_dir("jbscripts");
        let env = env_at(&root, vec![]);
        let scripts = root.join(r"local\JetBrains\Toolbox\scripts");
        let exe = root.join(r"apps\Rider 2025.2\bin\rider64.exe");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(
            scripts.join("rider.cmd"),
            format!("@echo off\r\nstart \"\" \"{}\" %*\r\n", exe.display()),
        )
        .unwrap();
        touch(&exe);
        assert_eq!(detect("rider", &env), Some(exe));
        assert_eq!(detect("webstorm", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn jetbrains_install_folders_pick_the_highest_version() {
        let root = temp_dir("jbinstall");
        let env = env_at(&root, vec![]);
        let older = root.join(r"local\Programs\Rider 2025.9");
        let newer = root.join(r"pf\JetBrains\JetBrains Rider 2025.1");
        let unversioned = root.join(r"local\Programs\Rider");
        for d in [&older, &newer, &unversioned] {
            touch(&d.join(r"bin\rider64.exe"));
        }
        std::fs::write(older.join("product-info.json"), r#"{"version": "2025.9"}"#).unwrap();
        std::fs::write(newer.join("product-info.json"), r#"{"version": "2025.10"}"#).unwrap();
        assert_eq!(detect("rider", &env), Some(newer.join(r"bin\rider64.exe")));
        assert_eq!(detect("intellij", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn jetbrains_install_without_version_loses() {
        let root = temp_dir("jbnoversion");
        let env = env_at(&root, vec![]);
        let bare = root.join(r"local\Programs\IDEA");
        let versioned = root.join(r"pf\JetBrains\IntelliJ IDEA Community Edition");
        touch(&bare.join(r"bin\idea64.exe"));
        touch(&versioned.join(r"bin\idea64.exe"));
        std::fs::write(
            versioned.join("product-info.json"),
            r#"{"version": "2024.3"}"#,
        )
        .unwrap();
        assert_eq!(
            detect("intellij", &env),
            Some(versioned.join(r"bin\idea64.exe"))
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn toolbox_exe_reads_the_script_text() {
        let quoted = "@echo off\r\nstart \"\" \"C:\\Tool Box\\Rider\\bin\\rider64.exe\" %*\r\n";
        assert_eq!(
            toolbox_exe(quoted, "rider64.exe"),
            Some(PathBuf::from(r"C:\Tool Box\Rider\bin\rider64.exe"))
        );
        let bare = "@echo off\r\nstart C:\\tb\\bin\\rider64.exe %*\r\n";
        assert_eq!(
            toolbox_exe(bare, "rider64.exe"),
            Some(PathBuf::from(r"C:\tb\bin\rider64.exe"))
        );
        assert_eq!(toolbox_exe("start \"\" %*", "rider64.exe"), None);
        assert_eq!(toolbox_exe(quoted, "idea64.exe"), None);
        assert_eq!(
            toolbox_exe(r#"start "" "C:\tb\bin\Rider64.EXE" %*"#, "rider64.exe"),
            Some(PathBuf::from(r"C:\tb\bin\Rider64.EXE"))
        );
    }

    #[test]
    fn product_version_reads_the_top_level_field() {
        assert_eq!(
            product_version(r#"{"name": "Rider", "version": "2025.2.3", "launch": []}"#),
            Some("2025.2.3".into())
        );
        assert_eq!(product_version(r#"{"name": "Rider"}"#), None);
        assert_eq!(product_version("not json"), None);
    }

    #[test]
    fn pick_install_compares_versions_by_number() {
        let p = |s: &str| PathBuf::from(s);
        let v = |s: &str| Some(s.to_string());
        assert_eq!(
            pick_install(vec![(p("a"), v("2025.9")), (p("b"), v("2025.10"))]),
            Some(p("b"))
        );
        assert_eq!(
            pick_install(vec![(p("a"), None), (p("b"), v("2023.1"))]),
            Some(p("b"))
        );
        assert_eq!(
            pick_install(vec![(p("a"), v("2025.1")), (p("b"), v("2025.1"))]),
            Some(p("a"))
        );
        assert_eq!(
            pick_install(vec![(p("a"), v("2025.x")), (p("b"), v("2025.0.1"))]),
            Some(p("b"))
        );
        assert_eq!(pick_install(vec![(p("a"), None)]), Some(p("a")));
        assert_eq!(pick_install(vec![]), None);
    }

    #[test]
    fn open_requires_an_existing_absolute_path() {
        assert!(
            normalize_existing("relative.txt")
                .unwrap_err()
                .contains("not an absolute path")
        );
        let root = temp_dir("normalize");
        touch(&root.join("a.txt"));
        let dotted = root.join("sub").join("..").join("a.txt");
        assert_eq!(normalize_existing(&dotted.to_string_lossy()).unwrap(), root.join("a.txt"));
        assert!(normalize_existing(&root.join("missing.txt").to_string_lossy()).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn vim_comes_from_git_for_windows_and_nvim_from_its_install() {
        let root = temp_dir("termeditors");
        let env = env_at(&root, vec![root.join(r"Git\cmd")]);
        assert_eq!(detect("vim", &env), None);
        assert_eq!(detect("nvim", &env), None);

        // git.exe on PATH in <root>\cmd leads to <root>\usr\bin\vim.exe.
        touch(&root.join(r"Git\cmd\git.exe"));
        touch(&root.join(r"Git\usr\bin\vim.exe"));
        assert_eq!(detect("vim", &env), Some(root.join(r"Git\usr\bin\vim.exe")));

        // A vim.exe on PATH wins over Git's.
        touch(&root.join(r"Git\cmd\vim.exe"));
        assert_eq!(detect("vim", &env), Some(root.join(r"Git\cmd\vim.exe")));

        touch(&root.join(r"pf\Neovim\bin\nvim.exe"));
        assert_eq!(detect("nvim", &env), Some(root.join(r"pf\Neovim\bin\nvim.exe")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn vim_in_the_per_user_and_program_files_git_installs() {
        let root = temp_dir("termeditorsgit");
        let env = env_at(&root, vec![]);
        touch(&root.join(r"pf\Git\usr\bin\vim.exe"));
        assert_eq!(detect("vim", &env), Some(root.join(r"pf\Git\usr\bin\vim.exe")));
        touch(&root.join(r"local\Programs\Git\usr\bin\vim.exe"));
        assert_eq!(
            detect("vim", &env),
            Some(root.join(r"local\Programs\Git\usr\bin\vim.exe"))
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn terminal_editors_jump_with_plus_line_and_start_beside_the_file() {
        let root = temp_dir("termargs");
        let file = root.join("a.rs");
        touch(&file);
        let f = file.display().to_string();
        assert_eq!(terminal_args(&file, Some(12)), vec!["+12".to_string(), f.clone()]);
        assert_eq!(terminal_args(&file, None), vec![f]);
        assert_eq!(terminal_cwd(&file), root.display().to_string());
        assert_eq!(terminal_cwd(&root), root.display().to_string());
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn mac_env(root: &Path) -> SearchEnv {
        SearchEnv {
            applications: vec![user_apps(root)],
            bin_dirs: vec![root.join("brew")],
            path: vec![root.join("onpath")],
            toolbox_scripts: Some(toolbox_scripts_dir(&root.join("home"))),
            ..SearchEnv::default()
        }
    }

    // Only the per-user folder is searched, so a real /Applications on the test machine cannot
    // leak in.
    fn user_apps(root: &Path) -> PathBuf {
        root.join("home").join("Applications")
    }

    #[test]
    fn bundles_are_found_in_the_per_user_applications_folder() {
        let root = temp_dir("bundles");
        let env = mac_env(&root);
        let apps = user_apps(&root);
        for id in ["zed", "vscode", "sublime", "intellij", "rider"] {
            assert_eq!(bundle_executable(id, &env), None, "{id}");
        }
        for rel in [
            "Zed.app/Contents/MacOS/cli",
            "Visual Studio Code.app/Contents/Resources/app/bin/code",
            "Sublime Text.app/Contents/SharedSupport/bin/subl",
            "IntelliJ IDEA CE.app/Contents/MacOS/idea",
        ] {
            touch(&apps.join(rel));
        }
        assert_eq!(detect_posix("zed", &env), Some(apps.join("Zed.app/Contents/MacOS/cli")));
        assert_eq!(
            detect_posix("vscode", &env),
            Some(apps.join("Visual Studio Code.app/Contents/Resources/app/bin/code"))
        );
        assert_eq!(
            detect_posix("sublime", &env),
            Some(apps.join("Sublime Text.app/Contents/SharedSupport/bin/subl"))
        );
        assert_eq!(
            detect_posix("intellij", &env),
            Some(apps.join("IntelliJ IDEA CE.app/Contents/MacOS/idea"))
        );
        assert_eq!(detect_posix("rider", &env), None);
        assert_eq!(detect_posix("visualStudio", &env), None);
        assert_eq!(detect_posix("notepadpp", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn vscode_family_bundles_use_each_forks_cli_name() {
        let root = temp_dir("bundlefork");
        let env = mac_env(&root);
        let apps = user_apps(&root);
        for (id, rel) in [
            ("cursor", "Cursor.app/Contents/Resources/app/bin/code"),
            ("windsurf", "Windsurf.app/Contents/Resources/app/bin/windsurf"),
            ("vscodium", "VSCodium.app/Contents/Resources/app/bin/codium"),
            (
                "vscodeInsiders",
                "Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders",
            ),
        ] {
            assert_eq!(detect_posix(id, &env), None, "{id}");
            touch(&apps.join(rel));
            assert_eq!(detect_posix(id, &env), Some(apps.join(rel)), "{id}");
        }
        // The preferred name wins over the fallback inside the same bundle.
        touch(&apps.join("Cursor.app/Contents/Resources/app/bin/cursor"));
        assert_eq!(
            detect_posix("cursor", &env),
            Some(apps.join("Cursor.app/Contents/Resources/app/bin/cursor"))
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn jetbrains_toolbox_script_is_found_off_path_on_macos() {
        let root = temp_dir("jbmac");
        let env = mac_env(&root);
        assert_eq!(detect_posix("rider", &env), None);
        let script = toolbox_scripts_dir(&root.join("home")).join("rider");
        touch(&script);
        assert_eq!(detect_posix("rider", &env), Some(script.clone()));
        assert_eq!(detect_posix("webstorm", &env), None);
        // A bundle outranks the script.
        let bundle = user_apps(&root).join("Rider.app/Contents/MacOS/rider");
        touch(&bundle);
        assert_eq!(detect_posix("rider", &env), Some(bundle));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bare_cli_names_are_found_on_path_and_in_the_homebrew_folders() {
        let root = temp_dir("posixpath");
        let env = mac_env(&root);
        touch(&root.join("onpath/subl"));
        touch(&root.join("brew/code-insiders"));
        touch(&root.join("brew/idea"));
        assert_eq!(detect_posix("sublime", &env), Some(root.join("onpath/subl")));
        assert_eq!(detect_posix("vscodeInsiders", &env), Some(root.join("brew/code-insiders")));
        assert_eq!(detect_posix("intellij", &env), Some(root.join("brew/idea")));
        assert_eq!(detect_posix("vscode", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn only_the_graphical_editors_with_a_macos_build_have_bundles() {
        for (id, _) in NAMES {
            let windows_only = matches!(id, "visualStudio" | "notepadpp" | "vim" | "nvim" | "default");
            assert_eq!(bundle_candidates(id).is_empty(), windows_only, "{id}");
            assert_eq!(posix_path_names(id).is_empty(), windows_only, "{id}");
        }
    }

    #[test]
    fn application_folders_are_system_then_per_user() {
        assert_eq!(
            application_dirs(Some(Path::new("/Users/me"))),
            [PathBuf::from("/Applications"), PathBuf::from("/Users/me/Applications")]
        );
        assert_eq!(application_dirs(None), [PathBuf::from("/Applications")]);
    }

    #[test]
    fn execute_bit_runs_except_where_every_file_has_it() {
        assert!(exec_bit_runs(0o755, "apfs"));
        assert!(exec_bit_runs(0o744, "apfs"));
        assert!(exec_bit_runs(0o100, ""));
        assert!(!exec_bit_runs(0o644, "apfs"));
        assert!(!exec_bit_runs(0o777, "msdos"));
        assert!(!exec_bit_runs(0o777, "exfat"));
        assert!(exec_bit_runs(0o755, "ext4"));
        for fs in ["vfat", "ntfs3", "fuseblk"] {
            assert!(!exec_bit_runs(0o777, fs), "{fs}");
        }
    }

    #[test]
    fn linux_launchers_and_packages_are_runnable_by_extension() {
        for name in ["app.desktop", "Tool.AppImage", "a.jar", "setup.exe", "x.deb", "y.rpm", "z.flatpakref"] {
            assert!(has_extension_in(Path::new(name), RUNNABLE_LINUX), "{name}");
        }
        for name in ["README.md", "main.rs", "run.sh", "notes", "desktop"] {
            assert!(!has_extension_in(Path::new(name), RUNNABLE_LINUX), "{name}");
        }
    }

    #[test]
    fn macos_runnable_files_open_as_text() {
        for name in [
            "Tool.app", "a.command", "b.tool", "c.pkg", "d.mpkg", "e.terminal", "f.workflow",
            "g.action", "h.scpt", "i.applescript", "J.APP",
        ] {
            assert!(runs_when_opened_mac(Path::new(name)), "{name}");
        }
        for name in ["README.md", "main.rs", "photo.png", "notes", "run.sh", "setup.exe"] {
            assert!(!runs_when_opened_mac(Path::new(name)), "{name}");
        }
        let (program, args) = if cfg!(windows) {
            (notepad(), vec!["/x/a.command".to_string()])
        } else {
            (PathBuf::from("/usr/bin/open"), vec!["-t".to_string(), "/x/a.command".to_string()])
        };
        // Linux's viewer depends on the machine's default text app (desktop_entry's tests).
        if cfg!(windows) || cfg!(target_os = "macos") {
            assert_eq!(text_viewer(Path::new("/x/a.command")), Some((program, args)));
        }
    }

    fn desktop(exec: &str) -> crate::desktop_entry::Entry {
        crate::desktop_entry::parse(&format!("[Desktop Entry]\nName=Ed\nExec={exec}\n")).unwrap()
    }

    #[test]
    fn discovery_skips_the_editors_the_table_covers() {
        for id in [
            "code.desktop",
            "dev.zed.Zed.desktop",
            "jetbrains-idea-ce.desktop",
            "com.visualstudio.code.desktop",
            "code_code.desktop",
            "sublime-text_subl.desktop",
            "intellij-idea-community_intellij-idea-community.desktop",
            "vim.desktop",
            "nvim.desktop",
        ] {
            assert!(table_covers_desktop_id(id), "{id}");
        }
        for id in ["org.gnome.TextEditor.desktop", "org.kde.kate.desktop", "micro.desktop", "gvim.desktop", "code"] {
            assert!(!table_covers_desktop_id(id), "{id}");
        }
        assert!(table_covers_bundle("Visual Studio Code.app"));
        assert!(table_covers_bundle("PyCharm CE.app"));
        assert!(!table_covers_bundle("TextEdit.app"));
    }

    #[test]
    fn desktop_entries_name_the_editor_only_when_it_is_a_plain_absolute_program() {
        let program = |exec: &str| desktop_program(&desktop(exec));
        assert_eq!(program("/usr/share/code/code %F"), Some(PathBuf::from("/usr/share/code/code")));
        assert_eq!(
            program("/home/u/Applications/cursor.AppImage --no-sandbox %U"),
            Some(PathBuf::from("/home/u/Applications/cursor.AppImage"))
        );
        assert_eq!(
            program(
                r#""/home/u/.local/share/JetBrains/Toolbox/apps/intellij-idea-ultimate/bin/idea" %u"#
            ),
            Some(PathBuf::from(
                "/home/u/.local/share/JetBrains/Toolbox/apps/intellij-idea-ultimate/bin/idea"
            ))
        );
        // Wrappers are covered by the Flatpak and Snap launchers.
        assert_eq!(
            program(
                "/usr/bin/flatpak run --branch=stable --arch=x86_64 --command=code \
                 --file-forwarding com.visualstudio.code @@ %F @@"
            ),
            None
        );
        assert_eq!(program("env BAMF_DESKTOP_FILE_HINT=/x.desktop /snap/bin/code %F"), None);
        assert_eq!(program("/usr/bin/env FOO=1 /opt/ed/ed %F"), None);
        assert_eq!(program("/bin/sh -c ed"), None);
        assert_eq!(program("/bin/bash /opt/ed.sh %F"), None);
        assert_eq!(program("/usr/bin/snap run code"), None);
        // A bare name is found on PATH already.
        assert_eq!(program("code %F"), None);
        assert_eq!(program("./code"), None);
        let terminal = crate::desktop_entry::parse("[Desktop Entry]\nExec=/usr/bin/vim %F\nTerminal=true\n").unwrap();
        assert_eq!(desktop_program(&terminal), None);
    }

    #[test]
    fn jetbrains_desktop_names_match_the_product_and_its_suffixes() {
        for name in [
            "jetbrains-idea.desktop",
            "jetbrains-idea-ce.desktop",
            "jetbrains-idea-3f9c2a1b.desktop",
        ] {
            assert!(is_jetbrains_desktop_name("jetbrains-idea", name), "{name}");
        }
        for name in [
            "jetbrains-ideal.desktop",
            "jetbrains-pycharm.desktop",
            "jetbrains-idea",
            "jetbrains-idea-ce.desktop.bak",
            "idea.desktop",
        ] {
            assert!(!is_jetbrains_desktop_name("jetbrains-idea", name), "{name}");
        }
    }

    #[test]
    fn flatpak_desktop_and_snap_tables_cover_the_right_editors() {
        for (id, _) in NAMES {
            let jetbrains = jetbrains(id).is_some();
            assert_eq!(jetbrains_desktop_prefix(id).is_some(), jetbrains, "{id}");
            // Every JetBrains IDE and the editors with a Linux build in a store have a Flatpak.
            let has_flatpak = jetbrains || matches!(id, "vscode" | "vscodium" | "sublime" | "zed");
            assert_eq!(!flatpak_app_ids(id).is_empty(), has_flatpak, "{id}");
            let has_desktop_id = matches!(
                id,
                "vscode" | "vscodeInsiders" | "vscodium" | "cursor" | "windsurf" | "sublime" | "zed"
            );
            assert_eq!(!desktop_ids(id).is_empty(), has_desktop_id, "{id}");
            assert!(desktop_ids(id).iter().all(|d| d.ends_with(".desktop")), "{id}");
            assert!(snap_command_names(id).is_empty() || matches!(id, "intellij" | "pycharm"), "{id}");
        }
        assert_eq!(flatpak_app_ids("vscode"), ["com.visualstudio.code"]);
        assert_eq!(
            flatpak_app_ids("pycharm"),
            ["com.jetbrains.PyCharm-Community", "com.jetbrains.PyCharm-Professional"]
        );
    }

    #[test]
    fn linux_folders_follow_xdg_and_add_flatpak_and_snap() {
        let home = Path::new("/home/u");
        assert_eq!(
            posix_bin_dirs(Some(home)),
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/home/u/.local/bin",
                "/snap/bin"
            ]
            .map(PathBuf::from)
        );
        assert_eq!(posix_bin_dirs(None), ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));

        assert_eq!(user_data_home(None, home), PathBuf::from("/home/u/.local/share"));
        assert_eq!(user_data_home(Some(""), home), PathBuf::from("/home/u/.local/share"));
        assert_eq!(user_data_home(Some("/data"), home), PathBuf::from("/data"));
        assert_eq!(
            flatpak_bin_dirs(Path::new("/home/u/.local/share")),
            [
                PathBuf::from("/var/lib/flatpak/exports/bin"),
                PathBuf::from("/home/u/.local/share/flatpak/exports/bin")
            ]
        );

        let xdg = vec![
            PathBuf::from("/home/u/.local/share/applications"),
            PathBuf::from("/var/lib/flatpak/exports/share/applications"),
            PathBuf::from("/usr/share/applications"),
        ];
        assert_eq!(
            linux_desktop_dirs(xdg, Path::new("/home/u/.local/share")),
            [
                "/home/u/.local/share/applications",
                "/var/lib/flatpak/exports/share/applications",
                "/usr/share/applications",
                "/home/u/.local/share/flatpak/exports/share/applications",
                "/var/lib/snapd/desktop/applications",
            ]
            .map(PathBuf::from)
        );
        assert_eq!(
            linux_toolbox_scripts_dir(home),
            PathBuf::from("/home/u/.local/share/JetBrains/Toolbox/scripts")
        );
    }

    /// An env with only the Linux folders, under `root`.
    fn linux_env(root: &Path) -> SearchEnv {
        SearchEnv {
            path: vec![root.join("usr/bin")],
            bin_dirs: vec![root.join("home/.local/bin"), root.join("snap/bin")],
            toolbox_scripts: Some(root.join("toolbox")),
            flatpak_bins: vec![root.join("fp-system/bin"), root.join("fp-user/bin")],
            desktop_dirs: vec![root.join("home/apps"), root.join("usr/apps")],
            ..SearchEnv::default()
        }
    }

    /// An absolute path as an `Exec=` line carries it; forward slashes survive on every OS.
    fn exec_path(p: &Path) -> String {
        p.to_string_lossy().replace('\\', "/")
    }

    fn write_desktop(dir: &Path, file: &str, exec: &str) {
        touch(&dir.join(file));
        std::fs::write(dir.join(file), format!("[Desktop Entry]\nName=x\nExec={exec}\n")).unwrap();
    }

    #[test]
    fn snap_and_user_bin_commands_are_found_by_name() {
        let root = temp_dir("linuxbins");
        let env = linux_env(&root);
        assert_eq!(detect_posix("pycharm", &env), None);
        touch(&root.join("snap/bin/pycharm-community"));
        touch(&root.join("home/.local/bin/subl"));
        touch(&root.join("snap/bin/intellij-idea-ultimate"));
        assert_eq!(detect_posix("pycharm", &env), Some(root.join("snap/bin/pycharm-community")));
        assert_eq!(detect_posix("sublime", &env), Some(root.join("home/.local/bin/subl")));
        assert_eq!(detect_posix("intellij", &env), Some(root.join("snap/bin/intellij-idea-ultimate")));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn linux_detection_order_is_path_toolbox_flatpak_then_desktop() {
        let root = temp_dir("linuxorder");
        let env = linux_env(&root);
        let desktop_dir = root.join("home/apps");
        let appimage = root.join("home/Applications/idea.AppImage");
        touch(&appimage);
        write_desktop(&desktop_dir, "jetbrains-idea-abc123.desktop", &exec_path(&appimage));
        assert_eq!(detect_posix("intellij", &env), Some(appimage.clone()));

        touch(&root.join("fp-user/bin/com.jetbrains.IntelliJ-IDEA-Community"));
        assert_eq!(
            detect_posix("intellij", &env),
            Some(root.join("fp-user/bin/com.jetbrains.IntelliJ-IDEA-Community"))
        );
        // The system Flatpak folder is searched first.
        touch(&root.join("fp-system/bin/com.jetbrains.IntelliJ-IDEA-Ultimate"));
        assert_eq!(
            detect_posix("intellij", &env),
            Some(root.join("fp-system/bin/com.jetbrains.IntelliJ-IDEA-Ultimate"))
        );

        touch(&root.join("toolbox/idea"));
        assert_eq!(detect_posix("intellij", &env), Some(root.join("toolbox/idea")));

        touch(&root.join("usr/bin/idea"));
        assert_eq!(detect_posix("intellij", &env), Some(root.join("usr/bin/idea")));
        assert_eq!(detect_posix("pycharm", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn flatpak_launchers_are_found_per_app_id() {
        let root = temp_dir("linuxflatpak");
        let env = linux_env(&root);
        for (id, _) in NAMES {
            assert_eq!(flatpak_launcher(id, &env), None, "{id}");
        }
        touch(&root.join("fp-user/bin/com.visualstudio.code"));
        touch(&root.join("fp-user/bin/dev.zed.Zed"));
        touch(&root.join("fp-user/bin/com.example.Other"));
        assert_eq!(detect_posix("vscode", &env), Some(root.join("fp-user/bin/com.visualstudio.code")));
        assert_eq!(detect_posix("zed", &env), Some(root.join("fp-user/bin/dev.zed.Zed")));
        assert_eq!(detect_posix("vscodium", &env), None);
        assert_eq!(detect_posix("cursor", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn desktop_files_lead_to_the_editor_program_that_exists() {
        let root = temp_dir("linuxdesktop");
        let env = linux_env(&root);
        let user_apps = root.join("home/apps");
        let sys_apps = root.join("usr/apps");
        let code = root.join("usr/share/code/code");
        let cursor = root.join("home/Applications/cursor.AppImage");

        // The deb's `code.desktop`, until its program exists.
        write_desktop(&sys_apps, "code.desktop", &format!("{} %F", exec_path(&code)));
        assert_eq!(detect_posix("vscode", &env), None);
        touch(&code);
        assert_eq!(detect_posix("vscode", &env), Some(code.clone()));

        // Arguments before the file code travel with the program (Ubuntu's AppArmor needs the
        // AppImage's `--no-sandbox`); a plain entry has none.
        write_desktop(&user_apps, "cursor.desktop", &format!("{} --no-sandbox %U", exec_path(&cursor)));
        assert_eq!(detect_posix("cursor", &env), None);
        touch(&cursor);
        assert_eq!(detect_posix("cursor", &env), Some(cursor.clone()));
        assert_eq!(
            detect_posix_with_args("cursor", &env),
            Some((cursor, vec!["--no-sandbox".to_string()]))
        );
        assert_eq!(detect_posix_with_args("vscode", &env), Some((code.clone(), Vec::new())));

        // A Flatpak export's entry and a relative name are skipped.
        write_desktop(
            &user_apps,
            "codium.desktop",
            "/usr/bin/flatpak run --command=codium com.vscodium.codium @@ %F @@",
        );
        assert_eq!(detect_posix("vscodium", &env), None);
        write_desktop(&user_apps, "windsurf.desktop", "windsurf %F");
        assert_eq!(detect_posix("windsurf", &env), None);

        // A terminal entry is skipped even with a real program.
        let zed = root.join("opt/zed/zed");
        touch(&zed);
        touch(&user_apps.join("zed.desktop"));
        std::fs::write(
            user_apps.join("zed.desktop"),
            format!("[Desktop Entry]\nExec={} %U\nTerminal=true\n", exec_path(&zed)),
        )
        .unwrap();
        assert_eq!(detect_posix("zed", &env), None);
        // Zed's own id is tried after the plain one, and a later folder after an unusable first.
        write_desktop(&sys_apps, "dev.zed.Zed.desktop", &format!("{} %U", exec_path(&zed)));
        assert_eq!(detect_posix("zed", &env), Some(zed));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn toolbox_desktop_files_are_matched_by_product_prefix() {
        let root = temp_dir("linuxtoolbox");
        let env = linux_env(&root);
        let apps = root.join("home/apps");
        let idea = root.join("tb/apps/intellij-idea-ultimate/bin/idea");
        let pycharm = root.join("tb/apps/pycharm-professional/bin/pycharm");
        let rider = root.join("tb/apps/rider/bin/rider");
        for p in [&idea, &pycharm, &rider] {
            touch(p);
        }
        write_desktop(&apps, "jetbrains-idea-9d8c7b6a.desktop", &format!("\"{}\" %u", exec_path(&idea)));
        write_desktop(&apps, "jetbrains-pycharm-ce.desktop", &format!("{} %u", exec_path(&pycharm)));
        write_desktop(&apps, "jetbrains-toolbox.desktop", &format!("{} %u", exec_path(&rider)));
        write_desktop(&apps, "jetbrains-riders.desktop", &format!("{} %u", exec_path(&rider)));
        assert_eq!(detect_posix("intellij", &env), Some(idea));
        assert_eq!(detect_posix("pycharm", &env), Some(pycharm));
        assert_eq!(detect_posix("rider", &env), None);
        write_desktop(&apps, "jetbrains-rider.desktop", &format!("{} %u", exec_path(&rider)));
        assert_eq!(detect_posix("rider", &env), Some(rider));
        assert_eq!(detect_posix("webstorm", &env), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn missing_linux_folders_find_nothing() {
        let root = temp_dir("linuxmissing");
        let env = SearchEnv {
            flatpak_bins: vec![root.join("nope/bin")],
            desktop_dirs: vec![root.join("nope/apps")],
            ..SearchEnv::default()
        };
        for (id, _) in NAMES {
            assert_eq!(detect_posix(id, &env), None, "{id}");
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn editors_runs_against_the_real_machine() {
        let started = std::time::Instant::now();
        let found = editors();
        assert_eq!(found.last().map(|e| e.id.as_str()), Some("default"));
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "{:?}", started.elapsed());
    }

    #[test]
    fn every_setting_id_has_a_name() {
        let ids: Vec<&str> = NAMES.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, crate::settings::EDITOR_IDS);
    }
}
