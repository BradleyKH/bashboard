//! Installed font families for the settings dialog's Font family suggestions
//! (docs/design/terminal.md section 3.17).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FontFamily {
    pub family: String,
    pub monospace: bool,
}

/// Monospace first, then by name ignoring case, dropping repeated names (ignoring case) so a
/// family read both as monospace and not keeps its monospace entry.
fn sort_families(mut found: Vec<(String, bool)>) -> Vec<FontFamily> {
    found.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase()))
    });
    let mut seen = std::collections::HashSet::new();
    found
        .into_iter()
        .filter(|(name, _)| seen.insert(name.to_lowercase()))
        .map(|(family, monospace)| FontFamily { family, monospace })
        .collect()
}

#[cfg(windows)]
fn read_families() -> windows::core::Result<Vec<(String, bool)>> {
    use windows::Win32::Graphics::DirectWrite::{
        DWRITE_FACTORY_TYPE_SHARED, DWriteCreateFactory, IDWriteFactory, IDWriteFont1,
        IDWriteFontCollection, IDWriteFontFamily,
    };
    use windows::core::{BOOL, Interface, w};

    fn family_name(family: &IDWriteFontFamily) -> windows::core::Result<String> {
        unsafe {
            let names = family.GetFamilyNames()?;
            let mut index = 0u32;
            let mut exists = BOOL(0);
            names.FindLocaleName(w!("en-us"), &mut index, &mut exists)?;
            if !exists.as_bool() {
                index = 0;
            }
            let len = names.GetStringLength(index)? as usize;
            let mut buf = vec![0u16; len + 1];
            names.GetString(index, &mut buf)?;
            Ok(String::from_utf16_lossy(&buf[..len]))
        }
    }

    fn is_monospace(family: &IDWriteFontFamily) -> bool {
        unsafe {
            family
                .GetFont(0)
                .and_then(|font| font.cast::<IDWriteFont1>())
                .map(|font| font.IsMonospacedFont().as_bool())
                .unwrap_or(false)
        }
    }

    unsafe {
        let factory: IDWriteFactory = DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED)?;
        let mut collection: Option<IDWriteFontCollection> = None;
        // The shared factory caches the collection; checking for updates lets a font installed
        // while the app runs show up on the next call.
        factory.GetSystemFontCollection(&mut collection, true)?;
        let Some(collection) = collection else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        for i in 0..collection.GetFontFamilyCount() {
            let Ok(family) = collection.GetFontFamily(i) else {
                continue;
            };
            let Ok(name) = family_name(&family) else {
                continue;
            };
            found.push((name, is_monospace(&family)));
        }
        Ok(found)
    }
}

#[cfg(not(windows))]
fn read_families() -> Result<Vec<(String, bool)>, String> {
    Ok(Vec::new())
}

pub fn list() -> Vec<FontFamily> {
    match read_families() {
        Ok(found) => sort_families(found),
        Err(e) => {
            eprintln!("fonts: could not list installed fonts: {e}");
            Vec::new()
        }
    }
}

/// Async so Tauri runs it off the main thread and the enumeration never stalls the window.
#[tauri::command]
pub async fn fonts() -> Vec<FontFamily> {
    list()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fam(family: &str, monospace: bool) -> FontFamily {
        FontFamily {
            family: family.to_string(),
            monospace,
        }
    }

    #[test]
    fn sort_puts_monospace_first_then_names_ignoring_case() {
        let found = vec![
            ("consolas".to_string(), true),
            ("Arial".to_string(), false),
            ("Cascadia Mono".to_string(), true),
            ("bahnschrift".to_string(), false),
        ];
        assert_eq!(
            sort_families(found),
            vec![
                fam("Cascadia Mono", true),
                fam("consolas", true),
                fam("Arial", false),
                fam("bahnschrift", false),
            ]
        );
    }

    #[test]
    fn sort_drops_duplicates_ignoring_case_keeping_monospace() {
        let found = vec![
            ("Arial".to_string(), false),
            ("consolas".to_string(), false),
            ("Consolas".to_string(), true),
            ("arial".to_string(), false),
        ];
        assert_eq!(
            sort_families(found),
            vec![fam("Consolas", true), fam("Arial", false)]
        );
    }

    #[cfg(windows)]
    #[test]
    fn list_includes_consolas_as_monospace() {
        let fonts = list();
        assert!(!fonts.is_empty());
        assert!(fonts.contains(&fam("Consolas", true)));
    }
}
