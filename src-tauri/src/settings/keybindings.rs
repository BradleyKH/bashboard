//! Built-in keybindings, chord normalization, the user's entries layered over the defaults, and
//! edits to the file's raw `keybindings` array.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::model::Keybinding;
use super::parse::parse_root;

/// The front end imports the same file as `DEFAULT_KEYBINDINGS`, so the two cannot drift.
const DEFAULT_KEYBINDINGS_JSON: &str = include_str!("../../../src/defaultKeybindings.json");

pub fn default_keybindings() -> Vec<Keybinding> {
    serde_json::from_str(DEFAULT_KEYBINDINGS_JSON).expect("src/defaultKeybindings.json parses as keybindings")
}

/// Same aliases as `parseChord` in `src/keymap.ts`, so the file and the front end agree on
/// which entry a chord is.
fn chord_alias(part: String) -> String {
    match part.as_str() {
        "win" => "meta".into(),
        "esc" => "escape".into(),
        "del" => "delete".into(),
        "ins" => "insert".into(),
        _ => part,
    }
}

/// Modifier order, case, and aliases do not matter: `shift+Ctrl+V` equals `ctrl+shift+v`.
pub(crate) fn normalize_chord(keys: &str) -> String {
    // A trailing "+" is the plus key itself ("ctrl++").
    let (mods, plus) = match keys.trim().strip_suffix('+') {
        Some(rest) if rest.is_empty() || rest.ends_with('+') => (rest.trim_end_matches('+'), true),
        _ => (keys, false),
    };
    let mut parts: Vec<String> = mods.split('+').map(|p| chord_alias(p.trim().to_lowercase())).collect();
    let key = if plus { "+".to_string() } else { parts.pop().unwrap_or_default() };
    if plus && parts.last().is_some_and(|p| p.is_empty()) {
        parts.pop();
    }
    parts.sort();
    parts.push(key);
    parts.join("+")
}

pub(super) fn parse_keybindings(root: &Value, warnings: &mut Vec<String>) -> Vec<Keybinding> {
    let mut merged = default_keybindings();
    let Some(v) = root.get("keybindings") else {
        return merged;
    };
    let Some(entries) = v.as_array() else {
        warnings.push("keybindings: invalid value, using defaults".into());
        return merged;
    };
    for (i, e) in entries.iter().enumerate() {
        let (Some(keys), Some(action)) = (
            e.get("keys").and_then(Value::as_str),
            e.get("action").and_then(Value::as_str),
        ) else {
            warnings.push(format!("keybindings[{i}]: needs string \"keys\" and \"action\", dropped"));
            continue;
        };
        let mut opt = |name: &str| match e.get(name) {
            None => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                warnings.push(format!("keybindings[{i}].{name}: invalid value, ignored"));
                None
            }
        };
        let direction = opt("direction");
        let input = opt("input");
        let index = match e.get("index") {
            None => None,
            Some(v) => match v.as_u64().and_then(|n| u32::try_from(n).ok()) {
                Some(n) => Some(n),
                None => {
                    warnings.push(format!("keybindings[{i}].index: invalid value, ignored"));
                    None
                }
            },
        };
        let entry = Keybinding { keys: keys.into(), action: action.into(), direction, input, index };
        let chord = normalize_chord(keys);
        merged.retain(|d| normalize_chord(&d.keys) != chord);
        if action != "unbound" {
            merged.push(entry);
        }
    }
    merged
}

/// One edit to the raw `keybindings` array (docs/design/keys.md section 4.5).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum KeybindingOp {
    #[serde(rename_all = "camelCase")]
    Bind {
        keys: String,
        action: String,
        #[serde(default)]
        direction: Option<String>,
        #[serde(default)]
        index: Option<u32>,
        #[serde(default)]
        input: Option<String>,
    },
    Unbind { keys: String },
    Reset { keys: String },
    ResetAll,
    /// Writes the raw array back as given, rejected entries included, so Undo after Reset all
    /// restores what the loader ignored as well as the keymap.
    ReplaceAll { entries: Vec<Value> },
}

/// The file's `keybindings` array as written, rejected entries included. Errs when the array
/// itself is unusable, so an edit never overwrites a value the loader ignored as a whole.
fn raw_keybindings(text: &str) -> Result<Vec<Value>, String> {
    let fix = "; fix it in settings.json before changing keys";
    let root = parse_root(text).map_err(|e| format!("{e}{fix}"))?;
    match root.get("keybindings") {
        None => Ok(Vec::new()),
        Some(Value::Array(a)) => Ok(a.clone()),
        Some(_) => Err(format!("\"keybindings\" in settings.json is not a list{fix}")),
    }
}

/// Applies `ops` in order to the raw array. Entries that are not for a touched chord, including
/// entries the loader rejects, keep their place.
fn apply_keybinding_ops(mut entries: Vec<Value>, ops: &[KeybindingOp]) -> Vec<Value> {
    let defaults = default_keybindings();
    let default_for = |chord: &str| defaults.iter().find(|d| normalize_chord(&d.keys) == chord);
    for op in ops {
        let keys = match op {
            KeybindingOp::ResetAll => {
                entries.clear();
                continue;
            }
            KeybindingOp::ReplaceAll { entries: all } => {
                entries = all.clone();
                continue;
            }
            KeybindingOp::Bind { keys, .. }
            | KeybindingOp::Unbind { keys }
            | KeybindingOp::Reset { keys } => keys,
        };
        let chord = normalize_chord(keys);
        entries.retain(|e| e.get("keys").and_then(Value::as_str).is_none_or(|k| normalize_chord(k) != chord));
        match op {
            KeybindingOp::Bind { action, direction, index, input, .. } => {
                let is_default = default_for(&chord).is_some_and(|d| {
                    &d.action == action && &d.direction == direction && &d.index == index && &d.input == input
                });
                if !is_default {
                    let mut e = serde_json::Map::new();
                    e.insert("keys".into(), keys.clone().into());
                    e.insert("action".into(), action.clone().into());
                    if let Some(d) = direction {
                        e.insert("direction".into(), d.clone().into());
                    }
                    if let Some(i) = index {
                        e.insert("index".into(), (*i).into());
                    }
                    if let Some(s) = input {
                        e.insert("input".into(), s.clone().into());
                    }
                    entries.push(Value::Object(e));
                }
            }
            KeybindingOp::Unbind { .. } => {
                if default_for(&chord).is_some() {
                    entries.push(serde_json::json!({ "keys": keys, "action": "unbound" }));
                }
            }
            KeybindingOp::Reset { .. } | KeybindingOp::ResetAll | KeybindingOp::ReplaceAll { .. } => {}
        }
    }
    entries
}

/// The file text with `ops` applied to its raw `keybindings` array, and that array as it was.
pub(super) fn edit_keybindings_text(text: &str, ops: &[KeybindingOp]) -> Result<(String, Vec<Value>), String> {
    let previous = raw_keybindings(text)?;
    let next = apply_keybinding_ops(previous.clone(), ops);
    Ok((crate::settings_edit::set_array_lines(text, &["keybindings".into()], &next)?, previous))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::model::Settings;
    use crate::settings::parse::parse_settings;
    use crate::settings::file::default_file_text;

    fn find<'a>(s: &'a Settings, keys: &str) -> Option<&'a Keybinding> {
        s.keybindings.iter().find(|k| k.keys == keys)
    }

    #[test]
    fn collapse_and_favorite_chords_are_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+m").map(|k| k.action.as_str()), Some("collapsePane"));
        assert_eq!(find(&s, "ctrl+shift+o").map(|k| k.action.as_str()), Some("openFavorite"));
    }

    #[test]
    fn zoom_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+z").map(|k| k.action.as_str()), Some("togglePaneZoom"));
    }

    #[test]
    fn layout_and_profile_chords_are_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+r").map(|k| k.action.as_str()), Some("openLayout"));
        assert_eq!(find(&s, "ctrl+shift+l").map(|k| k.action.as_str()), Some("openLaunch"));
        assert_eq!(find(&s, "ctrl+shift+p").map(|k| k.action.as_str()), Some("openPalette"));
        assert_eq!(find(&s, "alt+shift+t").map(|k| k.action.as_str()), Some("splitWithProfile"));
        assert_eq!(find(&s, "ctrl+shift+t").map(|k| k.action.as_str()), Some("newTab"));
        assert_eq!(find(&s, "ctrl+shift+s").map(|k| k.action.as_str()), Some("newScratch"));
    }

    #[test]
    fn open_files_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+e").map(|k| k.action.as_str()), Some("openFiles"));
    }

    #[test]
    fn open_git_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+g").map(|k| k.action.as_str()), Some("openGit"));
    }

    #[test]
    fn open_search_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+h").map(|k| k.action.as_str()), Some("openSearch"));
    }

    #[test]
    fn open_editor_chord_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+x").map(|k| k.action.as_str()), Some("openEditor"));
    }

    #[test]
    fn tab_and_font_chords_are_bound_by_default() {
        let s = Settings::default();
        let action = |k: &str| find(&s, k).map(|b| b.action.as_str());
        assert_eq!(action("ctrl+="), Some("increaseFontSize"));
        assert_eq!(action("ctrl++"), Some("increaseFontSize"));
        assert_eq!(action("ctrl+0"), Some("resetFontSize"));
        assert_eq!(action("ctrl+alt+9"), Some("switchToLastTab"));
        assert_eq!(find(&s, "ctrl+alt+3").and_then(|b| b.index), Some(3));
    }

    #[test]
    fn keybinding_index_is_accepted_when_a_whole_number() {
        let (s, w) = parse_settings(
            r#"{ "keybindings": [ { "keys": "alt+1", "action": "switchToTab", "index": 2 } ] }"#,
        );
        assert!(w.is_empty(), "{w:?}");
        assert_eq!(find(&s, "alt+1").and_then(|b| b.index), Some(2));
        for bad in ["\"2\"", "-1", "1.5"] {
            let (s, w) = parse_settings(&format!(
                r#"{{ "keybindings": [ {{ "keys": "alt+1", "action": "switchToTab", "index": {bad} }} ] }}"#
            ));
            assert_eq!(find(&s, "alt+1").and_then(|b| b.index), None, "{bad}");
            assert!(w.iter().any(|m| m.contains("index")), "{bad}: {w:?}");
        }
    }

    #[test]
    fn help_is_bound_to_f1_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "f1").map(|k| k.action.as_str()), Some("showHelp"));
    }

    #[test]
    fn focus_dashboard_is_bound_to_f6_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "f6").map(|k| k.action.as_str()), Some("focusDashboard"));
    }

    #[test]
    fn settings_is_bound_to_ctrl_comma_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+,").map(|k| k.action.as_str()), Some("openSettings"));
    }

    #[test]
    fn backdrop_toggle_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+a").map(|k| k.action.as_str()), Some("toggleBackdrop"));
    }

    #[test]
    fn next_attention_is_bound_by_default() {
        let s = Settings::default();
        assert_eq!(find(&s, "ctrl+shift+n").map(|k| k.action.as_str()), Some("nextAttention"));
    }

    #[test]
    fn bad_keybinding_entry_dropped() {
        let (s, w) = parse_settings(
            r#"{ "keybindings": [ { "keys": "ctrl+k" }, { "keys": "ctrl+j", "action": "find" } ] }"#,
        );
        assert!(find(&s, "ctrl+k").is_none());
        assert!(find(&s, "ctrl+j").is_some());
        assert_eq!(w.len(), 1);
        assert!(w[0].starts_with("keybindings[0]"));
    }

    #[test]
    fn user_entry_overrides_default_chord() {
        let (s, _) =
            parse_settings(r#"{ "keybindings": [ { "keys": "ctrl+shift+right", "action": "splitAuto" } ] }"#);
        let all: Vec<_> = s.keybindings.iter().filter(|k| k.keys == "ctrl+shift+right").collect();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].action, "splitAuto");
        assert_eq!(s.keybindings.len(), default_keybindings().len());
    }

    #[test]
    fn override_ignores_modifier_order_and_case() {
        let (s, _) = parse_settings(
            r#"{ "keybindings": [ { "keys": "shift+Ctrl+V", "action": "sendInput", "input": "x" } ] }"#,
        );
        assert!(find(&s, "ctrl+shift+v").is_none());
        let k = find(&s, "shift+Ctrl+V").unwrap();
        assert_eq!(k.action, "sendInput");
        assert_eq!(s.keybindings.len(), default_keybindings().len());
    }

    #[test]
    fn new_chord_is_added() {
        let (s, _) =
            parse_settings(r#"{ "keybindings": [ { "keys": "ctrl+shift+k", "action": "splitAuto" } ] }"#);
        assert_eq!(s.keybindings.len(), default_keybindings().len() + 1);
        assert!(find(&s, "ctrl+shift+k").is_some());
        assert!(find(&s, "ctrl+w").is_some());
    }

    #[test]
    fn unbound_removes_default() {
        let (s, w) =
            parse_settings(r#"{ "keybindings": [ { "keys": "Ctrl+W", "action": "unbound" } ] }"#);
        assert!(find(&s, "ctrl+w").is_none());
        assert!(s.keybindings.iter().all(|k| k.action != "unbound"));
        assert_eq!(s.keybindings.len(), default_keybindings().len() - 1);
        assert!(w.is_empty());
    }

    #[test]
    fn empty_keybindings_is_exactly_defaults() {
        let (s, _) = parse_settings(r#"{ "keybindings": [] }"#);
        assert_eq!(s.keybindings, default_keybindings());
    }

    // Pins the shipped defaults entry by entry, in order, since the front end receives this list
    // verbatim and an edit to the shared JSON file should be a deliberate change here too.
    #[test]
    fn default_keybindings_are_pinned() {
        let pinned: Vec<(&str, &str, Option<&str>, Option<&str>, Option<u32>)> = vec![
            ("ctrl+shift+right", "splitRight", None, None, None),
            ("ctrl+shift+down", "splitDown", None, None, None),
            ("ctrl+shift+left", "splitLeft", None, None, None),
            ("ctrl+shift+up", "splitUp", None, None, None),
            ("alt+shift+d", "splitAuto", None, None, None),
            ("ctrl+w", "closePane", None, None, None),
            ("alt+left", "moveFocus", Some("left"), None, None),
            ("alt+right", "moveFocus", Some("right"), None, None),
            ("alt+up", "moveFocus", Some("up"), None, None),
            ("alt+down", "moveFocus", Some("down"), None, None),
            ("alt+shift+left", "resizePane", Some("left"), None, None),
            ("alt+shift+right", "resizePane", Some("right"), None, None),
            ("alt+shift+up", "resizePane", Some("up"), None, None),
            ("alt+shift+down", "resizePane", Some("down"), None, None),
            ("ctrl+shift+f", "find", None, None, None),
            ("ctrl+g", "goToLine", None, None, None),
            ("ctrl+c", "copy", None, None, None),
            ("ctrl+shift+c", "copy", None, None, None),
            ("ctrl+v", "paste", None, None, None),
            ("ctrl+shift+v", "paste", None, None, None),
            ("shift+enter", "sendInput", None, Some("\u{1b}\r"), None),
            ("ctrl+shift+d", "toggleDashboard", None, None, None),
            ("f6", "focusDashboard", None, None, None),
            ("ctrl+shift+b", "cycleScrim", None, None, None),
            ("ctrl+shift+a", "toggleBackdrop", None, None, None),
            ("ctrl+shift+n", "nextAttention", None, None, None),
            ("ctrl+shift+m", "collapsePane", None, None, None),
            ("ctrl+shift+z", "togglePaneZoom", None, None, None),
            ("ctrl+shift+o", "openFavorite", None, None, None),
            ("ctrl+shift+r", "openLayout", None, None, None),
            ("ctrl+shift+l", "openLaunch", None, None, None),
            ("ctrl+shift+p", "openPalette", None, None, None),
            ("alt+shift+t", "splitWithProfile", None, None, None),
            ("ctrl+shift+t", "newTab", None, None, None),
            ("ctrl+shift+s", "newScratch", None, None, None),
            ("ctrl+shift+e", "openFiles", None, None, None),
            ("ctrl+shift+g", "openGit", None, None, None),
            ("ctrl+shift+h", "openSearch", None, None, None),
            ("ctrl+shift+x", "openEditor", None, None, None),
            ("ctrl+shift+w", "closeTab", None, None, None),
            ("ctrl+tab", "nextTab", None, None, None),
            ("ctrl+shift+tab", "prevTab", None, None, None),
            ("f1", "showHelp", None, None, None),
            ("ctrl+,", "openSettings", None, None, None),
            ("f11", "toggleFullscreen", None, None, None),
            ("ctrl+alt+9", "switchToLastTab", None, None, None),
            ("ctrl+=", "increaseFontSize", None, None, None),
            ("ctrl++", "increaseFontSize", None, None, None),
            ("ctrl+-", "decreaseFontSize", None, None, None),
            ("ctrl+0", "resetFontSize", None, None, None),
            ("ctrl+alt+1", "switchToTab", None, None, Some(1)),
            ("ctrl+alt+2", "switchToTab", None, None, Some(2)),
            ("ctrl+alt+3", "switchToTab", None, None, Some(3)),
            ("ctrl+alt+4", "switchToTab", None, None, Some(4)),
            ("ctrl+alt+5", "switchToTab", None, None, Some(5)),
            ("ctrl+alt+6", "switchToTab", None, None, Some(6)),
            ("ctrl+alt+7", "switchToTab", None, None, Some(7)),
            ("ctrl+alt+8", "switchToTab", None, None, Some(8)),
        ];
        let expected: Vec<Keybinding> = pinned
            .into_iter()
            .map(|(keys, action, direction, input, index)| Keybinding {
                keys: keys.into(),
                action: action.into(),
                direction: direction.map(Into::into),
                input: input.map(Into::into),
                index,
            })
            .collect();
        assert_eq!(default_keybindings(), expected);
    }

    fn bind(keys: &str, action: &str) -> KeybindingOp {
        let (keys, action) = (keys.into(), action.into());
        KeybindingOp::Bind { keys, action, direction: None, index: None, input: None }
    }

    fn merged(entries: &[Value]) -> Vec<Keybinding> {
        let (s, w) = parse_settings(&serde_json::json!({ "keybindings": entries }).to_string());
        assert!(w.iter().all(|w| !w.contains("invalid value, using defaults")), "{w:?}");
        s.keybindings
    }

    fn action_of(kbs: &[Keybinding], keys: &str) -> Option<String> {
        let chord = normalize_chord(keys);
        kbs.iter().find(|k| normalize_chord(&k.keys) == chord).map(|k| k.action.clone())
    }

    #[test]
    fn keybinding_op_deserializes_from_front_end_json() {
        let ops: Vec<KeybindingOp> = serde_json::from_str(
            r#"[
                { "op": "bind", "keys": "ctrl+alt+k", "action": "moveFocus", "direction": "left" },
                { "op": "bind", "keys": "ctrl+alt+j", "action": "switchToTab", "index": 3 },
                { "op": "unbind", "keys": "ctrl+w" },
                { "op": "reset", "keys": "f1" },
                { "op": "resetAll" }
            ]"#,
        )
        .unwrap();
        assert_eq!(
            ops,
            vec![
                KeybindingOp::Bind {
                    keys: "ctrl+alt+k".into(),
                    action: "moveFocus".into(),
                    direction: Some("left".into()),
                    index: None,
                    input: None,
                },
                KeybindingOp::Bind {
                    keys: "ctrl+alt+j".into(),
                    action: "switchToTab".into(),
                    direction: None,
                    index: Some(3),
                    input: None,
                },
                KeybindingOp::Unbind { keys: "ctrl+w".into() },
                KeybindingOp::Reset { keys: "f1".into() },
                KeybindingOp::ResetAll,
            ]
        );
    }

    #[test]
    fn bind_on_chord_with_no_default_adds_one_entry() {
        let out = apply_keybinding_ops(vec![], &[bind("ctrl+alt+k", "splitAuto")]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+alt+k", "action": "splitAuto" })]);
        assert_eq!(action_of(&merged(&out), "ctrl+alt+k").as_deref(), Some("splitAuto"));
    }

    #[test]
    fn bind_writes_arguments_in_key_order() {
        let out = apply_keybinding_ops(
            vec![],
            &[KeybindingOp::Bind {
                keys: "ctrl+alt+k".into(),
                action: "sendInput".into(),
                direction: None,
                index: None,
                input: Some("\u{1b}\r".into()),
            }],
        );
        assert_eq!(out[0].to_string(), r#"{"keys":"ctrl+alt+k","action":"sendInput","input":"\u001b\r"}"#);
    }

    #[test]
    fn bind_replaces_user_entry_with_different_spelling() {
        let entries = vec![serde_json::json!({ "keys": "Shift+Ctrl+L", "action": "splitAuto" })];
        let out = apply_keybinding_ops(entries, &[bind("ctrl+shift+l", "find")]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+shift+l", "action": "find" })]);
    }

    #[test]
    fn bind_equal_to_default_over_unbound_leaves_no_entry() {
        let entries = vec![serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })];
        let out = apply_keybinding_ops(entries, &[bind("Ctrl+W", "closePane")]);
        assert!(out.is_empty());
        assert_eq!(merged(&out), default_keybindings());
    }

    #[test]
    fn bind_equal_to_default_compares_arguments() {
        let left = KeybindingOp::Bind {
            keys: "alt+left".into(),
            action: "moveFocus".into(),
            direction: Some("left".into()),
            index: None,
            input: None,
        };
        assert!(apply_keybinding_ops(vec![], &[left]).is_empty());
        let right = KeybindingOp::Bind {
            keys: "alt+left".into(),
            action: "moveFocus".into(),
            direction: Some("right".into()),
            index: None,
            input: None,
        };
        assert_eq!(apply_keybinding_ops(vec![], &[right]).len(), 1);
    }

    #[test]
    fn unbind_adds_unbound_only_for_a_default_chord() {
        let out = apply_keybinding_ops(vec![], &[KeybindingOp::Unbind { keys: "ctrl+w".into() }]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })]);
        assert_eq!(action_of(&merged(&out), "ctrl+w"), None);

        let entries = vec![serde_json::json!({ "keys": "ctrl+alt+k", "action": "splitAuto" })];
        let out = apply_keybinding_ops(entries, &[KeybindingOp::Unbind { keys: "ctrl+alt+k".into() }]);
        assert!(out.is_empty());
    }

    #[test]
    fn reset_removes_user_entry_so_default_returns() {
        let entries = vec![serde_json::json!({ "keys": "CTRL+w", "action": "find" })];
        assert_eq!(action_of(&merged(&entries), "ctrl+w").as_deref(), Some("find"));
        let out = apply_keybinding_ops(entries, &[KeybindingOp::Reset { keys: "ctrl+w".into() }]);
        assert!(out.is_empty());
        assert_eq!(action_of(&merged(&out), "ctrl+w").as_deref(), Some("closePane"));
    }

    #[test]
    fn rejected_entries_and_unrelated_order_are_kept() {
        let entries = vec![
            serde_json::json!({ "keys": 5 }),
            serde_json::json!({ "keys": "ctrl+alt+a", "action": "find" }),
            serde_json::json!({ "action": "find" }),
            serde_json::json!({ "keys": "ctrl+shift+d", "action": "splitAuto" }),
            serde_json::json!({ "keys": "ctrl+alt+b", "action": "copy" }),
        ];
        let out = apply_keybinding_ops(entries.clone(), &[bind("ctrl+shift+d", "find")]);
        assert_eq!(
            out,
            vec![
                entries[0].clone(),
                entries[1].clone(),
                entries[2].clone(),
                entries[4].clone(),
                serde_json::json!({ "keys": "ctrl+shift+d", "action": "find" }),
            ]
        );
    }

    #[test]
    fn move_is_one_bind() {
        let out = apply_keybinding_ops(vec![], &[bind("ctrl+shift+d", "splitAuto")]);
        let kbs = merged(&out);
        assert_eq!(action_of(&kbs, "ctrl+shift+d").as_deref(), Some("splitAuto"));
        assert!(kbs.iter().all(|k| k.action != "toggleDashboard"));
    }

    #[test]
    fn reset_all_empties() {
        let entries = vec![serde_json::json!({ "keys": 5 }), serde_json::json!({ "keys": "f1", "action": "unbound" })];
        let out = apply_keybinding_ops(entries, &[KeybindingOp::ResetAll]);
        assert!(out.is_empty());
        assert_eq!(merged(&out), default_keybindings());
    }

    #[test]
    fn ops_apply_in_order() {
        let out = apply_keybinding_ops(
            vec![],
            &[
                bind("ctrl+alt+k", "find"),
                KeybindingOp::Unbind { keys: "ctrl+w".into() },
                KeybindingOp::Reset { keys: "ctrl+alt+k".into() },
            ],
        );
        assert_eq!(out, vec![serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })]);
    }

    #[test]
    fn raw_keybindings_reads_the_array() {
        assert_eq!(raw_keybindings("{}").unwrap(), Vec::<Value>::new());
        let text = r#"{
            // keys
            "keybindings": [
                { "keys": 5 }, // rejected but kept
                /* block */ { "keys": "ctrl+w", "action": "unbound" }
            ]
        }"#;
        assert_eq!(
            raw_keybindings(text).unwrap(),
            vec![serde_json::json!({ "keys": 5 }), serde_json::json!({ "keys": "ctrl+w", "action": "unbound" })]
        );
    }

    #[test]
    fn raw_keybindings_refuses_an_unusable_file() {
        let e = raw_keybindings(r#"{ "keybindings": { "keys": "ctrl+w" } }"#).unwrap_err();
        assert!(e.contains("fix it in settings.json"), "{e}");
        assert!(raw_keybindings("[]").unwrap_err().contains("fix it in settings.json"));
        assert!(raw_keybindings("{ nope").unwrap_err().contains("fix it in settings.json"));
    }

    fn parsed_keys(text: &str) -> Vec<Keybinding> {
        let (s, _) = parse_settings(text);
        s.keybindings
    }

    #[test]
    fn edit_keeps_the_default_files_comment_and_adds_the_chord() {
        let text = default_file_text();
        let out = edit_keybindings_text(&text, &[bind("ctrl+alt+k", "find")]).unwrap().0;
        assert!(out.contains("An entry with \"action\": \"unbound\""), "{out}");
        let kbs = parsed_keys(&out);
        assert_eq!(action_of(&kbs, "ctrl+alt+k").as_deref(), Some("find"));
        assert_eq!(action_of(&kbs, "ctrl+w").as_deref(), Some("closePane"));
    }

    #[test]
    fn edit_keeps_outside_comments_and_rejected_entries() {
        let text = "{\n  // before\n  \"keybindings\": [\n    { \"keys\": 5 },\n    { \"keys\": \"f1\", \"action\": \"unbound\" }\n  ],\n  // after\n  \"scrollback\": 100\n}\n";
        let out = edit_keybindings_text(text, &[bind("ctrl+alt+k", "find")]).unwrap().0;
        assert!(out.contains("// before") && out.contains("// after"), "{out}");
        assert!(out.contains("{ \"keys\": 5 }"), "{out}");
        assert!(out.contains("\"scrollback\": 100"), "{out}");
        let kbs = parsed_keys(&out);
        assert_eq!(action_of(&kbs, "ctrl+alt+k").as_deref(), Some("find"));
        assert_eq!(action_of(&kbs, "f1"), None);
    }

    #[test]
    fn edit_move_takes_a_chord_from_its_default_owner() {
        let defaults = default_keybindings();
        let before = action_of(&defaults, "ctrl+w").unwrap();
        assert_eq!(before, "closePane");
        let out = edit_keybindings_text(&default_file_text(), &[bind("ctrl+w", "find")]).unwrap().0;
        let kbs = parsed_keys(&out);
        assert_eq!(action_of(&kbs, "ctrl+w").as_deref(), Some("find"));
        assert!(kbs.iter().filter(|k| k.action == "closePane").all(|k| normalize_chord(&k.keys) != "ctrl+w"));
    }

    #[test]
    fn replace_all_restores_rejected_entries_and_keeps_the_rest_of_the_file() {
        let text = "{\n  // before\n  \"keybindings\": [\n    { \"keys\": 5 },\n    { \"keys\": \"ctrl+w\", \"action\": \"find\" },\n    { \"action\": \"nope\" }\n  ],\n  // after\n  \"scrollback\": 100\n}\n";
        let (reset, previous) = edit_keybindings_text(text, &[KeybindingOp::ResetAll]).unwrap();
        assert_eq!(previous, raw_keybindings(text).unwrap());
        assert!(raw_keybindings(&reset).unwrap().is_empty());
        let (restored, cleared) =
            edit_keybindings_text(&reset, &[KeybindingOp::ReplaceAll { entries: previous }]).unwrap();
        assert!(cleared.is_empty());
        assert_eq!(restored, text);

        let op: KeybindingOp = serde_json::from_str(r#"{ "op": "replaceAll", "entries": [{ "keys": 5 }] }"#).unwrap();
        assert_eq!(op, KeybindingOp::ReplaceAll { entries: vec![serde_json::json!({ "keys": 5 })] });
    }

    #[test]
    fn edit_refuses_an_invalid_file() {
        let e = edit_keybindings_text(r#"{ "keybindings": 7 }"#, &[bind("ctrl+alt+k", "find")]).unwrap_err();
        assert!(e.contains("fix it in settings.json"), "{e}");
        assert!(edit_keybindings_text("{ nope", &[]).is_err());
    }

    #[test]
    fn chord_aliases_match_keymap_ts() {
        assert_eq!(normalize_chord("win+left"), normalize_chord("meta+left"));
        assert_eq!(normalize_chord("Ctrl+Esc"), "ctrl+escape");
        assert_eq!(normalize_chord("shift+del"), normalize_chord("shift+delete"));
        assert_eq!(normalize_chord("ctrl+ins"), "ctrl+insert");
        assert_eq!(normalize_chord("ctrl++"), "ctrl++");

        let entries = vec![serde_json::json!({ "keys": "win+left", "action": "find" })];
        let out = apply_keybinding_ops(entries, &[bind("meta+left", "copy")]);
        assert_eq!(out, vec![serde_json::json!({ "keys": "meta+left", "action": "copy" })]);
    }
}
