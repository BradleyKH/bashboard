//! Generic credentials in Windows Credential Manager, shared by the app and `bb.exe` (which
//! includes this file by path), so both read and write the Bitbucket token the same way. It
//! depends on nothing in the crate for that reason.

/// The target the app's Bitbucket token lookup reads.
pub const BITBUCKET_TARGET: &str = "bashboard:bitbucket.org";
/// The user name is informational; the reader ignores it.
pub const BITBUCKET_USER: &str = "x-bitbucket-api-token-auth";
/// Credential Manager rejects a blob over `CRED_MAX_CREDENTIAL_BLOB_SIZE`.
pub const MAX_TOKEN_BYTES: usize = 2560;

/// The first line of the input, trimmed; rejects an empty or oversized token.
pub fn clean_token(raw: &str) -> Result<String, String> {
    let token = raw.lines().next().unwrap_or("").trim();
    if token.is_empty() {
        return Err("the token is empty".into());
    }
    if token.len() > MAX_TOKEN_BYTES {
        return Err(format!("the token is over {MAX_TOKEN_BYTES} bytes"));
    }
    Ok(token.to_string())
}

/// Overwrites a secret's bytes before freeing them. Best effort: copies made before this
/// (an IPC buffer, a reallocation) are out of reach.
pub fn wipe(secret: String) {
    let mut bytes = secret.into_bytes();
    for b in bytes.iter_mut() {
        // SAFETY: `b` is a valid, aligned, exclusive reference. Volatile so the writes are not
        // optimized away as dead stores before the free.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// A credential blob as UTF-8, or as UTF-16LE (what `cmdkey` and most Windows tools write).
pub fn decode_blob(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let text = if bytes.len() % 2 == 0 && bytes.iter().skip(1).step_by(2).any(|&b| b == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&units).ok()?
    } else {
        String::from_utf8(bytes.to_vec()).ok()?
    };
    let text = text.trim_end_matches('\0').trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredDeleteW, CredFree,
        CredReadW, CredWriteW,
    };
    use windows::core::{PCWSTR, PWSTR};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The stored blob's text, or `None` when nothing is stored or it is empty.
    pub fn read(target: &str) -> Option<String> {
        let wide = wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated and outlives the call; on success `cred` points to a
        // CREDENTIALW that CredFree releases below, after the blob is copied out.
        unsafe {
            CredReadW(PCWSTR(wide.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred).ok()?;
            let c = &*cred;
            let mut blob = if c.CredentialBlob.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()
            };
            CredFree(cred as *const _);
            let text = super::decode_blob(&blob);
            blob.fill(0);
            text
        }
    }

    /// Whether a credential is stored under the target, without copying its blob out.
    pub fn exists(target: &str) -> bool {
        let wide = wide(target);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: as in `read`; the credential is freed without being read.
        unsafe {
            if CredReadW(PCWSTR(wide.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred).is_err() {
                return false;
            }
            CredFree(cred as *const _);
        }
        true
    }

    pub fn write(target: &str, user: &str, blob: &[u8]) -> Result<(), String> {
        let mut target = wide(target);
        let mut user = wide(user);
        let mut blob = blob.to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            UserName: PWSTR(user.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        // SAFETY: the strings are NUL-terminated and the blob has the stated size; all three
        // outlive the call, and CredWriteW copies them.
        let result = unsafe { CredWriteW(&cred, 0) };
        blob.fill(0);
        result.map_err(|e| format!("could not store the credential: {e}"))
    }

    /// Returns false when no credential was stored under the target.
    pub fn delete(target: &str) -> Result<bool, String> {
        let target = wide(target);
        // SAFETY: `target` is NUL-terminated and outlives the call.
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            Ok(()) => Ok(true),
            Err(e) if e.code() == ERROR_NOT_FOUND.to_hresult() => Ok(false),
            Err(e) => Err(format!("could not remove the credential: {e}")),
        }
    }
}

#[cfg(not(windows))]
mod imp {
    const UNSUPPORTED: &str = "storing a token needs Windows Credential Manager";

    pub fn read(_target: &str) -> Option<String> {
        None
    }

    pub fn exists(_target: &str) -> bool {
        false
    }

    pub fn write(_target: &str, _user: &str, _blob: &[u8]) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub fn delete(_target: &str) -> Result<bool, String> {
        Err(UNSUPPORTED.into())
    }
}

pub use imp::{delete, exists, read, write};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blobs_decode_either_encoding() {
        assert_eq!(decode_blob(b"fake-token"), Some("fake-token".into()));
        let utf16: Vec<u8> = "fake-token"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(decode_blob(&utf16), Some("fake-token".into()));
        assert_eq!(decode_blob(b""), None);
    }

    #[test]
    fn token_cleaning() {
        assert_eq!(clean_token("abc\r\n").unwrap(), "abc");
        assert_eq!(clean_token("  abc  \nignored").unwrap(), "abc");
        assert!(clean_token("").is_err());
        assert!(clean_token("  \r\n").is_err());
        assert!(clean_token(&"a".repeat(MAX_TOKEN_BYTES)).is_ok());
        assert!(clean_token(&"a".repeat(MAX_TOKEN_BYTES + 1)).is_err());
    }

    #[test]
    fn missing_credentials() {
        let target = "bashboard:test-never-stored.invalid";
        assert!(!exists(target));
        assert_eq!(read(target), None);
    }
}
