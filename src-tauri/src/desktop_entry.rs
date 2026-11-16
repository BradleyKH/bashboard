//! Freedesktop `.desktop` files: finding one by desktop id in the XDG application folders and
//! turning its `Exec=` line into an argument list for one file, per the Desktop Entry
//! Specification. Nothing here runs a shell; the result is an argument list for `Command`.
//!
//! The parsing is pure so it is tested on every OS; only Linux calls it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// The `[Desktop Entry]` group's keys that launching needs.
#[derive(Debug, Default, PartialEq)]
pub struct Entry {
    pub name: String,
    pub exec: String,
    pub icon: String,
    /// `Terminal=true`: the program needs a terminal around it, so it cannot be started bare.
    pub terminal: bool,
}

/// Reads the `[Desktop Entry]` group; `None` when it has no `Exec`. Localized keys
/// (`Name[de]`) are skipped.
pub fn parse(text: &str) -> Option<Entry> {
    let mut entry = Entry::default();
    let mut in_group = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_group = line == "[Desktop Entry]";
            continue;
        }
        if !in_group || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = unescape_value(value.trim());
        match key.trim() {
            "Name" => entry.name = value,
            "Exec" => entry.exec = value,
            "Icon" => entry.icon = value,
            "Terminal" => entry.terminal = value == "true",
            _ => {}
        }
    }
    (!entry.exec.is_empty()).then_some(entry)
}

/// The general string escapes every value may use (`\s`, `\n`, `\t`, `\r`, `\\`).
fn unescape_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                // Left for `split_exec`, whose quoting has escapes of its own (`\"`, `\$`).
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Splits an `Exec` value into arguments: spaces separate them, double quotes group one, and
/// inside quotes a backslash escapes the next character. `None` for an unclosed quote.
fn split_exec(s: &str) -> Option<Vec<String>> {
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut has_arg = false;
    let mut quoted = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                quoted = !quoted;
                has_arg = true;
            }
            '\\' if quoted => cur.push(chars.next()?),
            ' ' | '\t' if !quoted => {
                if has_arg {
                    args.push(std::mem::take(&mut cur));
                    has_arg = false;
                }
            }
            _ => {
                cur.push(c);
                has_arg = true;
            }
        }
    }
    if quoted {
        return None;
    }
    if has_arg {
        args.push(cur);
    }
    Some(args)
}

/// The program an `Exec` line starts: its first argument, with no field codes expanded. `None`
/// for an `Exec` that does not parse or is empty.
pub fn exec_program(entry: &Entry) -> Option<String> {
    split_exec(&entry.exec)?.into_iter().next()
}

/// The arguments after the program that come before the first field code, with `%%` read as a
/// literal percent. They are flags the launcher needs on every run (an AppImage editor's
/// `--no-sandbox`), so they are kept when the program is started directly. Empty for an `Exec`
/// that does not parse.
pub fn exec_args_before_field(entry: &Entry) -> Vec<String> {
    let mut args = Vec::new();
    for token in split_exec(&entry.exec).unwrap_or_default().into_iter().skip(1) {
        let mut out = String::new();
        let mut chars = token.chars().peekable();
        while let Some(c) = chars.next() {
            match (c, chars.peek()) {
                ('%', Some('%')) => {
                    chars.next();
                    out.push('%');
                }
                ('%', Some(_)) => return args,
                _ => out.push(c),
            }
        }
        args.push(out);
    }
    args
}

/// The argument list that opens `file` with `entry`, whose file is at `entry_path`. The file
/// fills `%f`, `%F`, `%u`, or `%U` (a path is a valid `%u`), or is appended when the line has
/// none of them, as GLib does. `None` for a terminal program or an `Exec` that does not parse.
pub fn command_for_file(entry: &Entry, file: &Path, entry_path: &Path) -> Option<Vec<String>> {
    if entry.terminal {
        return None;
    }
    let file = file.display().to_string();
    let mut used_file = false;
    let mut argv = Vec::new();
    for token in split_exec(&entry.exec)? {
        if token == "%i" {
            if !entry.icon.is_empty() {
                argv.extend(["--icon".to_string(), entry.icon.clone()]);
            }
            continue;
        }
        let mut out = String::new();
        let mut only_codes = true;
        let mut chars = token.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                out.push(c);
                only_codes = false;
                continue;
            }
            match chars.next() {
                Some('f' | 'F' | 'u' | 'U') => {
                    out.push_str(&file);
                    used_file = true;
                    only_codes = false;
                }
                Some('c') => out.push_str(&entry.name),
                Some('k') => out.push_str(&entry_path.display().to_string()),
                Some('%') => {
                    out.push('%');
                    only_codes = false;
                }
                // Deprecated and unknown codes are removed.
                _ => {}
            }
        }
        if !(only_codes && out.is_empty()) {
            argv.push(out);
        }
    }
    if argv.is_empty() {
        return None;
    }
    if !used_file {
        argv.push(file);
    }
    Some(argv)
}

/// The `applications` folders in lookup order: `$XDG_DATA_HOME` (default `~/.local/share`), then
/// each `$XDG_DATA_DIRS` entry (default `/usr/local/share:/usr/share`).
pub fn application_dirs(data_home: Option<&str>, data_dirs: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match data_home.filter(|s| !s.is_empty()) {
        Some(h) => dirs.push(PathBuf::from(h)),
        None => dirs.extend(home.map(|h| h.join(".local/share"))),
    }
    let data_dirs = data_dirs.filter(|s| !s.is_empty()).unwrap_or("/usr/local/share:/usr/share");
    dirs.extend(data_dirs.split(':').filter(|d| !d.is_empty()).map(PathBuf::from));
    dirs.into_iter().map(|d| d.join("applications")).collect()
}

/// Where a desktop id may live under one `applications` folder: the id itself, and the forms
/// with leading `-`s read as subfolders (`kde-foo.desktop` is also `kde/foo.desktop`).
fn id_paths(id: &str) -> Vec<String> {
    let mut paths = vec![id.to_string()];
    let mut cur = id.to_string();
    while let Some(i) = cur.find('-') {
        cur.replace_range(i..=i, "/");
        paths.push(cur.clone());
    }
    paths
}

/// The first file for desktop id `id` in `dirs`, as `exists` reports.
pub fn find_in(id: &str, dirs: &[PathBuf], exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    if id.contains('/') || id.contains("..") {
        return None;
    }
    dirs.iter()
        .flat_map(|d| id_paths(id).into_iter().map(move |p| d.join(p)))
        .find(|p| exists(p))
}

/// The `applications` folders as a child process would see them, outside any AppImage.
pub fn system_application_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    application_dirs(
        crate::child_process::var("XDG_DATA_HOME").as_deref(),
        crate::child_process::var("XDG_DATA_DIRS").as_deref(),
        home.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(exec: &str) -> Entry {
        Entry { name: "Text Editor".into(), exec: exec.into(), icon: "editor".into(), terminal: false }
    }

    fn argv(exec: &str) -> Option<Vec<String>> {
        command_for_file(&entry(exec), Path::new("/home/me/run me.sh"), Path::new("/usr/share/applications/e.desktop"))
    }

    fn strs(v: &[&str]) -> Option<Vec<String>> {
        Some(v.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn reads_the_desktop_entry_group_only() {
        let text = "# c\n[Desktop Entry]\nName=Text Editor\nName[de]=Texteditor\nExec=gnome-text-editor %U\n\
                    Icon=org.gnome.TextEditor\nTerminal=false\n[Desktop Action new-window]\nExec=other\n";
        let e = parse(text).unwrap();
        assert_eq!(e.name, "Text Editor");
        assert_eq!(e.exec, "gnome-text-editor %U");
        assert_eq!(e.icon, "org.gnome.TextEditor");
        assert!(!e.terminal);
        assert!(parse("[Desktop Entry]\nTerminal=true\nExec=vim %F\n").unwrap().terminal);
        assert_eq!(parse("[Desktop Entry]\nName=x\n"), None);
        assert_eq!(parse("[Other]\nExec=x\n"), None);
    }

    #[test]
    fn the_file_fills_its_field_code_as_one_argument() {
        assert_eq!(argv("gnome-text-editor %U"), strs(&["gnome-text-editor", "/home/me/run me.sh"]));
        assert_eq!(argv("kate -b %u"), strs(&["kate", "-b", "/home/me/run me.sh"]));
        assert_eq!(argv("xed %F"), strs(&["xed", "/home/me/run me.sh"]));
        assert_eq!(argv("ed --file=%f"), strs(&["ed", "--file=/home/me/run me.sh"]));
    }

    #[test]
    fn without_a_file_code_the_file_is_appended() {
        assert_eq!(argv("mousepad"), strs(&["mousepad", "/home/me/run me.sh"]));
    }

    #[test]
    fn other_field_codes_expand_or_drop() {
        assert_eq!(
            argv("ed %i --class %c %k %d 100%% %f"),
            strs(&[
                "ed", "--icon", "editor", "--class", "Text Editor", "/usr/share/applications/e.desktop",
                "100%", "/home/me/run me.sh"
            ])
        );
    }

    #[test]
    fn quotes_group_and_escape() {
        assert_eq!(
            argv(r#""/opt/My Editor/ed" --title "a \"b\" \$c" %f"#),
            strs(&["/opt/My Editor/ed", "--title", r#"a "b" $c"#, "/home/me/run me.sh"])
        );
        assert_eq!(argv(r#"flatpak run "--command=ed" org.ed %U"#).unwrap()[2..4], ["--command=ed", "org.ed"]);
        assert_eq!(argv(r#"ed "unclosed %f"#), None);
        // `\s` is a general value escape, applied when the file is read.
        assert_eq!(parse("[Desktop Entry]\nExec=a\\sb %f\n").unwrap().exec, "a b %f");
        // A literal backslash inside quotes is `\\\\` in the file: one level per escaping layer.
        let e = parse("[Desktop Entry]\nExec=ed \"a\\\\\\\\b\" %f\n").unwrap();
        assert_eq!(command_for_file(&e, Path::new("/f"), Path::new("/e")), strs(&["ed", r"a\b", "/f"]));
    }

    #[test]
    fn the_program_is_the_first_argument() {
        assert_eq!(exec_program(&entry("/usr/share/code/code %F")).as_deref(), Some("/usr/share/code/code"));
        assert_eq!(exec_program(&entry("\"/opt/My Editor/ed\" %U")).as_deref(), Some("/opt/My Editor/ed"));
        assert_eq!(exec_program(&entry("code")).as_deref(), Some("code"));
        assert_eq!(exec_program(&entry("\"unclosed %f")), None);
        assert_eq!(exec_program(&entry("   ")), None);
    }

    #[test]
    fn args_before_the_first_field_code_are_kept() {
        let args = |exec: &str| exec_args_before_field(&entry(exec));
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(args("/a/cursor.AppImage --no-sandbox %U"), v(&["--no-sandbox"]));
        assert_eq!(args(r#"/a/ed --title "a b" -x %F --after"#), v(&["--title", "a b", "-x"]));
        assert_eq!(args("/a/ed 100%% --flag=%f"), v(&["100%"]));
        assert_eq!(args("/a/ed --one %i --two %f"), v(&["--one"]));
        assert_eq!(args("/a/ed %c %f"), Vec::<String>::new());
        assert_eq!(args("/a/ed --solo"), v(&["--solo"]));
        assert_eq!(args("/a/ed"), Vec::<String>::new());
        assert_eq!(args(r#"/a/ed "unclosed %f"#), Vec::<String>::new());
    }

    #[test]
    fn terminal_programs_and_empty_lines_are_refused() {
        let mut e = entry("vim %F");
        e.terminal = true;
        assert_eq!(command_for_file(&e, Path::new("/f"), Path::new("/e")), None);
        assert_eq!(argv("%f"), strs(&["/home/me/run me.sh"]));
        assert_eq!(argv("%d"), None);
    }

    #[test]
    fn application_dirs_follow_xdg_defaults() {
        let home = Path::new("/home/me");
        assert_eq!(
            application_dirs(None, None, Some(home)),
            [
                PathBuf::from("/home/me/.local/share/applications"),
                PathBuf::from("/usr/local/share/applications"),
                PathBuf::from("/usr/share/applications"),
            ]
        );
        assert_eq!(
            application_dirs(Some("/d"), Some("/a::/b"), Some(home)),
            [PathBuf::from("/d/applications"), PathBuf::from("/a/applications"), PathBuf::from("/b/applications")]
        );
    }

    #[test]
    fn ids_are_found_in_order_and_in_prefix_folders() {
        let dirs = [PathBuf::from("/u/applications"), PathBuf::from("/s/applications")];
        let has = |want: &'static [&'static str]| move |p: &Path| want.iter().any(|w| p == Path::new(w));
        assert_eq!(
            find_in("ed.desktop", &dirs, has(&["/s/applications/ed.desktop", "/u/applications/ed.desktop"])),
            Some(PathBuf::from("/u/applications/ed.desktop"))
        );
        assert_eq!(
            find_in("kde-kate.desktop", &dirs, has(&["/s/applications/kde/kate.desktop"])),
            Some(PathBuf::from("/s/applications/kde/kate.desktop"))
        );
        assert_eq!(find_in("../x.desktop", &dirs, |_| true), None);
        assert_eq!(find_in("missing.desktop", &dirs, |_| false), None);
    }
}
