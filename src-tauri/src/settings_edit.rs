//! In-place edits to the hand-edited settings file (design section 3.6). Only the targeted
//! value changes; comments, key order, and formatting elsewhere in the file are kept.

use jsonc_parser::{
    ParseOptions,
    cst::{CstInputValue, CstRootNode},
};
use serde_json::Value;

fn to_input(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(b) => CstInputValue::Bool(*b),
        Value::Number(n) => CstInputValue::Number(n.to_string()),
        Value::String(s) => CstInputValue::String(s.clone()),
        Value::Array(a) => CstInputValue::Array(a.iter().map(to_input).collect()),
        Value::Object(o) => CstInputValue::Object(o.iter().map(|(k, v)| (k.clone(), to_input(v))).collect()),
    }
}

/// Sets the value at `path` (e.g. `["backdrop", "animate"]`), creating missing objects along
/// the way. A non-object found where an object is needed is replaced.
pub fn set_value(text: &str, path: &[String], value: &Value) -> Result<String, String> {
    let (last, parents) = path.split_last().ok_or("an empty settings path")?;
    let root = CstRootNode::parse(text, &ParseOptions::default())
        .map_err(|e| format!("settings file is not valid JSONC ({e})"))?;
    let mut obj = root.object_value_or_set();
    for key in parents {
        obj = obj.object_value_or_set(key);
    }
    match obj.get(last) {
        Some(prop) => prop.set_value(to_input(value)),
        None => {
            obj.append(last, to_input(value));
        }
    }
    Ok(root.to_string())
}

const ARRAY_PLACEHOLDER: &str = "bashboard-array-placeholder-7f3a9c";

fn item_line(item: &Value) -> String {
    match item {
        Value::Object(o) if !o.is_empty() => {
            let fields: Vec<String> = o.iter().map(|(k, v)| format!("{}: {}", Value::String(k.clone()), v)).collect();
            format!("{{ {} }}", fields.join(", "))
        }
        other => other.to_string(),
    }
}

/// Replaces (or adds) the array at `path` with `items`, one item per line, keeping everything
/// outside the array byte for byte. Comments inside the replaced array are not kept.
pub fn set_array_lines(text: &str, path: &[String], items: &[Value]) -> Result<String, String> {
    let marked = set_value(text, path, &Value::String(ARRAY_PLACEHOLDER.to_string()))?;
    let quoted = format!("\"{ARRAY_PLACEHOLDER}\"");
    let mut hits = marked.match_indices(&quoted);
    let (at, _) = hits.next().ok_or("could not locate the array in the settings file")?;
    if hits.next().is_some() {
        return Err("could not locate the array in the settings file".into());
    }
    let line_start = marked[..at].rfind('\n').map_or(0, |i| i + 1);
    let indent: String = marked[line_start..].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    let array = if items.is_empty() {
        "[]".to_string()
    } else {
        let body: Vec<String> = items.iter().map(|i| format!("{indent}  {}", item_line(i))).collect();
        format!("[\n{}\n{indent}]", body.join(",\n"))
    };
    Ok(format!("{}{}{}", &marked[..at], array, &marked[at + quoted.len()..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn path(p: &str) -> Vec<String> {
        p.split('.').map(String::from).collect()
    }

    #[test]
    fn replaces_a_value_and_keeps_comments() {
        let text = "{\n  // keep me\n  \"backdrop\": { \"animate\": true, \"maxFps\": 60 } // and me\n}\n";
        let out = set_value(text, &path("backdrop.animate"), &json!(false)).unwrap();
        assert_eq!(out, "{\n  // keep me\n  \"backdrop\": { \"animate\": false, \"maxFps\": 60 } // and me\n}\n");
    }

    #[test]
    fn adds_a_missing_key_and_parent() {
        let out = set_value("{\n  \"font\": { \"size\": 14 }\n}\n", &path("scrim.opacity"), &json!(0.25)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v, json!({ "font": { "size": 14 }, "scrim": { "opacity": 0.25 } }));
    }

    #[test]
    fn writes_numbers_as_written() {
        let out = set_value("{ \"scrim\": { \"opacity\": 0.45 } }", &path("scrim.opacity"), &json!(0)).unwrap();
        assert_eq!(out, "{ \"scrim\": { \"opacity\": 0 } }");
    }

    #[test]
    fn rejects_invalid_files() {
        assert!(set_value("{ \"a\": ", &path("a"), &json!(1)).is_err());
        assert!(set_value("{}", &[], &json!(1)).is_err());
    }

    fn parse(text: &str) -> Value {
        let mut stripped = String::new();
        std::io::Read::read_to_string(&mut json_comments::StripComments::new(text.as_bytes()), &mut stripped).unwrap();
        serde_json::from_str(&stripped).unwrap()
    }

    fn key_path() -> Vec<String> {
        vec!["keybindings".to_string()]
    }

    #[test]
    fn array_lines_keep_comments_around_the_property() {
        let text = "{\n  // before\n  \"keybindings\": [], // after\n  \"font\": { \"size\": 14 }\n}\n";
        let items = [json!({ "keys": "ctrl+k", "action": "find" })];
        let out = set_array_lines(text, &key_path(), &items).unwrap();
        assert!(out.contains("// before\n"));
        assert!(out.contains("// after\n"));
        assert_eq!(parse(&out)["keybindings"], json!(items));
        assert_eq!(parse(&out)["font"], json!({ "size": 14 }));
    }

    #[test]
    fn array_lines_replace_a_multiline_array_at_the_right_indent() {
        let text = "{\n  \"keybindings\": [\n    { \"keys\": \"a\", \"action\": \"x\" },\n    // gone\n    5\n  ],\n  \"z\": 1\n}\n";
        let items = [json!({ "keys": "ctrl+k", "action": "find" }), json!({ "keys": "ctrl+j", "action": "unbound" })];
        let out = set_array_lines(text, &key_path(), &items).unwrap();
        assert_eq!(
            out,
            "{\n  \"keybindings\": [\n    { \"keys\": \"ctrl+k\", \"action\": \"find\" },\n    { \"keys\": \"ctrl+j\", \"action\": \"unbound\" }\n  ],\n  \"z\": 1\n}\n"
        );
    }

    #[test]
    fn array_lines_add_a_missing_key() {
        let out = set_array_lines("{\n  \"z\": 1\n}\n", &key_path(), &[json!({ "keys": "a", "action": "b" })]).unwrap();
        let v = parse(&out);
        assert_eq!(v["z"], json!(1));
        assert_eq!(v["keybindings"], json!([{ "keys": "a", "action": "b" }]));
        assert!(out.contains("\n    { \"keys\": \"a\", \"action\": \"b\" }\n  ]"));
    }

    #[test]
    fn array_lines_write_an_empty_list() {
        let out = set_array_lines("{\n  \"keybindings\": [\n    5\n  ]\n}\n", &key_path(), &[]).unwrap();
        assert_eq!(out, "{\n  \"keybindings\": []\n}\n");
    }

    #[test]
    fn array_lines_round_trip_control_characters() {
        let items = [json!({ "keys": "shift+enter", "action": "sendInput", "input": "\u{1b}\r" }), json!("plain")];
        let out = set_array_lines("{}", &key_path(), &items).unwrap();
        assert_eq!(parse(&out)["keybindings"], json!(items));
        assert!(!out.contains('\r'));
    }

    #[test]
    fn array_lines_reject_invalid_files() {
        assert!(set_array_lines("{ \"a\": ", &key_path(), &[]).is_err());
    }
}
