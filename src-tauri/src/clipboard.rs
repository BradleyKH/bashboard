/// Clipboard text, or None when the clipboard holds no text (an image, or nothing).
/// Read natively because WebView2 gates navigator.clipboard.readText behind a permission prompt.
#[tauri::command]
pub fn clipboard_read_text() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}
