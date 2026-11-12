//! The forge's HTTP client (docs/design/ship.md section 3.20): one `ureq` agent, an ETag cache, and
//! the mapping from status codes to `ForgeError`. Messages built here never include a header,
//! so a token cannot leak into the page through an error.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde_json::Value;
use ureq::tls::{RootCerts, TlsConfig};

use super::types::{ForgeError, ForgeErrorKind};
use crate::lock::LockExt;

const TIMEOUT: Duration = Duration::from_secs(15);
const ETAG_CAP: usize = 256;

/// Lowercased header names with their values.
pub type Headers = Vec<(String, String)>;

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The error a response stands for, or `None` for a 2xx or 304.
pub fn map_status(status: u16, headers: &[(String, String)]) -> Option<ForgeError> {
    map_status_at(status, headers, now_secs())
}

pub fn map_status_at(status: u16, headers: &[(String, String)], now: u64) -> Option<ForgeError> {
    use ForgeErrorKind as K;
    if (200..300).contains(&status) || status == 304 {
        return None;
    }
    let retry_after = header(headers, "retry-after").and_then(|v| v.parse::<u64>().ok());
    let exhausted = header(headers, "x-ratelimit-remaining") == Some("0");
    let reset = header(headers, "x-ratelimit-reset")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|r| r.saturating_sub(now));
    let err = match status {
        401 => ForgeError::new(K::SignedOut, "The code host did not accept the sign-in."),
        403 if header(headers, "x-github-sso").is_some_and(|v| v.starts_with("required")) => {
            let mut e = ForgeError::new(
                K::SsoRequired,
                "This organization requires single sign-on. Authorize the token for it, then retry.",
            );
            e.url = header(headers, "x-github-sso")
                .and_then(|v| v.split(';').find_map(|p| p.trim().strip_prefix("url=")))
                .map(str::to_string);
            e
        }
        403 | 429 if status == 429 || retry_after.is_some() || exhausted => {
            let mut e = ForgeError::new(K::RateLimited, "The code host's rate limit was reached.");
            e.retry_after_secs = retry_after.or(if exhausted { reset } else { None });
            e
        }
        403 => ForgeError::new(K::Forbidden, "The code host refused access to this repo."),
        404 => ForgeError::new(
            K::NotFound,
            "The code host could not find this repo or item.",
        ),
        s => ForgeError::other(format!("The code host answered with HTTP {s}.")),
    };
    Some(err)
}

/// A 2xx reply to a JSON request that is an HTML page instead. Azure DevOps answers an expired
/// or wrong-organization token with its sign-in page (often a 203) rather than a 401, so this is
/// `signedOut`, which lets `decorate` say the token was rejected.
pub fn html_instead_of_json(
    status: u16,
    headers: &[(String, String)],
    body: &str,
) -> Option<ForgeError> {
    if !(200..300).contains(&status) {
        return None;
    }
    let html = header(headers, "content-type")
        .is_some_and(|t| t.to_ascii_lowercase().starts_with("text/html"))
        || body.trim_start().starts_with('<');
    html.then(|| {
        ForgeError::new(
            ForgeErrorKind::SignedOut,
            "The code host answered with a sign-in page, so it did not accept the sign-in.",
        )
    })
}

/// A short, stable hash, so cache keys can tell tokens apart without holding one.
fn token_hash(auth: Option<&str>) -> String {
    let mut h = DefaultHasher::new();
    auth.unwrap_or("").hash(&mut h);
    format!("{:016x}", h.finish())
}

pub fn etag_key(method: &str, url: &str, auth: Option<&str>) -> String {
    format!("{method} {url} {}", token_hash(auth))
}

struct Cached {
    etag: String,
    body: String,
    used: u64,
}

#[derive(Default)]
struct EtagCache {
    entries: HashMap<String, Cached>,
    clock: u64,
}

impl EtagCache {
    fn get(&mut self, key: &str) -> Option<(String, String)> {
        self.clock += 1;
        let clock = self.clock;
        self.entries.get_mut(key).map(|c| {
            c.used = clock;
            (c.etag.clone(), c.body.clone())
        })
    }

    fn put(&mut self, key: String, etag: String, body: String) {
        self.clock += 1;
        if !self.entries.contains_key(&key) && self.entries.len() >= ETAG_CAP {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, c)| c.used)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            key,
            Cached {
                etag,
                body,
                used: self.clock,
            },
        );
    }
}

pub struct Http {
    agent: ureq::Agent,
    etags: Mutex<EtagCache>,
}

impl Default for Http {
    fn default() -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(TIMEOUT))
            .user_agent(concat!("Bashboard/", env!("CARGO_PKG_VERSION")))
            .proxy(ureq::Proxy::try_from_env())
            // A redirect is followed by hand, so the Authorization header never travels to
            // another host (GitHub's job logs redirect to blob storage).
            .max_redirects(0)
            .http_status_as_error(false)
            // The Windows certificate store, so corporate TLS inspection roots are trusted.
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build()
            .into();
        Self {
            agent,
            etags: Mutex::new(EtagCache::default()),
        }
    }
}

struct Reply {
    status: u16,
    headers: Headers,
    body: ureq::Body,
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

/// `location` resolved against `base`, for a relative `Location` header.
fn resolve_location(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_string();
    }
    let scheme = base.split_once("://").map(|(s, _)| s).unwrap_or("https");
    if location.starts_with('/') {
        format!("{scheme}://{}{location}", host_of(base))
    } else {
        let dir = base.rsplit_once('/').map(|(d, _)| d).unwrap_or(base);
        format!("{dir}/{location}")
    }
}

fn network_error(url: &str, e: &ureq::Error) -> ForgeError {
    let detail = match e {
        ureq::Error::Timeout(_) => "the request timed out".to_string(),
        ureq::Error::Io(io) => io.kind().to_string(),
        ureq::Error::HostNotFound => "the host name did not resolve".to_string(),
        ureq::Error::ConnectionFailed => "the connection failed".to_string(),
        ureq::Error::Tls(m) => format!("TLS: {m}"),
        ureq::Error::Rustls(e) => format!("TLS: {e}"),
        _ => "the request failed".to_string(),
    };
    ForgeError::new(
        ForgeErrorKind::Network,
        format!("Could not reach {}: {detail}.", host_of(url)),
    )
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

impl Http {
    fn send(
        &self,
        method: &str,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Reply, ForgeError> {
        let mut req = ureq::http::Request::builder().method(method).uri(url);
        if let Some(a) = auth {
            req = req.header("Authorization", a);
        }
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let bad_url = |_| ForgeError::other("The request URL is invalid.");
        let resp = match body {
            Some(v) => {
                let bytes = serde_json::to_vec(v).map_err(|e| ForgeError::other(e.to_string()))?;
                let req = req.header("Content-Type", "application/json").body(bytes);
                self.agent.run(req.map_err(bad_url)?)
            }
            // `()` sends no body at all, where an empty Vec would send `Content-Length: 0`.
            None => self.agent.run(req.body(()).map_err(bad_url)?),
        }
        .map_err(|e| network_error(url, &e))?;
        let status = resp.status().as_u16();
        let headers = resp
            .headers()
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str().to_ascii_lowercase(),
                    v.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        Ok(Reply {
            status,
            headers,
            body: resp.into_body(),
        })
    }

    /// Sends a request, following one same-host redirect with the same credentials (GitHub
    /// answers a renamed repo's API URL with a 301).
    fn send_following(
        &self,
        method: &str,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Reply, ForgeError> {
        let reply = self.send(method, url, auth, headers, body)?;
        if is_redirect(reply.status) {
            if let Some(loc) = header(&reply.headers, "location") {
                let next = resolve_location(url, loc);
                if host_of(&next).eq_ignore_ascii_case(host_of(url)) {
                    return self.send(method, &next, auth, headers, body);
                }
            }
        }
        Ok(reply)
    }

    /// Every caller sent a JSON request, so an HTML page in a 2xx reply is a sign-in page.
    fn read_body(mut reply: Reply, url: &str) -> Result<String, ForgeError> {
        if let Some(e) = map_status(reply.status, &reply.headers) {
            return Err(Self::with_forbidden_body(e, &mut reply));
        }
        let body = reply
            .body
            .read_to_string()
            .map_err(|e| network_error(url, &e))?;
        match html_instead_of_json(reply.status, &reply.headers, &body) {
            Some(e) => Err(e),
            None => Ok(body),
        }
    }

    /// A `forbidden` error gains the scopes the body says are missing.
    fn with_forbidden_body(e: ForgeError, reply: &mut Reply) -> ForgeError {
        if e.kind != ForgeErrorKind::Forbidden {
            return e;
        }
        match reply.body.with_config().limit(64 * 1024).read_to_string() {
            Ok(text) => name_missing_scopes(e, &text),
            Err(_) => e,
        }
    }

    fn parse<T: DeserializeOwned>(text: &str) -> Result<T, ForgeError> {
        let text = if text.trim().is_empty() { "null" } else { text };
        serde_json::from_str(text)
            .map_err(|_| ForgeError::other("The code host sent a reply that could not be read."))
    }

    /// A GET through the ETag cache: a 304 reuses the cached body.
    pub fn get_json<T: DeserializeOwned>(
        &self,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Result<T, ForgeError> {
        let key = etag_key("GET", url, auth);
        let cached = self.etags.lock_or_recover().get(&key);
        let mut all: Vec<(&str, &str)> = headers.to_vec();
        if let Some((etag, _)) = &cached {
            all.push(("If-None-Match", etag.as_str()));
        }
        let reply = self.send_following("GET", url, auth, &all, None)?;
        if reply.status == 304 {
            if let Some((_, body)) = cached {
                return Self::parse(&body);
            }
        }
        let etag = header(&reply.headers, "etag").map(str::to_string);
        let ok = reply.status == 200;
        let body = Self::read_body(reply, url)?;
        if let (true, Some(etag)) = (ok, etag) {
            self.etags.lock_or_recover().put(key, etag, body.clone());
        }
        Self::parse(&body)
    }

    /// A GET that bypasses the ETag cache and also returns the response headers, for a
    /// sign-in check that must reach the host and read `X-OAuth-Scopes`.
    pub fn get_json_with_headers<T: DeserializeOwned>(
        &self,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
    ) -> Result<(T, Headers), ForgeError> {
        let reply = self.send_following("GET", url, auth, headers, None)?;
        let reply_headers = reply.headers.clone();
        let body = Self::read_body(reply, url)?;
        Ok((Self::parse(&body)?, reply_headers))
    }

    /// A POST with a JSON body (or none); an empty reply is `Value::Null`. Never cached.
    pub fn post_json(
        &self,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
        body: Option<&Value>,
    ) -> Result<Value, ForgeError> {
        let reply = self.send_following("POST", url, auth, headers, body)?;
        Self::parse(&Self::read_body(reply, url)?)
    }

    pub fn patch_json(
        &self,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
        body: &Value,
    ) -> Result<Value, ForgeError> {
        let reply = self.send_following("PATCH", url, auth, headers, Some(body))?;
        Self::parse(&Self::read_body(reply, url)?)
    }

    /// The last `max_bytes` of a text body, and whether it was cut. One redirect is followed
    /// without the Authorization header or the caller's headers, since it leads to another
    /// host's signed URL.
    pub fn get_text_tail(
        &self,
        url: &str,
        auth: Option<&str>,
        headers: &[(&str, &str)],
        max_bytes: usize,
    ) -> Result<(String, bool), ForgeError> {
        let mut reply = self.send("GET", url, auth, headers, None)?;
        if is_redirect(reply.status) {
            let Some(loc) = header(&reply.headers, "location") else {
                return Err(ForgeError::other(
                    "The code host sent a redirect with no target.",
                ));
            };
            let next = resolve_location(url, loc);
            reply = self.send("GET", &next, None, &[], None)?;
        }
        if let Some(e) = map_status(reply.status, &reply.headers) {
            return Err(Self::with_forbidden_body(e, &mut reply));
        }
        // Only the content type decides here: a log may well start with `<`, and a cut tail
        // doesn't hold the body's start anyway.
        if let Some(e) = html_instead_of_json(reply.status, &reply.headers, "") {
            return Err(e);
        }
        let mut reader = reply.body.into_with_config().limit(u64::MAX).reader();
        let (bytes, truncated) = read_tail(&mut reader, max_bytes).map_err(|e| {
            ForgeError::new(
                ForgeErrorKind::Network,
                format!("The log download failed: {}.", e.kind()),
            )
        })?;
        Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
    }
}

/// The scopes a 403 body lists as required, as Bitbucket sends them in
/// `error.detail.required`, less those in `error.detail.granted`: a write call lists the read
/// scope beside the write one. Only scope-shaped strings are kept, so the message never echoes
/// arbitrary body text.
pub fn missing_scopes(body: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let granted: Vec<&str> = v
        .pointer("/error/detail/granted")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    v.pointer("/error/detail/required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !granted.contains(s))
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 64
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_' | b'-' | b'.'))
        })
        .map(str::to_string)
        .collect()
}

/// Replaces the message with "This token is missing the <scope> scope." when the body names
/// any; with none named, the generic repo-access message stands.
pub fn name_missing_scopes(mut e: ForgeError, body: &str) -> ForgeError {
    let scopes = missing_scopes(body);
    if !scopes.is_empty() {
        let noun = if scopes.len() == 1 { "scope" } else { "scopes" };
        e.message = format!("This token is missing the {} {noun}.", scopes.join(", "));
    }
    e
}

/// Reads everything, keeping only the last `max` bytes; a cut tail starts after a newline.
pub fn read_tail(reader: &mut impl Read, max: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    let mut truncated = false;
    loop {
        let n = reader.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > max.saturating_mul(2).max(max + chunk.len()) {
            let cut = buf.len() - max;
            buf.drain(..cut);
            truncated = true;
        }
    }
    if buf.len() > max {
        let cut = buf.len() - max;
        buf.drain(..cut);
        truncated = true;
    }
    if truncated {
        if let Some(i) = buf.iter().position(|&b| b == b'\n') {
            buf.drain(..=i);
        }
    }
    Ok((buf, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ForgeErrorKind as K;

    fn h(pairs: &[(&str, &str)]) -> Headers {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn kind(status: u16, pairs: &[(&str, &str)]) -> Option<ForgeErrorKind> {
        map_status_at(status, &h(pairs), 1_000).map(|e| e.kind)
    }

    #[test]
    fn status_table() {
        let table: &[(u16, &[(&str, &str)], Option<ForgeErrorKind>)] = &[
            (200, &[], None),
            (201, &[], None),
            (204, &[], None),
            (304, &[], None),
            (401, &[], Some(K::SignedOut)),
            (
                403,
                &[(
                    "X-GitHub-SSO",
                    "required; url=https://github.com/orgs/o/sso?x=1",
                )],
                Some(K::SsoRequired),
            ),
            (
                403,
                &[("x-github-sso", "partial-results; organizations=1,2")],
                Some(K::Forbidden),
            ),
            (403, &[("Retry-After", "60")], Some(K::RateLimited)),
            (
                403,
                &[
                    ("X-RateLimit-Remaining", "0"),
                    ("X-RateLimit-Reset", "1090"),
                ],
                Some(K::RateLimited),
            ),
            (403, &[("X-RateLimit-Remaining", "12")], Some(K::Forbidden)),
            (403, &[], Some(K::Forbidden)),
            (429, &[("Retry-After", "5")], Some(K::RateLimited)),
            (429, &[], Some(K::RateLimited)),
            (404, &[], Some(K::NotFound)),
            (500, &[], Some(K::Other)),
            (302, &[], Some(K::Other)),
        ];
        for (status, headers, want) in table {
            assert_eq!(kind(*status, headers), *want, "{status} {headers:?}");
        }
    }

    #[test]
    fn sso_url_and_retry_after_values() {
        let e = map_status_at(
            403,
            &h(&[(
                "X-GitHub-SSO",
                "required; url=https://github.com/orgs/o/sso?x=1",
            )]),
            0,
        )
        .unwrap();
        assert_eq!(e.url.as_deref(), Some("https://github.com/orgs/o/sso?x=1"));
        let e = map_status_at(429, &h(&[("Retry-After", "7")]), 0).unwrap();
        assert_eq!(e.retry_after_secs, Some(7));
        let e = map_status_at(
            403,
            &h(&[
                ("X-RateLimit-Remaining", "0"),
                ("X-RateLimit-Reset", "1090"),
            ]),
            1_000,
        )
        .unwrap();
        assert_eq!(e.retry_after_secs, Some(90));
    }

    #[test]
    fn messages_never_echo_headers() {
        let secret = "Bearer fake-token-123";
        for status in [401, 403, 404, 429, 500] {
            let e = map_status_at(
                status,
                &h(&[("authorization", secret), ("www-authenticate", secret)]),
                0,
            )
            .unwrap();
            assert!(!e.message.contains("fake-token-123"));
        }
    }

    #[test]
    fn etag_key_never_holds_the_token() {
        let token = "Bearer ghp_fakeTokenValue0123456789";
        let key = etag_key("GET", "https://api.github.com/x", Some(token));
        assert!(!key.contains("ghp_fakeTokenValue0123456789"));
        assert!(!key.contains(token));
        assert!(key.starts_with("GET https://api.github.com/x "));
        // Different tokens, different entries; the same token, the same entry.
        assert_ne!(
            key,
            etag_key("GET", "https://api.github.com/x", Some("Bearer other"))
        );
        assert_eq!(
            key,
            etag_key("GET", "https://api.github.com/x", Some(token))
        );
    }

    #[test]
    fn etag_cache_is_capped() {
        let mut c = EtagCache::default();
        for i in 0..(ETAG_CAP + 10) {
            c.put(format!("k{i}"), "e".into(), "b".into());
        }
        assert_eq!(c.entries.len(), ETAG_CAP);
        assert!(c.get("k0").is_none());
        assert!(c.get(&format!("k{}", ETAG_CAP + 9)).is_some());
    }

    #[test]
    fn redirect_targets_resolve() {
        assert_eq!(
            resolve_location("https://a.com/x/y", "https://b.com/z"),
            "https://b.com/z"
        );
        assert_eq!(
            resolve_location("https://a.com/x/y", "/z"),
            "https://a.com/z"
        );
        assert_eq!(
            host_of("https://api.github.com:8443/repos?x"),
            "api.github.com:8443"
        );
    }

    /// Live: TLS through the Windows certificate store and the status mapping, against
    /// GitHub's unauthenticated API. `cargo test forge::http -- --ignored`.
    #[test]
    #[ignore]
    fn live_get_over_tls() {
        let http = Http::default();
        let limits: Value = http
            .get_json("https://api.github.com/rate_limit", None, &[])
            .unwrap();
        assert!(limits.get("resources").is_some());
        let missing = http
            .get_json::<Value>(
                "https://api.github.com/repos/bashboard-no-such-owner-0/none",
                None,
                &[],
            )
            .unwrap_err();
        assert_eq!(missing.kind, K::NotFound);
    }

    #[test]
    fn forbidden_body_names_missing_scopes() {
        let body = r#"{"type": "error", "error": {"message": "Your credentials lack one or more required privilege scopes.", "detail": {"required": ["read:pipeline:bitbucket"], "granted": ["read:repository:bitbucket"]}}}"#;
        let e = map_status_at(403, &[], 0).unwrap();
        let e = name_missing_scopes(e, body);
        assert_eq!(e.kind, K::Forbidden);
        assert!(
            e.message == "This token is missing the read:pipeline:bitbucket scope.",
            "{}",
            e.message
        );
        let two = r#"{"error": {"detail": {"required": ["a:b", "c:d"]}}}"#;
        assert!(
            name_missing_scopes(map_status_at(403, &[], 0).unwrap(), two).message
                == "This token is missing the a:b, c:d scopes."
        );
        // A granted scope is not named, as when a re-run lists the read scope beside the write one.
        let write = r#"{"error": {"detail": {"required": ["read:pipeline:bitbucket", "write:pipeline:bitbucket"], "granted": ["read:pipeline:bitbucket", "read:repository:bitbucket"]}}}"#;
        assert!(
            name_missing_scopes(map_status_at(403, &[], 0).unwrap(), write).message
                == "This token is missing the write:pipeline:bitbucket scope."
        );
        // Anything not shaped like a scope, and bodies without the list, keep the generic message.
        let odd = r#"{"error": {"detail": {"required": ["<script>", "Bearer x y"]}}}"#;
        for body in [odd, "not json", "{}"] {
            let base = map_status_at(403, &[], 0).unwrap();
            assert_eq!(name_missing_scopes(base.clone(), body), base);
        }
    }

    #[test]
    fn html_in_a_success_reply_is_signed_out() {
        let page = "<!DOCTYPE html><html><head><title>Sign in</title></head></html>";
        let html = h(&[("Content-Type", "text/html; charset=utf-8")]);
        let json = h(&[("content-type", "application/json")]);
        for status in [200, 203] {
            let e = html_instead_of_json(status, &html, page).unwrap();
            assert_eq!(e.kind, K::SignedOut);
            // A body that looks like HTML counts even when the content type says otherwise.
            assert!(html_instead_of_json(status, &json, page).is_some());
        }
        assert!(html_instead_of_json(200, &json, r#"{"a": 1}"#).is_none());
        assert!(html_instead_of_json(204, &json, "").is_none());
        // Error statuses are `map_status`'s to decide.
        assert!(html_instead_of_json(401, &html, page).is_none());
        assert!(html_instead_of_json(500, &html, page).is_none());
    }

    #[test]
    fn tail_keeps_the_end() {
        let text: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        let (out, cut) = read_tail(&mut text.as_bytes(), 100).unwrap();
        assert!(cut);
        assert!(out.len() <= 100);
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("line "));
        assert!(s.ends_with("line 999\n"));
        let (out, cut) = read_tail(&mut "short\n".as_bytes(), 100).unwrap();
        assert!(!cut);
        assert_eq!(out, b"short\n");
    }
}
