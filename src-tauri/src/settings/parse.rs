//! The lenient JSONC parser: each invalid field falls back to its default with a warning.

use std::{collections::HashMap, io::Read};

use serde_json::Value;

use super::keybindings::parse_keybindings;
use super::model::*;

/// The classic rain color, the one `#rrggbb` that maps to the green mode.
const MATRIX_GREEN: &str = "#00ff41";

/// A mode, or a `#rrggbb` from a file that predates modes: the classic green reads as green and
/// any other hex as accent. Mapped silently so those files load without a notice.
fn parse_matrix_color(s: &str) -> Option<String> {
    if MATRIX_COLOR_MODES.contains(&s) {
        return Some(s.into());
    }
    let hex = parse_hex(s)?;
    Some(if hex == MATRIX_GREEN { "green" } else { "accent" }.into())
}

/// The accent is drawn as text on near-black panes and behind dark text in find highlights; at
/// this WCAG relative luminance both keep at least 4.5:1 contrast. Mirrors src/accent.ts.
const ACCENT_MIN_LUMINANCE: f64 = 0.2;

/// The White text color, the one `#rrggbb` that maps to the white mode.
const WHITE_CONTENT_TEXT: &str = "#e6e6e6";

/// Accepts `#rrggbb` (any case) bright enough to read, returned lowercase.
fn parse_accent(s: &str) -> Option<String> {
    parse_bright_hex(s, ACCENT_MIN_LUMINANCE)
}

/// A mode, or a `#rrggbb` from a file that predates modes: White's hex reads as white and any
/// other hex as accent, since every other preset was an accent tint. Mapped silently so those
/// files load without a notice.
fn parse_content_text(s: &str) -> Option<String> {
    if CONTENT_TEXT_MODES.contains(&s) {
        return Some(s.into());
    }
    let hex = parse_hex(s)?;
    Some(if hex == WHITE_CONTENT_TEXT { "white" } else { "accent" }.into())
}

/// Accepts `#rrggbb` (any case) of any lightness, returned lowercase.
fn parse_hex(s: &str) -> Option<String> {
    parse_bright_hex(s, 0.0)
}

/// Accepts `#rrggbb` (any case) at or above `min` WCAG relative luminance, returned lowercase.
fn parse_bright_hex(s: &str, min: f64) -> Option<String> {
    let hex = s.strip_prefix('#').filter(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()))?;
    let channel = |i: usize| {
        let c = f64::from(u8::from_str_radix(&hex[i..i + 2], 16).ok()?) / 255.0;
        Some(if c <= 0.03928 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) })
    };
    let luminance = 0.2126 * channel(0)? + 0.7152 * channel(2)? + 0.0722 * channel(4)?;
    (luminance >= min).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

/// Expands `%VAR%` references; unknown variables and stray `%` are left as written.
pub fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match std::env::var(&after[..end]) {
                Ok(val) => {
                    out.push_str(&val);
                    rest = &after[end + 1..];
                }
                Err(_) => {
                    out.push('%');
                    rest = after;
                }
            },
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn get<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(root, |v, k| v.get(*k))
}

fn pick<T>(
    root: &Value,
    path: &[&str],
    warnings: &mut Vec<String>,
    parse: impl Fn(&Value) -> Option<T>,
    default: T,
) -> T {
    match get(root, path) {
        None => default,
        Some(v) => parse(v).unwrap_or_else(|| {
            warnings.push(format!("{}: invalid value, using default", path.join(".")));
            default
        }),
    }
}

/// Each bad entry is dropped with a warning and the rest kept. Keys are lowercased, so a later
/// entry that differs only in case replaces an earlier one.
fn parse_ship_hosts(root: &Value, warnings: &mut Vec<String>) -> HashMap<String, String> {
    let mut hosts = HashMap::new();
    let Some(v) = get(root, &["ship", "hosts"]) else {
        return hosts;
    };
    let Some(map) = v.as_object() else {
        warnings.push("ship.hosts: invalid value, using default".into());
        return hosts;
    };
    for (host, kind) in map {
        match kind.as_str().filter(|k| FORGE_KINDS.contains(k)) {
            Some(kind) if !host.is_empty() => {
                hosts.insert(host.to_lowercase(), kind.to_string());
            }
            _ => warnings.push(format!("ship.hosts.{host}: invalid entry, dropped")),
        }
    }
    hosts
}

/// Each bad entry is dropped with a warning naming its index and the rest kept.
fn parse_pinned_repos(root: &Value, warnings: &mut Vec<String>) -> Vec<PinnedRepo> {
    let Some(v) = get(root, &["ship", "pinnedRepos"]) else {
        return Vec::new();
    };
    let Some(items) = v.as_array() else {
        warnings.push("ship.pinnedRepos: invalid value, using default".into());
        return Vec::new();
    };
    let nonempty = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(String::from);
    let mut pins = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let repo = item.get("repo").and_then(nonempty);
        let clone = match item.get("root") {
            None => Some(None),
            Some(v) => v.as_str().map(|s| Some(s.to_string())),
        };
        let branches = match item.get("branches") {
            None => Some(None),
            Some(v) => v
                .as_array()
                .and_then(|a| a.iter().map(nonempty).collect::<Option<Vec<_>>>())
                .map(Some),
        };
        match (repo, clone, branches) {
            (Some(repo), Some(root), Some(branches)) => pins.push(PinnedRepo { repo, root, branches }),
            _ => warnings.push(format!("ship.pinnedRepos[{i}]: invalid entry, dropped")),
        }
    }
    pins
}

/// Each bad entry is dropped with a warning naming its index and the rest kept.
fn parse_bookmarks(root: &Value, warnings: &mut Vec<String>) -> Vec<Bookmark> {
    let Some(v) = get(root, &["localBrowser", "bookmarks"]) else {
        return Vec::new();
    };
    let Some(items) = v.as_array() else {
        warnings.push("localBrowser.bookmarks: invalid value, using default".into());
        return Vec::new();
    };
    let nonempty = |v: &Value| v.as_str().filter(|s| !s.is_empty()).map(String::from);
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let name = item.get("name").and_then(nonempty);
        let url = item.get("url").and_then(nonempty);
        match (name, url) {
            (Some(name), Some(url)) if crate::browser_policy::is_loopback_url(&url) => out.push(Bookmark { name, url }),
            (Some(_), Some(_)) => warnings.push(format!("localBrowser.bookmarks[{i}]: not a loopback http(s) URL, dropped")),
            _ => warnings.push(format!("localBrowser.bookmarks[{i}]: invalid entry, dropped")),
        }
    }
    out
}

/// The settings file's root object with comments stripped.
/// Settings files written before the Wave style took its name say `lissajous` for the style and
/// the block. Both still load: the style maps to `wave`, and each `backdrop.lissajous` field fills
/// in the matching `backdrop.wave` field the file doesn't set, so a Settings tab edit (which
/// writes under `wave`) wins over the old value without discarding the rest.
fn accept_legacy_wave(root: &mut Value) {
    let Some(backdrop) = root.get_mut("backdrop").and_then(Value::as_object_mut) else { return };
    if backdrop.get("style").and_then(Value::as_str) == Some("lissajous") {
        backdrop.insert("style".into(), Value::from("wave"));
    }
    let Some(Value::Object(legacy)) = backdrop.remove("lissajous") else { return };
    let wave = backdrop.entry("wave").or_insert_with(|| Value::Object(Default::default()));
    if let Some(wave) = wave.as_object_mut() {
        for (key, value) in legacy {
            wave.entry(key).or_insert(value);
        }
    }
}

pub(super) fn parse_root(text: &str) -> Result<Value, String> {
    let mut stripped = String::new();
    let parsed = json_comments::StripComments::new(text.as_bytes())
        .read_to_string(&mut stripped)
        .map_err(|e| e.to_string())
        .and_then(|_| serde_json::from_str::<Value>(&stripped).map_err(|e| e.to_string()));
    match parsed {
        Ok(v @ Value::Object(_)) => Ok(v),
        Ok(_) => Err("settings file must be a JSON object".into()),
        Err(e) => Err(format!("settings file is not valid JSON ({e})")),
    }
}

/// Never fails: bad input degrades to defaults and is reported in the warnings.
#[cfg(test)]
pub(super) fn parse_settings(text: &str) -> (Settings, Vec<String>) {
    try_parse_settings(text).unwrap_or_else(|e| (Settings::default(), vec![format!("{e}, using defaults")]))
}

/// Errs only when the file as a whole is unusable; a bad field degrades to its default.
pub(super) fn try_parse_settings(text: &str) -> Result<(Settings, Vec<String>), String> {
    let mut root = parse_root(text)?;
    accept_legacy_wave(&mut root);

    let d = Settings::default();
    let mut w = Vec::new();
    let string = |v: &Value| v.as_str().map(String::from);
    let number = |v: &Value| v.as_f64();
    let boolean = |v: &Value| v.as_bool();

    let shell = Shell {
        path: pick(&root, &["shell", "path"], &mut w, string, d.shell.path),
        args: pick(
            &root,
            &["shell", "args"],
            &mut w,
            |v| v.as_array()?.iter().map(string).collect::<Option<Vec<_>>>(),
            d.shell.args,
        ),
        starting_directory: pick(
            &root,
            &["shell", "startingDirectory"],
            &mut w,
            string,
            d.shell.starting_directory,
        ),
        default_profile: pick(
            &root,
            &["shell", "defaultProfile"],
            &mut w,
            |v| v.as_str().filter(|s| crate::profiles::PROFILE_IDS.contains(s)).map(String::from),
            d.shell.default_profile,
        ),
    };
    let font = Font {
        family: pick(&root, &["font", "family"], &mut w, string, d.font.family),
        size: pick(&root, &["font", "size"], &mut w, |v| number(v).filter(|n| *n > 0.0), d.font.size),
    };
    let accent_color = pick(
        &root,
        &["accentColor"],
        &mut w,
        |v| v.as_str().and_then(parse_accent),
        d.accent_color,
    );
    let content_text_color = pick(
        &root,
        &["contentTextColor"],
        &mut w,
        |v| v.as_str().and_then(parse_content_text),
        d.content_text_color,
    );
    let code_colors = CodeColors {
        scheme: pick(
            &root,
            &["codeColors", "scheme"],
            &mut w,
            |v| v.as_str().filter(|s| CODE_SCHEMES.contains(s)).map(String::from),
            d.code_colors.scheme,
        ),
    };
    let ui_scale = pick(
        &root,
        &["uiScale"],
        &mut w,
        |v| number(v).filter(|n| (UI_SCALE_MIN..=UI_SCALE_MAX).contains(n)),
        d.ui_scale,
    );
    let agent_glow = pick(&root, &["agentGlow"], &mut w, boolean, d.agent_glow);
    let border_lights = pick(&root, &["borderLights"], &mut w, boolean, d.border_lights);
    let scrim = Scrim {
        opacity: pick(
            &root,
            &["scrim", "opacity"],
            &mut w,
            |v| number(v).filter(|n| (0.0..=1.0).contains(n)),
            d.scrim.opacity,
        ),
        blur_px: pick(
            &root,
            &["scrim", "blurPx"],
            &mut w,
            |v| number(v).filter(|n| *n >= 0.0),
            d.scrim.blur_px,
        ),
    };
    let backdrop = Backdrop {
        style: pick(
            &root,
            &["backdrop", "style"],
            &mut w,
            |v| v.as_str().filter(|s| BACKDROP_STYLES.contains(s)).map(String::from),
            d.backdrop.style,
        ),
        animate: pick(&root, &["backdrop", "animate"], &mut w, boolean, d.backdrop.animate),
        // The frame loop clamps each delta to 1/20 s, so a cap below 20 would slow the simulation.
        max_fps: pick(
            &root,
            &["backdrop", "maxFps"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n == 0 || (20..=240).contains(n)),
            d.backdrop.max_fps,
        ),
        // The organism layer draws at most 12000, which leaves room for the tide's swell above 5000.
        capacity: pick(
            &root,
            &["backdrop", "capacity"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| (300..=5000).contains(n)),
            d.backdrop.capacity,
        ),
        mutation_rate: pick(
            &root,
            &["backdrop", "mutationRate"],
            &mut w,
            |v| number(v).filter(|n| (0.0..=4.0).contains(n)),
            d.backdrop.mutation_rate,
        ),
        zoom: pick(
            &root,
            &["backdrop", "zoom"],
            &mut w,
            |v| number(v).filter(|n| (0.5..=3.0).contains(n)),
            d.backdrop.zoom,
        ),
        matrix: MatrixBackdrop {
            color: pick(
                &root,
                &["backdrop", "matrix", "color"],
                &mut w,
                |v| v.as_str().and_then(parse_matrix_color),
                d.backdrop.matrix.color,
            ),
            zoom: pick(
                &root,
                &["backdrop", "matrix", "zoom"],
                &mut w,
                |v| number(v).filter(|n| (0.5..=3.0).contains(n)),
                d.backdrop.matrix.zoom,
            ),
            speed: pick(
                &root,
                &["backdrop", "matrix", "speed"],
                &mut w,
                |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| (5..=30).contains(n)),
                d.backdrop.matrix.speed,
            ),
            density: pick(
                &root,
                &["backdrop", "matrix", "density"],
                &mut w,
                |v| number(v).filter(|n| (0.25..=4.0).contains(n)),
                d.backdrop.matrix.density,
            ),
        },
        wave: WaveBackdrop {
            color: pick(
                &root,
                &["backdrop", "wave", "color"],
                &mut w,
                |v| v.as_str().filter(|s| WAVE_COLOR_MODES.contains(s)).map(String::from),
                d.backdrop.wave.color,
            ),
            size: pick(
                &root,
                &["backdrop", "wave", "size"],
                &mut w,
                |v| number(v).filter(|n| (0.3..=2.0).contains(n)),
                d.backdrop.wave.size,
            ),
            speed: pick(
                &root,
                &["backdrop", "wave", "speed"],
                &mut w,
                |v| number(v).filter(|n| (0.1..=3.0).contains(n)),
                d.backdrop.wave.speed,
            ),
            line_width: pick(
                &root,
                &["backdrop", "wave", "lineWidth"],
                &mut w,
                |v| number(v).filter(|n| (1.0..=8.0).contains(n)),
                d.backdrop.wave.line_width,
            ),
            echoes: pick(
                &root,
                &["backdrop", "wave", "echoes"],
                &mut w,
                |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n <= 15),
                d.backdrop.wave.echoes,
            ),
        },
        image: ImageBackdrop {
            file: pick(&root, &["backdrop", "image", "file"], &mut w, string, d.backdrop.image.file),
            folder: pick(&root, &["backdrop", "image", "folder"], &mut w, string, d.backdrop.image.folder),
            fit: pick(
                &root,
                &["backdrop", "image", "fit"],
                &mut w,
                |v| v.as_str().filter(|s| IMAGE_FITS.contains(s)).map(String::from),
                d.backdrop.image.fit,
            ),
            interval_seconds: pick(
                &root,
                &["backdrop", "image", "intervalSeconds"],
                &mut w,
                |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| (5..=86400).contains(n)),
                d.backdrop.image.interval_seconds,
            ),
            crossfade_seconds: pick(
                &root,
                &["backdrop", "image", "crossfadeSeconds"],
                &mut w,
                |v| number(v).filter(|n| (0.0..=10.0).contains(n)),
                d.backdrop.image.crossfade_seconds,
            ),
            shuffle: pick(&root, &["backdrop", "image", "shuffle"], &mut w, boolean, d.backdrop.image.shuffle),
            include_subfolders: pick(
                &root,
                &["backdrop", "image", "includeSubfolders"],
                &mut w,
                boolean,
                d.backdrop.image.include_subfolders,
            ),
        },
    };
    let scrollback = pick(
        &root,
        &["scrollback"],
        &mut w,
        |v| v.as_u64().and_then(|n| u32::try_from(n).ok()),
        d.scrollback,
    );
    let terminal = Terminal {
        done_after_seconds: pick(
            &root,
            &["terminal", "doneAfterSeconds"],
            &mut w,
            |v| v.as_u64().filter(|n| *n <= 86_400).and_then(|n| u32::try_from(n).ok()),
            d.terminal.done_after_seconds,
        ),
        notify_when_waiting: pick(
            &root,
            &["terminal", "notifyWhenWaiting"],
            &mut w,
            boolean,
            d.terminal.notify_when_waiting,
        ),
    };
    // containers.enabled predates dashboard.sections.containers and still seeds it.
    let containers_default = get(&root, &["containers", "enabled"])
        .and_then(Value::as_bool)
        .unwrap_or(d.dashboard.sections.containers);
    let section = |w: &mut Vec<String>, name: &str, default: bool| {
        pick(&root, &["dashboard", "sections", name], w, boolean, default)
    };
    // `folder` is the Launch section's name in settings files written before it was Launch.
    let launch_default = section(&mut w, "folder", d.dashboard.sections.launch);
    let dashboard = Dashboard {
        visible_on_start: pick(
            &root,
            &["dashboard", "visibleOnStart"],
            &mut w,
            boolean,
            d.dashboard.visible_on_start,
        ),
        peek_on_waiting: pick(
            &root,
            &["dashboard", "peekOnWaiting"],
            &mut w,
            boolean,
            d.dashboard.peek_on_waiting,
        ),
        side: pick(
            &root,
            &["dashboard", "side"],
            &mut w,
            |v| v.as_str().filter(|s| DASHBOARD_SIDES.contains(s)).map(String::from),
            d.dashboard.side,
        ),
        sections: DashboardSections {
            launch: section(&mut w, "launch", launch_default),
            favorites: section(&mut w, "favorites", d.dashboard.sections.favorites),
            layouts: section(&mut w, "layouts", d.dashboard.sections.layouts),
            panes: section(&mut w, "panes", d.dashboard.sections.panes),
            containers: section(&mut w, "containers", containers_default),
            ports: section(&mut w, "ports", d.dashboard.sections.ports),
            ship: section(&mut w, "ship", d.dashboard.sections.ship),
            local_models: section(&mut w, "localModels", d.dashboard.sections.local_models),
            external: section(&mut w, "external", d.dashboard.sections.external),
            system: section(&mut w, "system", d.dashboard.sections.system),
            wave: section(&mut w, "wave", d.dashboard.sections.wave),
            clock: section(&mut w, "clock", d.dashboard.sections.clock),
        },
        clock_style: pick(
            &root,
            &["dashboard", "clockStyle"],
            &mut w,
            |v| v.as_str().filter(|s| CLOCK_STYLES.contains(s)).map(String::from),
            d.dashboard.clock_style,
        ),
    };
    let restore = Restore {
        enabled: pick(&root, &["restore", "enabled"], &mut w, boolean, d.restore.enabled),
        // The older `resumeClaude` key supplies the value when `resumeSessions` is absent.
        resume_sessions: if get(&root, &["restore", "resumeSessions"]).is_none() {
            pick(&root, &["restore", "resumeClaude"], &mut w, boolean, d.restore.resume_sessions)
        } else {
            pick(&root, &["restore", "resumeSessions"], &mut w, boolean, d.restore.resume_sessions)
        },
        scrollback: pick(&root, &["restore", "scrollback"], &mut w, boolean, d.restore.scrollback),
    };
    let editor = Editor {
        preferred: pick(
            &root,
            &["editor", "preferred"],
            &mut w,
            |v| v.as_str().filter(|s| EDITOR_IDS.contains(s)).map(String::from),
            d.editor.preferred,
        ),
        command: pick(&root, &["editor", "command"], &mut w, string, d.editor.command),
    };
    let git = GitSettings {
        auto_fetch_minutes: pick(
            &root,
            &["git", "autoFetchMinutes"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n <= 1440),
            d.git.auto_fetch_minutes,
        ),
    };
    let local_models = LocalModels {
        ollama_url: pick(&root, &["localModels", "ollamaUrl"], &mut w, string, d.local_models.ollama_url.clone()),
        lm_studio_url: pick(&root, &["localModels", "lmStudioUrl"], &mut w, string, d.local_models.lm_studio_url.clone()),
        min_context: pick(
            &root,
            &["localModels", "minContext"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()),
            d.local_models.min_context,
        ),
    };
    let ship = Ship {
        hosts: parse_ship_hosts(&root, &mut w),
        overview_refresh_minutes: pick(
            &root,
            &["ship", "overviewRefreshMinutes"],
            &mut w,
            |v| v.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| *n <= 1440),
            d.ship.overview_refresh_minutes,
        ),
        pinned_repos: parse_pinned_repos(&root, &mut w),
    };
    let local_browser = LocalBrowser {
        bookmarks: parse_bookmarks(&root, &mut w),
        home_url: pick(
            &root,
            &["localBrowser", "homeUrl"],
            &mut w,
            |v| v.as_str().filter(|s| s.is_empty() || crate::browser_policy::is_loopback_url(s)).map(String::from),
            d.local_browser.home_url.clone(),
        ),
    };
    let keybindings = parse_keybindings(&root, &mut w);

    Ok((
        Settings {
            shell,
            font,
            accent_color,
            content_text_color,
            code_colors,
            ui_scale,
            agent_glow,
            border_lights,
            scrim,
            backdrop,
            scrollback,
            terminal,
            dashboard,
            restore,
            editor,
            git,
            local_models,
            ship,
            local_browser,
            keybindings,
        },
        w,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_object_is_defaults() {
        let (s, w) = parse_settings("{}");
        assert_eq!(s, Settings::default());
        assert!(w.is_empty());
    }

    #[test]
    fn accent_color_needs_bright_six_digit_hex() {
        let (s, w) = parse_settings(r##"{ "accentColor": "#A68BFF" }"##);
        assert_eq!(s.accent_color, "#a68bff");
        assert!(w.is_empty());
        for bad in [r##""#1a2b4c""##, r##""#fff""##, r##""teal""##, "12"] {
            let (s, w) = parse_settings(&format!(r#"{{ "accentColor": {bad} }}"#));
            assert_eq!(s.accent_color, DEFAULT_ACCENT, "{bad}");
            assert_eq!(w, vec!["accentColor: invalid value, using default"], "{bad}");
        }
    }

    #[test]
    fn agent_glow_and_border_lights_are_separate_opt_ins() {
        let (s, w) = parse_settings("{}");
        assert!(!s.agent_glow && !s.border_lights);
        assert!(w.is_empty());
        let (s, _) = parse_settings(r#"{ "borderLights": true }"#);
        assert!(s.border_lights && !s.agent_glow);
        let (s, _) = parse_settings(r#"{ "agentGlow": true }"#);
        assert!(s.agent_glow && !s.border_lights);
        let (s, w) = parse_settings(r#"{ "agentGlow": "yes", "borderLights": 1 }"#);
        assert!(!s.agent_glow && !s.border_lights);
        assert_eq!(w, vec!["agentGlow: invalid value, using default", "borderLights: invalid value, using default"]);
    }

    #[test]
    fn ui_scale_stays_in_range() {
        let (s, w) = parse_settings(r#"{ "uiScale": 1.25 }"#);
        assert_eq!(s.ui_scale, 1.25);
        assert!(w.is_empty());
        for bad in ["0.9", "2.1", r#""big""#] {
            let (s, w) = parse_settings(&format!(r#"{{ "uiScale": {bad} }}"#));
            assert_eq!(s.ui_scale, UI_SCALE_MIN, "{bad}");
            assert_eq!(w, vec!["uiScale: invalid value, using default"], "{bad}");
        }
    }

    #[test]
    fn content_text_color_takes_a_mode_or_maps_a_hex() {
        for (given, mode) in [
            (r#""white""#, "white"),
            (r#""accent""#, "accent"),
            (r##""#E6E6E6""##, "white"),
            (r##""#b9d0ed""##, "accent"),
        ] {
            let (s, w) = parse_settings(&format!(r#"{{ "contentTextColor": {given} }}"#));
            assert_eq!(s.content_text_color, mode, "{given}");
            assert!(w.is_empty(), "{given}");
        }
        for bad in [r##""#eee""##, r#""teal""#, "12"] {
            let (s, w) = parse_settings(&format!(r#"{{ "contentTextColor": {bad} }}"#));
            assert_eq!(s.content_text_color, DEFAULT_CONTENT_TEXT_MODE, "{bad}");
            assert_eq!(w, vec!["contentTextColor: invalid value, using default"], "{bad}");
        }
    }

    #[test]
    fn code_colors_scheme_takes_a_known_id() {
        for id in CODE_SCHEMES {
            let (s, w) = parse_settings(&format!(r#"{{ "codeColors": {{ "scheme": "{id}" }} }}"#));
            assert_eq!(s.code_colors.scheme, id);
            assert!(w.is_empty(), "{id}");
        }
        let (s, w) = parse_settings("{}");
        assert_eq!(s.code_colors.scheme, DEFAULT_CODE_SCHEME);
        assert!(w.is_empty());
    }

    #[test]
    fn code_colors_scheme_falls_back_with_warning() {
        for bad in [r#""solarized""#, r#""Nord""#, r#""""#, "12"] {
            let (s, w) = parse_settings(&format!(r#"{{ "codeColors": {{ "scheme": {bad} }} }}"#));
            assert_eq!(s.code_colors.scheme, DEFAULT_CODE_SCHEME, "{bad}");
            assert_eq!(w, vec!["codeColors.scheme: invalid value, using default"], "{bad}");
        }
    }

    #[test]
    fn partial_file_keeps_other_defaults() {
        let (s, w) = parse_settings(r#"{ "font": { "size": 18 }, "scrollback": 500 }"#);
        assert_eq!(s.font.size, 18.0);
        assert_eq!(s.scrollback, 500);
        assert_eq!(s.font.family, Settings::default().font.family);
        assert_eq!(s.scrim, Settings::default().scrim);
        assert!(w.is_empty());
    }

    #[test]
    fn invalid_values_fall_back_with_warning() {
        let (s, w) = parse_settings(
            r#"{ "font": { "size": 0 }, "scrim": { "opacity": 2 }, "scrollback": -1, "shell": { "args": [1] } }"#,
        );
        let d = Settings::default();
        assert_eq!(s.font.size, d.font.size);
        assert_eq!(s.scrim.opacity, d.scrim.opacity);
        assert_eq!(s.scrollback, d.scrollback);
        assert_eq!(s.shell.args, d.shell.args);
        for field in ["font.size", "scrim.opacity", "scrollback", "shell.args"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn backdrop_values_parse_and_out_of_range_fps_falls_back() {
        let (s, w) = parse_settings(r#"{ "backdrop": { "animate": true, "maxFps": 0 } }"#);
        assert_eq!(s.backdrop, Backdrop { animate: true, max_fps: 0, ..Settings::default().backdrop });
        assert!(w.is_empty());
        for bad in ["10", "241", "-1", "30.5", "\"60\""] {
            let (s, w) = parse_settings(&format!(r#"{{ "backdrop": {{ "maxFps": {bad} }} }}"#));
            assert_eq!(s.backdrop.max_fps, Settings::default().backdrop.max_fps, "{bad}");
            assert!(w.iter().any(|m| m.starts_with("backdrop.maxFps")), "{bad}: {w:?}");
        }
    }

    #[test]
    fn backdrop_image_values_parse_and_invalid_ones_fall_back() {
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "style": "slideshow", "image": { "file": "%USERPROFILE%/a.png", "folder": "D:/pics", "fit": "tile", "intervalSeconds": 60, "crossfadeSeconds": 0, "shuffle": false, "includeSubfolders": true } } }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.backdrop.style, "slideshow");
        assert_eq!(
            s.backdrop.image,
            ImageBackdrop {
                file: "%USERPROFILE%/a.png".into(),
                folder: "D:/pics".into(),
                fit: "tile".into(),
                interval_seconds: 60,
                crossfade_seconds: 0.0,
                shuffle: false,
                include_subfolders: true,
            }
        );
        for (key, bad) in [("fit", r#""span""#), ("intervalSeconds", "4"), ("intervalSeconds", "86401"), ("crossfadeSeconds", "10.5"), ("crossfadeSeconds", "-1"), ("shuffle", "1")] {
            let (s, w) = parse_settings(&format!(r#"{{ "backdrop": {{ "image": {{ "{key}": {bad} }} }} }}"#));
            assert_eq!(s.backdrop.image, Settings::default().backdrop.image, "{key}: {bad}");
            assert!(w.iter().any(|m| m.starts_with(&format!("backdrop.image.{key}"))), "{key}: {w:?}");
        }
    }

    #[test]
    fn backdrop_wave_values_parse_and_invalid_ones_fall_back() {
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "style": "wave", "wave": { "color": "spectrum", "size": 0.6, "speed": 1.5, "lineWidth": 5, "echoes": 0 } } }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.backdrop.style, "wave");
        assert_eq!(
            s.backdrop.wave,
            WaveBackdrop { color: "spectrum".into(), size: 0.6, speed: 1.5, line_width: 5.0, echoes: 0 }
        );
        for (key, bad) in [
            ("color", r#""green""#),
            ("size", "0.2"),
            ("size", "2.1"),
            ("speed", "0"),
            ("speed", "3.5"),
            ("lineWidth", "0.5"),
            ("lineWidth", "9"),
            ("echoes", "16"),
            ("echoes", "2.5"),
            ("echoes", "\"4\""),
        ] {
            let (s, w) = parse_settings(&format!(r#"{{ "backdrop": {{ "wave": {{ "{key}": {bad} }} }} }}"#));
            assert_eq!(s.backdrop.wave, Settings::default().backdrop.wave, "{key}: {bad}");
            assert!(w.iter().any(|m| m.starts_with(&format!("backdrop.wave.{key}"))), "{key}: {w:?}");
        }
    }

    #[test]
    fn legacy_lissajous_style_and_block_load_as_wave() {
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "style": "lissajous", "lissajous": { "color": "white", "size": 1.4, "echoes": 9 } } }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.backdrop.style, "wave");
        let d = Settings::default().backdrop.wave;
        assert_eq!(s.backdrop.wave, WaveBackdrop { color: "white".into(), size: 1.4, echoes: 9, ..d.clone() });

        // A wave field the file also sets wins over its lissajous twin; the rest still carry over.
        let (s, _) = parse_settings(r#"{ "backdrop": { "wave": { "size": 0.5 }, "lissajous": { "size": 1.4, "echoes": 9 } } }"#);
        assert_eq!(s.backdrop.wave, WaveBackdrop { size: 0.5, echoes: 9, ..d });
    }

    #[test]
    fn backdrop_style_and_matrix_values_parse_and_invalid_ones_fall_back() {
        let d = Settings::default().backdrop;
        let (s, w) = parse_settings(r#"{ "backdrop": { "animate": true } }"#);
        assert_eq!(s.backdrop.style, "lights");
        assert!(w.is_empty(), "{w:?}");

        let (s, w) = parse_settings(r#"{ "backdrop": { "style": "galaxy" } }"#);
        assert_eq!(s.backdrop.style, "galaxy");
        assert!(w.is_empty(), "{w:?}");

        let (s, w) = parse_settings(
            r#"{ "backdrop": { "style": "matrix", "matrix": { "color": "accent", "zoom": 2.5, "speed": 25, "density": 2.5 } } }"#,
        );
        assert_eq!(s.backdrop.style, "matrix");
        assert_eq!(s.backdrop.matrix, MatrixBackdrop { color: "accent".into(), zoom: 2.5, speed: 25, density: 2.5 });
        assert!(w.is_empty(), "{w:?}");
        for (given, mode) in [(r##""#00FF41""##, "green"), (r##""#a68bff""##, "accent"), (r#""green""#, "green")] {
            let (s, w) = parse_settings(&format!(r#"{{ "backdrop": {{ "matrix": {{ "color": {given} }} }} }}"#));
            assert_eq!(s.backdrop.matrix.color, mode, "{given}");
            assert!(w.is_empty(), "{given}");
        }
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(r#"{ "backdrop": { "style": "none" } }"#);
        assert_eq!(s.backdrop.style, "none");
        assert!(w.is_empty(), "{w:?}");

        for (path, key, bad) in [
            ("backdrop.style", "style", r#""rain""#),
            ("backdrop.style", "style", "1"),
            ("backdrop.matrix.color", "color", r##""#0f0""##),
            ("backdrop.matrix.color", "color", r#""amber""#),
            ("backdrop.matrix.zoom", "zoom", "0.4"),
            ("backdrop.matrix.zoom", "zoom", "3.1"),
            ("backdrop.matrix.speed", "speed", "4"),
            ("backdrop.matrix.speed", "speed", "31"),
            ("backdrop.matrix.speed", "speed", "12.5"),
            ("backdrop.matrix.speed", "speed", "\"20\""),
            ("backdrop.matrix.density", "density", "0.2"),
            ("backdrop.matrix.density", "density", "4.5"),
            ("backdrop.matrix.density", "density", "\"1\""),
        ] {
            let json = if key == "style" {
                format!(r#"{{ "backdrop": {{ "style": {bad} }} }}"#)
            } else {
                format!(r#"{{ "backdrop": {{ "matrix": {{ "{key}": {bad} }} }} }}"#)
            };
            let (s, w) = parse_settings(&json);
            assert_eq!(s.backdrop, d, "{json}");
            assert_eq!(w, vec![format!("{path}: invalid value, using default")], "{json}");
        }
    }

    #[test]
    fn simulation_values_parse_and_out_of_range_ones_fall_back() {
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "capacity": 800, "mutationRate": 1.5, "zoom": 2.5 } }"#,
        );
        assert_eq!((s.backdrop.capacity, s.backdrop.mutation_rate, s.backdrop.zoom), (800, 1.5, 2.5));
        assert!(w.is_empty(), "{w:?}");
        let (s, w) = parse_settings(
            r#"{ "backdrop": { "capacity": 5001, "mutationRate": -1, "zoom": 4 } }"#,
        );
        let d = Settings::default().backdrop;
        assert_eq!((s.backdrop.capacity, s.backdrop.mutation_rate), (d.capacity, d.mutation_rate));
        assert_eq!(s.backdrop.zoom, d.zoom);
        for field in ["backdrop.capacity", "backdrop.mutationRate", "backdrop.zoom"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn restore_values_parse_and_invalid_ones_fall_back() {
        let (s, w) = parse_settings(r#"{ "restore": { "enabled": false, "resumeSessions": false, "scrollback": false } }"#);
        assert_eq!(s.restore, Restore { enabled: false, resume_sessions: false, scrollback: false });
        assert!(w.is_empty());
        let (s, w) = parse_settings(r#"{ "restore": { "enabled": "no", "resumeSessions": 0, "scrollback": [] } }"#);
        assert_eq!(s.restore, Settings::default().restore);
        for field in ["restore.enabled", "restore.resumeSessions", "restore.scrollback"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn restore_reads_the_older_resume_claude_key_when_resume_sessions_is_absent() {
        let (s, w) = parse_settings(r#"{ "restore": { "resumeClaude": false } }"#);
        assert!(!s.restore.resume_sessions);
        assert!(w.is_empty());
        let (s, _) = parse_settings(r#"{ "restore": { "resumeClaude": false, "resumeSessions": true } }"#);
        assert!(s.restore.resume_sessions);
    }

    #[test]
    fn local_models_defaults_parse_and_invalid_values_fall_back() {
        let d = Settings::default().local_models;
        assert_eq!((d.ollama_url.as_str(), d.lm_studio_url.as_str(), d.min_context), ("", "", 64000));
        let (s, w) = parse_settings(r#"{ "localModels": { "ollamaUrl": "http://box:11434", "lmStudioUrl": "http://box:1234", "minContext": 0 } }"#);
        assert_eq!(s.local_models, LocalModels { ollama_url: "http://box:11434".into(), lm_studio_url: "http://box:1234".into(), min_context: 0 });
        assert!(w.is_empty());
        let (s, w) = parse_settings(r#"{ "localModels": { "ollamaUrl": 1, "lmStudioUrl": [], "minContext": -5 } }"#);
        assert_eq!(s.local_models, d);
        for field in ["localModels.ollamaUrl", "localModels.lmStudioUrl", "localModels.minContext"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn legacy_containers_enabled_seeds_the_containers_section() {
        let (s, w) = parse_settings(r#"{ "containers": { "enabled": false } }"#);
        assert!(!s.dashboard.sections.containers);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn dashboard_sections_containers_wins_over_legacy_key() {
        let (s, w) = parse_settings(
            r#"{ "containers": { "enabled": false }, "dashboard": { "sections": { "containers": true } } }"#,
        );
        assert!(s.dashboard.sections.containers);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn invalid_legacy_containers_enabled_is_ignored_silently() {
        let (s, w) = parse_settings(r#"{ "containers": { "enabled": "no" } }"#);
        assert!(s.dashboard.sections.containers);
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn dashboard_side_parses_and_invalid_values_fall_back() {
        for side in ["left", "right"] {
            let (s, w) = parse_settings(&format!(r#"{{ "dashboard": {{ "side": "{side}" }} }}"#));
            assert_eq!(s.dashboard.side, side);
            assert!(w.is_empty(), "{w:?}");
        }
        for bad in [r#""top""#, "3"] {
            let (s, w) = parse_settings(&format!(r#"{{ "dashboard": {{ "side": {bad} }} }}"#));
            assert_eq!(s.dashboard.side, "right");
            assert!(w.iter().any(|m| m.starts_with("dashboard.side")), "missing warning: {w:?}");
        }
    }

    #[test]
    fn dashboard_sections_defaults_and_partial_parse() {
        let d = Settings::default().dashboard;
        assert_eq!(d.side, "right");
        assert_eq!(
            d.sections,
            DashboardSections {
                launch: true,
                favorites: false,
                layouts: false,
                panes: true,
                containers: true,
                ports: true,
                ship: true,
                local_models: true,
                external: true,
                system: false,
                wave: false,
                clock: false
            }
        );
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "clock": true, "panes": false } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert!(s.dashboard.sections.clock && !s.dashboard.sections.panes);
        assert!(!s.dashboard.sections.favorites && s.dashboard.sections.external);
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "launch": false } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert!(!s.dashboard.sections.launch && s.dashboard.sections.panes);
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "folder": false } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert!(!s.dashboard.sections.launch);
        let (s, _) = parse_settings(r#"{ "dashboard": { "sections": { "folder": false, "launch": true } } }"#);
        assert!(s.dashboard.sections.launch);
    }

    #[test]
    fn dashboard_clock_style_parse() {
        assert_eq!(Settings::default().dashboard.clock_style, "both");
        let (s, w) = parse_settings(r#"{ "dashboard": { "clockStyle": "binary" } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.dashboard.clock_style, "binary");
        let (s, w) = parse_settings(r#"{ "dashboard": { "clockStyle": "analog" } }"#);
        assert_eq!(s.dashboard.clock_style, "both");
        assert!(w.iter().any(|m| m.starts_with("dashboard.clockStyle")), "missing warning: {w:?}");
    }

    #[test]
    fn dashboard_sections_system_parse() {
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "system": true } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert!(s.dashboard.sections.system);
        assert!(!s.dashboard.sections.clock);
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "system": "yes" } } }"#);
        assert!(!s.dashboard.sections.system);
        assert!(w.iter().any(|m| m.starts_with("dashboard.sections.system")), "missing warning: {w:?}");
    }

    #[test]
    fn invalid_dashboard_section_value_falls_back_with_warning() {
        let (s, w) = parse_settings(r#"{ "dashboard": { "sections": { "layouts": "yes" } } }"#);
        assert!(!s.dashboard.sections.layouts);
        assert!(w.iter().any(|m| m.starts_with("dashboard.sections.layouts")), "missing warning: {w:?}");
    }

    #[test]
    fn ship_hosts_parse_a_valid_map() {
        let (s, w) = parse_settings(
            r#"{ "ship": { "hosts": { "ghe.example.com": "github", "git.example.com": "gitlab", "bb.example.com": "bitbucket", "ado.example.com": "azureDevOps" } } }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        let hosts = s.forge_hosts();
        assert_eq!(hosts.len(), 4);
        assert_eq!(hosts["ghe.example.com"], "github");
        assert_eq!(hosts["git.example.com"], "gitlab");
        assert_eq!(hosts["bb.example.com"], "bitbucket");
        assert_eq!(hosts["ado.example.com"], "azureDevOps");
    }

    #[test]
    fn ship_hosts_drop_an_unknown_kind_with_a_warning_and_keep_the_rest() {
        let (s, w) = parse_settings(
            r#"{ "ship": { "hosts": { "ghe.example.com": "github", "odd.example.com": "gitea", "num.example.com": 3 } } }"#,
        );
        assert_eq!(s.forge_hosts().len(), 1);
        assert_eq!(s.forge_hosts()["ghe.example.com"], "github");
        assert_eq!(w.len(), 2, "{w:?}");
        assert!(w.iter().any(|m| m.starts_with("ship.hosts.odd.example.com")), "{w:?}");
        assert!(w.iter().any(|m| m.starts_with("ship.hosts.num.example.com")), "{w:?}");
    }

    #[test]
    fn ship_hosts_lowercase_keys_and_reject_a_non_object() {
        let (s, w) = parse_settings(r#"{ "ship": { "hosts": { "GHE.Example.COM": "github" } } }"#);
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.ship.hosts.get("ghe.example.com").map(String::as_str), Some("github"));
        assert!(!s.ship.hosts.contains_key("GHE.Example.COM"));

        let (s, w) = parse_settings(r#"{ "ship": { "hosts": ["github.com"] } }"#);
        assert!(s.ship.hosts.is_empty());
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].starts_with("ship.hosts"), "{w:?}");
    }

    #[test]
    fn local_browser_bookmarks_parse_valid_entries() {
        let (s, w) = parse_settings(
            r#"{ "localBrowser": { "homeUrl": "http://localhost:3000/", "bookmarks": [
                { "name": "App", "url": "http://localhost:5173" },
                { "name": "Api", "url": "http://127.0.0.1:8080/health?x=1" }
            ] } }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.local_browser.home_url, "http://localhost:3000/");
        let urls: Vec<&str> = s.local_browser.bookmarks.iter().map(|b| b.url.as_str()).collect();
        assert_eq!(urls, ["http://localhost:5173", "http://127.0.0.1:8080/health?x=1"]);
    }

    #[test]
    fn local_browser_bookmarks_drop_bad_entries_with_their_index_and_keep_the_rest() {
        let (s, w) = parse_settings(
            r#"{ "localBrowser": { "bookmarks": [
                { "name": "ok", "url": "http://localhost:1" },
                { "name": "", "url": "http://localhost:2" },
                { "name": "no url" },
                { "name": "subdomain", "url": "https://a.localhost:3" },
                { "name": "remote", "url": "http://example.com/" },
                { "name": "userinfo", "url": "http://localhost@evil.test/" },
                { "name": "port", "url": "http://localhost:abc/" },
                7
            ] } }"#,
        );
        let names: Vec<&str> = s.local_browser.bookmarks.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, ["ok"]);
        for i in 1..=7 {
            assert!(w.iter().any(|m| m.starts_with(&format!("localBrowser.bookmarks[{i}]"))), "{i}: {w:?}");
        }
        let (s, w) = parse_settings(r#"{ "localBrowser": { "bookmarks": [{ "name": "api", "url": "https://localhost:7001/" }] } }"#);
        assert_eq!(s.local_browser.bookmarks.len(), 1, "{w:?}");
    }

    #[test]
    fn local_browser_bookmarks_reject_a_non_array() {
        let (s, w) = parse_settings(r#"{ "localBrowser": { "bookmarks": { "name": "a", "url": "http://localhost" } } }"#);
        assert!(s.local_browser.bookmarks.is_empty());
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].starts_with("localBrowser.bookmarks"), "{w:?}");
    }

    #[test]
    fn local_browser_home_url_must_be_empty_or_loopback() {
        let (s, w) = parse_settings(r#"{ "localBrowser": { "homeUrl": "http://example.com" } }"#);
        assert!(s.local_browser.home_url.is_empty());
        assert!(w.iter().any(|m| m.starts_with("localBrowser.homeUrl")), "{w:?}");
        let (s, _) = parse_settings(r#"{ "localBrowser": { "homeUrl": "https://localhost:7001/app" } }"#);
        assert_eq!(s.local_browser.home_url, "https://localhost:7001/app");
        let (s, _) = parse_settings(r#"{ "localBrowser": { "homeUrl": "http://localhost@evil.test/" } }"#);
        assert!(s.local_browser.home_url.is_empty());
    }

    #[test]
    fn ship_pinned_repos_parse_valid_entries() {
        let (s, w) = parse_settings(
            r#"{ "ship": { "overviewRefreshMinutes": 0, "pinnedRepos": [
                { "repo": "bitbucket.org/keysys/kweb", "root": "C:/src/kweb", "branches": ["uat", "prod"] },
                { "repo": "github.com/acme/tool" }
            ] } }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(s.ship.overview_refresh_minutes, 0);
        assert_eq!(
            s.ship.pinned_repos,
            vec![
                PinnedRepo {
                    repo: "bitbucket.org/keysys/kweb".into(),
                    root: Some("C:/src/kweb".into()),
                    branches: Some(vec!["uat".into(), "prod".into()]),
                },
                PinnedRepo { repo: "github.com/acme/tool".into(), root: None, branches: None },
            ]
        );
    }

    #[test]
    fn ship_pinned_repos_drop_bad_entries_with_their_index_and_keep_the_rest() {
        let (s, w) = parse_settings(
            r#"{ "ship": { "pinnedRepos": [
                { "repo": "github.com/a/b" },
                { "repo": "" },
                "github.com/c/d",
                { "repo": "github.com/e/f", "branches": ["uat", ""] },
                { "repo": "github.com/g/h", "root": 3 },
                { "repo": "github.com/i/j", "branches": "uat" },
                { "repo": "github.com/k/l", "root": "C:/k" }
            ] } }"#,
        );
        let repos: Vec<&str> = s.ship.pinned_repos.iter().map(|p| p.repo.as_str()).collect();
        assert_eq!(repos, ["github.com/a/b", "github.com/k/l"]);
        assert_eq!(w.len(), 5, "{w:?}");
        for i in [1, 2, 3, 4, 5] {
            assert!(w.iter().any(|m| m.starts_with(&format!("ship.pinnedRepos[{i}]"))), "{i}: {w:?}");
        }
    }

    #[test]
    fn ship_pinned_repos_reject_a_non_array() {
        let (s, w) = parse_settings(r#"{ "ship": { "pinnedRepos": { "repo": "github.com/a/b" } } }"#);
        assert!(s.ship.pinned_repos.is_empty());
        assert_eq!(w.len(), 1, "{w:?}");
        assert!(w[0].starts_with("ship.pinnedRepos"), "{w:?}");
    }

    #[test]
    fn ship_overview_refresh_minutes_parses_bounds_and_rejects_out_of_range() {
        for n in [0u32, 1, 1440] {
            let (s, w) = parse_settings(&format!(r#"{{ "ship": {{ "overviewRefreshMinutes": {n} }} }}"#));
            assert_eq!(s.ship.overview_refresh_minutes, n);
            assert!(w.is_empty(), "{w:?}");
        }
        for bad in ["-1", "1.5", "\"5\"", "1441"] {
            let (s, w) = parse_settings(&format!(r#"{{ "ship": {{ "overviewRefreshMinutes": {bad} }} }}"#));
            assert_eq!(s.ship.overview_refresh_minutes, 5, "{bad}");
            assert_eq!(w.len(), 1, "{bad}: {w:?}");
            assert!(w[0].starts_with("ship.overviewRefreshMinutes"), "{bad}: {w:?}");
        }
    }

    #[test]
    fn git_auto_fetch_minutes_parses_bounds() {
        for n in [0u32, 30, 1440] {
            let (s, w) = parse_settings(&format!(r#"{{ "git": {{ "autoFetchMinutes": {n} }} }}"#));
            assert_eq!(s.git.auto_fetch_minutes, n);
            assert!(w.is_empty(), "{w:?}");
        }
    }

    #[test]
    fn git_auto_fetch_minutes_rejects_invalid_values() {
        for bad in ["-1", "1.5", "\"5\"", "1441"] {
            let (s, w) = parse_settings(&format!(r#"{{ "git": {{ "autoFetchMinutes": {bad} }} }}"#));
            assert_eq!(s.git.auto_fetch_minutes, 5, "{bad}");
            assert_eq!(w.len(), 1, "{bad}: {w:?}");
            assert!(w[0].starts_with("git.autoFetchMinutes"), "{bad}: {w:?}");
        }
    }

    #[test]
    fn editor_values_parse() {
        assert_eq!(Settings::default().editor, Editor { preferred: "default".into(), command: String::new() });
        for id in EDITOR_IDS {
            let (s, w) = parse_settings(&format!(r#"{{ "editor": {{ "preferred": "{id}" }} }}"#));
            assert_eq!(s.editor.preferred, id);
            assert!(w.is_empty(), "{id}: {w:?}");
        }
        let (s, w) = parse_settings(r#"{ "editor": { "command": "code -g \"{path}:{line}\"" } }"#);
        assert_eq!(s.editor.command, "code -g \"{path}:{line}\"");
        assert!(w.is_empty(), "{w:?}");
    }

    #[test]
    fn invalid_editor_values_fall_back_with_warning() {
        let (s, w) = parse_settings(r#"{ "editor": { "preferred": "emacs", "command": 5 } }"#);
        assert_eq!(s.editor, Settings::default().editor);
        for field in ["editor.preferred", "editor.command"] {
            assert!(w.iter().any(|m| m.starts_with(field)), "missing warning for {field}: {w:?}");
        }
    }

    #[test]
    fn default_profile_parses_and_unknown_one_falls_back() {
        assert_eq!(Settings::default().shell.default_profile, "gitBash");
        let (s, w) = parse_settings(r#"{ "shell": { "defaultProfile": "pwsh" } }"#);
        assert_eq!(s.shell.default_profile, "pwsh");
        assert!(w.is_empty(), "{w:?}");
        for bad in ["\"zsh\"", "\"PWSH\"", "1"] {
            let (s, w) = parse_settings(&format!(r#"{{ "shell": {{ "defaultProfile": {bad} }} }}"#));
            assert_eq!(s.shell.default_profile, "gitBash", "{bad}");
            assert!(w.iter().any(|m| m.starts_with("shell.defaultProfile")), "{bad}: {w:?}");
        }
    }

    #[test]
    fn terminal_done_after_seconds_defaults_to_30() {
        assert_eq!(Settings::default().terminal, Terminal { done_after_seconds: 30, notify_when_waiting: true });
        let (s, w) = parse_settings("{}");
        assert_eq!(s.terminal.done_after_seconds, 30);
        assert!(w.is_empty());
    }

    #[test]
    fn terminal_done_after_seconds_accepts_valid_values() {
        for n in [0u32, 120] {
            let (s, w) = parse_settings(&format!(r#"{{ "terminal": {{ "doneAfterSeconds": {n} }} }}"#));
            assert_eq!(s.terminal.done_after_seconds, n);
            assert!(w.is_empty());
        }
    }

    #[test]
    fn terminal_done_after_seconds_rejects_invalid_values() {
        for bad in ["-1", "1.5", r#""x""#, "100000"] {
            let (s, w) = parse_settings(&format!(r#"{{ "terminal": {{ "doneAfterSeconds": {bad} }} }}"#));
            assert_eq!(s.terminal.done_after_seconds, 30, "{bad}");
            assert_eq!(w.len(), 1, "{bad}");
            assert!(w[0].starts_with("terminal.doneAfterSeconds"), "{bad}");
        }
    }

    #[test]
    fn terminal_notify_when_waiting_parses_and_falls_back() {
        let (s, w) = parse_settings(r#"{ "terminal": { "notifyWhenWaiting": false } }"#);
        assert!(!s.terminal.notify_when_waiting);
        assert!(w.is_empty());
        let (s, w) = parse_settings(r#"{ "terminal": { "notifyWhenWaiting": "no" } }"#);
        assert!(s.terminal.notify_when_waiting);
        assert!(w.len() == 1 && w[0].starts_with("terminal.notifyWhenWaiting"), "{w:?}");
    }

    #[test]
    fn unknown_keys_ignored() {
        let (s, w) = parse_settings(r#"{ "bogus": 1, "font": { "weight": "bold" } }"#);
        assert_eq!(s, Settings::default());
        assert!(w.is_empty());
    }

    #[test]
    fn comments_accepted() {
        let (s, w) = parse_settings("// top\n{ /* c */ \"scrollback\": 7 // tail\n}");
        assert_eq!(s.scrollback, 7);
        assert!(w.is_empty());
    }

    #[test]
    fn malformed_json_gives_defaults_and_warning() {
        let (s, w) = parse_settings("{ nope");
        assert_eq!(s, Settings::default());
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn expands_env_vars() {
        let var = if std::env::var("USERPROFILE").is_ok() { "USERPROFILE" } else { "HOME" };
        let val = std::env::var(var).unwrap();
        assert_eq!(expand_env(&format!("%{var}%")), val);
        assert_eq!(expand_env(&format!("a/%{var}%/b")), format!("a/{val}/b"));
        assert_eq!(expand_env("%NOPE_NOT_SET_XYZ%"), "%NOPE_NOT_SET_XYZ%");
        assert_eq!(expand_env("50% done"), "50% done");
    }
}
