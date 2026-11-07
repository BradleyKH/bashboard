//! App keybindings while a Local Browser page has focus (docs/design/browser.md section 4.21).
//! Keys typed into the out-of-process frame never reach the app's DOM, so `keys.ts` cannot see
//! them. WebView2's `AcceleratorKeyPressed` still does: a key that matches an app binding is
//! marked handled (the page never sees it) and sent to the front end as `browser://chord`.

use crate::settings::{normalize_chord, Keybinding};

/// One key-down as WebView2 reports it, with the modifier state read at that moment.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct KeyPress {
    pub vk: u32,
    /// What the key types under the active layout with only Shift applied, if anything.
    pub typed: Option<char>,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

/// Terminal actions with no meaning for a page; their keys (Ctrl+C, Ctrl+V, Shift+Enter) keep
/// reaching it.
const PAGE_KEEPS: &[&str] = &["copy", "paste", "sendInput"];

const VK_F1: u32 = 0x70;
const VK_F24: u32 = 0x87;

/// The chord's settings spelling in `normalize_chord` form (modifiers sorted), or None for a
/// modifier alone or a key no binding can name. Mirrors `chordFromEvent` in `src/keymap.ts`:
/// digits by position, other printable keys by what the layout types (so Dvorak's comma key is
/// `,`), and letters by virtual key when the layout types something non-ASCII.
pub(crate) fn chord_of(k: &KeyPress) -> Option<String> {
    let key: String = match k.vk {
        0x30..=0x39 => char::from_u32(k.vk).map(String::from)?,
        _ if k.typed.is_some_and(|c| ('!'..='~').contains(&c)) => k.typed?.to_ascii_lowercase().to_string(),
        0x41..=0x5A => char::from_u32(k.vk + 0x20).map(String::from)?,
        VK_F1..=VK_F24 => format!("f{}", k.vk - VK_F1 + 1),
        _ => named_key(k.vk)?.to_string(),
    };
    let mods = [(k.alt, "alt"), (k.ctrl, "ctrl"), (k.meta, "meta"), (k.shift, "shift")];
    let mut parts: Vec<&str> = mods.iter().filter(|(on, _)| *on).map(|(_, m)| *m).collect();
    parts.push(&key);
    Some(parts.join("+"))
}

fn named_key(vk: u32) -> Option<&'static str> {
    Some(match vk {
        0x25 => "left",
        0x26 => "up",
        0x27 => "right",
        0x28 => "down",
        0x0D => "enter",
        0x09 => "tab",
        0x1B => "escape",
        0x20 => "space",
        0x24 => "home",
        0x23 => "end",
        0x21 => "pageup",
        0x22 => "pagedown",
        0x2E => "delete",
        0x08 => "backspace",
        0x2D => "insert",
        _ => return None,
    })
}

/// The binding an app chord runs while a page has focus. Only keys with Ctrl or Alt, and
/// function keys, are candidates, so plain typing never pays for a lookup.
pub(crate) fn binding_for<'a>(k: &KeyPress, bindings: &'a [Keybinding]) -> Option<&'a Keybinding> {
    if !(k.ctrl || k.alt || (VK_F1..=VK_F24).contains(&k.vk)) {
        return None;
    }
    let chord = chord_of(k)?;
    bindings
        .iter()
        .find(|b| normalize_chord(&b.keys) == chord)
        .filter(|b| !PAGE_KEEPS.contains(&b.action.as_str()))
}

#[cfg(windows)]
pub use win::register;

#[cfg(windows)]
mod win {
    use super::*;
    use crate::browser::BrowserState;
    use crate::settings::SettingsState;
    use tauri::{Emitter, Manager};
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN, COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
    };

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetKeyState(vk: i32) -> i16;
        fn GetKeyboardLayout(thread: u32) -> isize;
        fn ToUnicodeEx(
            vk: u32,
            scan: u32,
            state: *const u8,
            buf: *mut u16,
            len: i32,
            flags: u32,
            layout: isize,
        ) -> i32;
    }

    const VK_SHIFT: i32 = 0x10;
    const VK_CONTROL: i32 = 0x11;
    const VK_MENU: i32 = 0x12;
    const VK_LWIN: i32 = 0x5B;
    const VK_RWIN: i32 = 0x5C;
    /// ToUnicodeEx flag: leave the keyboard's dead-key state alone (Windows 10 1607 and later).
    const KEEP_STATE: u32 = 0x4;

    fn down(vk: i32) -> bool {
        unsafe { GetKeyState(vk) < 0 }
    }

    /// What the key types with Shift as held and no Ctrl or Alt, matching what the page's
    /// `event.key` reports, so a binding means the same key in a page as in a terminal.
    fn typed(vk: u32, scan: u32, shift: bool) -> Option<char> {
        let mut state = [0u8; 256];
        if shift {
            state[VK_SHIFT as usize] = 0x80;
        }
        let mut buf = [0u16; 4];
        let n = unsafe {
            ToUnicodeEx(vk, scan, state.as_ptr(), buf.as_mut_ptr(), buf.len() as i32, KEEP_STATE, GetKeyboardLayout(0))
        };
        if n == 1 { char::from_u32(buf[0] as u32) } else { None }
    }

    pub fn register(window: &tauri::WebviewWindow) {
        let target = window.clone();
        let _ = window.with_webview(move |webview| unsafe {
            let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let browser = target.state::<BrowserState>();
                let Some(pane_id) = browser.focused_pane_attached() else { return Ok(()) };
                let mut kind = Default::default();
                args.KeyEventKind(&mut kind)?;
                if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
                    return Ok(());
                }
                let mut vk = 0u32;
                args.VirtualKey(&mut vk)?;
                let mut status = Default::default();
                args.PhysicalKeyStatus(&mut status)?;
                let shift = down(VK_SHIFT);
                let press = KeyPress {
                    vk,
                    typed: typed(vk, status.ScanCode, shift),
                    ctrl: down(VK_CONTROL),
                    alt: down(VK_MENU),
                    shift,
                    meta: down(VK_LWIN) || down(VK_RWIN),
                };
                let settings = target.state::<SettingsState>().current();
                if let Some(binding) = binding_for(&press, &settings.keybindings) {
                    args.SetHandled(true)?;
                    let _ = target.emit(
                        "browser://chord",
                        ChordEvent { pane_id, binding: binding.clone() },
                    );
                }
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = webview.controller().add_AcceleratorKeyPressed(&handler, &mut token) {
                eprintln!("browser: could not register the chord handler: {e}");
            }
        });
    }

    #[derive(serde::Serialize, Clone)]
    #[serde(rename_all = "camelCase")]
    struct ChordEvent {
        pane_id: String,
        binding: Keybinding,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::default_keybindings;

    fn press(vk: u32, typed: Option<char>) -> KeyPress {
        KeyPress { vk, typed, ..Default::default() }
    }

    fn ctrl(vk: u32, typed: Option<char>) -> KeyPress {
        KeyPress { ctrl: true, ..press(vk, typed) }
    }

    fn action(k: KeyPress) -> Option<String> {
        binding_for(&k, &default_keybindings()).map(|b| b.action.clone())
    }

    #[test]
    fn chord_spelling_matches_normalize_chord() {
        let k = KeyPress { alt: true, ctrl: true, shift: true, meta: true, ..press(0x09, Some('\t')) };
        assert_eq!(chord_of(&k).as_deref(), Some("alt+ctrl+meta+shift+tab"));
        assert_eq!(normalize_chord("win+Shift+ctrl+ALT+Tab"), "alt+ctrl+meta+shift+tab");
        assert_eq!(chord_of(&press(0x10, None)), None);
        assert_eq!(chord_of(&press(0x7B, None)).as_deref(), Some("f12"));
        assert_eq!(chord_of(&press(0x20, Some(' '))).as_deref(), Some("space"));
    }

    #[test]
    fn printable_keys_follow_the_layout() {
        // US-Dvorak: the key with VK_OEM_COMMA types "," (physical W), VK_W types "w" (physical comma).
        assert_eq!(chord_of(&ctrl(0xBC, Some(','))).as_deref(), Some("ctrl+,"));
        assert_eq!(chord_of(&ctrl(0x57, Some('w'))).as_deref(), Some("ctrl+w"));
        // Shifted letters read as the letter; shifted punctuation as what it types.
        let k = KeyPress { shift: true, ..ctrl(0x50, Some('P')) };
        assert_eq!(chord_of(&k).as_deref(), Some("ctrl+shift+p"));
        let k = KeyPress { shift: true, ..ctrl(0xBB, Some('+')) };
        assert_eq!(chord_of(&k).as_deref(), Some("ctrl+shift++"));
        // A layout that types non-ASCII on a letter key falls back to the virtual key.
        assert_eq!(chord_of(&ctrl(0x46, Some('а'))).as_deref(), Some("ctrl+f"));
        assert_eq!(chord_of(&ctrl(0x46, None)).as_deref(), Some("ctrl+f"));
    }

    #[test]
    fn digits_read_by_position() {
        let k = KeyPress { alt: true, shift: true, ..ctrl(0x32, Some('@')) };
        assert_eq!(chord_of(&k).as_deref(), Some("alt+ctrl+shift+2"));
        assert_eq!(action(KeyPress { alt: true, ..ctrl(0x31, Some('1')) }).as_deref(), Some("switchToTab"));
    }

    #[test]
    fn app_chords_are_forwarded() {
        assert_eq!(action(ctrl(0x09, Some('\t'))).as_deref(), Some("nextTab"));
        assert_eq!(action(KeyPress { shift: true, ..ctrl(0x09, None) }).as_deref(), Some("prevTab"));
        assert_eq!(action(KeyPress { alt: true, ..press(0x27, None) }).as_deref(), Some("moveFocus"));
        assert_eq!(action(KeyPress { shift: true, ..ctrl(0x50, Some('P')) }).as_deref(), Some("openPalette"));
        assert_eq!(action(ctrl(0xBC, Some(','))).as_deref(), Some("openSettings"));
        assert_eq!(action(press(0x75, None)).as_deref(), Some("focusDashboard"));
    }

    #[test]
    fn page_keys_stay_with_the_page() {
        for (vk, c) in [(0x43, 'c'), (0x56, 'v'), (0x58, 'x'), (0x41, 'a'), (0x5A, 'z'), (0x46, 'f')] {
            assert_eq!(action(ctrl(vk, Some(c))), None, "ctrl+{c}");
        }
        assert_eq!(action(KeyPress { shift: true, ..press(0x0D, Some('\r')) }), None);
        assert_eq!(action(press(0x57, Some('w'))), None);
        // Bound without Ctrl or Alt and not a function key: never a candidate.
        let mut b = default_keybindings();
        b.push(Keybinding { keys: "shift+w".into(), action: "newTab".into(), direction: None, input: None, index: None });
        assert!(binding_for(&KeyPress { shift: true, ..press(0x57, Some('W')) }, &b).is_none());
    }

    #[test]
    fn a_user_binding_can_claim_a_page_key() {
        let mut b = default_keybindings();
        b.push(Keybinding { keys: "Ctrl+A".into(), action: "openPalette".into(), direction: None, input: None, index: None });
        assert_eq!(binding_for(&ctrl(0x41, Some('a')), &b).map(|k| k.action.as_str()), Some("openPalette"));
    }
}
