//! Editor detection and `open_in_editor` (docs/design.md section 3.12).
//!
//! Every editor runs from its `.exe` with an argument list, never through a shell (section 9).
//! VS Code and Cursor put only `.cmd` shims on `PATH`, so a shim found there is traded for the
//! `Code.exe` or `Cursor.exe` one folder up.

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

const NAMES: [(&str, &str); 7] = [
    ("zed", "Zed"),
    ("vscode", "VS Code"),
    ("cursor", "Cursor"),
    ("visualStudio", "Visual Studio"),
    ("notepadpp", "Notepad++"),
    ("sublime", "Sublime Text"),
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

/// The editor's executable, or None when it is not installed. `default` has none.
fn detect(id: &str, env: &SearchEnv) -> Option<PathBuf> {
    if id == "visualStudio" {
        return find_devenv(env);
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
        "vscode" | "cursor" => match line {
            Some(_) => vec!["-g".into(), at(line)],
            None => vec![p],
        },
        "visualStudio" => vec!["/edit".into(), p],
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
    }

    #[test]
    fn table_args_without_a_line() {
        let p = Path::new(FILE);
        for id in ["zed", "vscode", "cursor", "notepadpp", "sublime"] {
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
        for id in [
            "zed",
            "vscode",
            "cursor",
            "notepadpp",
            "sublime",
            "visualStudio",
            "default",
        ] {
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
