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
}
