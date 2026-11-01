//! Editor detection and `open_in_editor` (docs/design.md section 3.12).
//!
//! Every editor runs from its `.exe` with an argument list, never through a shell (section 9).
//! VS Code, Cursor, Windsurf, VS Code Insiders, and VSCodium put only `.cmd` shims on `PATH`, so a
//! shim found there is traded for the exe one folder up. JetBrains IDEs are found by exe name on
//! `PATH`, through a Toolbox App script on `PATH`, or in install folders by `product-info.json`
//! version (`find_jetbrains`).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

use crate::settings::SettingsState;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Editor {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct Opened {
    fallback: bool,
}

const NAMES: [(&str, &str); 18] = [
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
    ("default", "The file's default app"),
];

/// The folders detection looks in, gathered once so tests can point them at temp folders.
#[derive(Debug, Default)]
struct SearchEnv {
    path: Vec<PathBuf>,
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
        Self {
            path: std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            local_app_data: var("LOCALAPPDATA"),
            program_files: var("ProgramFiles"),
            program_files_x86: var("ProgramFiles(x86)"),
        }
    }
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
    hide_console(&mut cmd);
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

/// The editor's executable, or None when it is not installed. `default` has none.
fn detect(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    if id == "visualStudio" {
        return find_devenv(env);
    }
    if let Some((exe, script)) = jetbrains(id) {
        return find_jetbrains(exe, script, env);
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

#[cfg(windows)]
pub(crate) fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW: a console program (Zed's CLI, vswhere) would otherwise flash a window.
    // GUI programs ignore it.
    cmd.creation_flags(0x0800_0000);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_cmd: &mut Command) {}

/// Starts the program detached. A `.cmd` or `.bat` program (only possible through
/// `editor.command`) is run by the standard library through `cmd.exe` with its batch-file
/// argument escaping, which refuses arguments it cannot quote safely.
fn launch(program: &Path, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    hide_console(&mut cmd);
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start {}: {e}", program.display()))
}

fn normalize_existing(path: &str) -> Result<PathBuf, String> {
    let p = crate::files::normalize(path)?;
    if !p.exists() {
        return Err(format!("{} does not exist", p.display()));
    }
    Ok(p)
}

/// The editors found on this machine, in the order of section 3.12's table; `default` is always
/// last.
#[tauri::command]
pub fn editors() -> Vec<Editor> {
    let env = SearchEnv::from_process();
    NAMES
        .iter()
        .filter(|(id, _)| *id == "default" || detect(id, &env).is_some())
        .map(|(id, name)| Editor {
            id: (*id).into(),
            name: (*name).into(),
        })
        .collect()
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
        return Ok(Opened { fallback: false });
    }
    let line = line.filter(|_| path.is_file());
    if editor.preferred != "default" {
        if let Some(exe) = detect(&editor.preferred, &SearchEnv::from_process()) {
            if launch(&exe, &table_args(&editor.preferred, &path, line)).is_ok() {
                return Ok(Opened { fallback: false });
            }
        }
    }
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(Opened {
        fallback: editor.preferred != "default",
    })
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

    #[test]
    fn detects_in_install_folders_and_on_path() {
        let root = temp_dir("detect");
        let env = SearchEnv {
            path: vec![root.join("vsc").join("bin"), root.join("npp")],
            local_app_data: Some(root.join("local")),
            program_files: Some(root.join("pf")),
            program_files_x86: None,
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

    fn env_at(root: &Path, path: Vec<PathBuf>) -> SearchEnv {
        SearchEnv {
            path,
            local_app_data: Some(root.join("local")),
            program_files: Some(root.join("pf")),
            program_files_x86: None,
        }
    }

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
        let dotted = format!("{}\\sub\\..\\a.txt", root.display());
        assert_eq!(normalize_existing(&dotted).unwrap(), root.join("a.txt"));
        assert!(normalize_existing(&format!("{}\\missing.txt", root.display())).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn every_setting_id_has_a_name() {
        let ids: Vec<&str> = NAMES.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, crate::settings::EDITOR_IDS);
    }
}
