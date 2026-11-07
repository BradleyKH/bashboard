//! URL and header policy for Local Browser frames (docs/design/browser.md section 4.21). Pure,
//! so the CDP bridge and `bb browse` share one definition of "loopback".

use tauri::Url;

/// What a Local Browser frame may do with a URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlClass {
    /// Loopback http or https that is not the app itself: load it in the frame.
    Allowed,
    /// Non-loopback http(s): never framed, but fine to hand to the system browser.
    External,
    /// Anything else (other schemes, `*.localhost`, the app's own origin).
    Refused,
}

const LOOPBACK_HOSTS: [&str; 2] = ["localhost", "127.0.0.1"];

fn parse(url: &str) -> Option<Url> {
    Url::parse(url.trim()).ok()
}

fn loopback_host(u: &Url) -> bool {
    u.host_str().is_some_and(|h| LOOPBACK_HOSTS.contains(&h))
}

fn has_userinfo(u: &Url) -> bool {
    !u.username().is_empty() || u.password().is_some()
}

/// True for http or https on `localhost` or `127.0.0.1`, any port, without userinfo. These
/// match the app's `frame-src`; WebView2 does not accept an IPv6 host there, so `[::1]` is out.
pub fn is_loopback_url(url: &str) -> bool {
    parse(url).is_some_and(|u| {
        matches!(u.scheme(), "http" | "https") && !has_userinfo(&u) && loopback_host(&u)
    })
}

/// True when `url` reaches the app's own dev server. Every loopback host on the app's port
/// counts, since `localhost` and `127.0.0.1` both reach the same Vite server.
pub fn is_app_origin(url: &str, app_origin: &str) -> bool {
    let (Some(u), Some(app)) = (parse(url), parse(app_origin)) else {
        return false;
    };
    if u.scheme() == app.scheme()
        && u.host_str() == app.host_str()
        && u.port_or_known_default() == app.port_or_known_default()
    {
        return true;
    }
    loopback_host(&app)
        && loopback_host(&u)
        && u.port_or_known_default() == app.port_or_known_default()
}

/// Hosts that resolve to this machine but are not on the allowed list; never sent to the
/// system browser as "external".
fn local_looking_host(u: &Url) -> bool {
    let Some(host) = u.host_str() else {
        return true;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return ip.is_loopback() || ip.is_unspecified();
    }
    let d = host.trim_end_matches('.');
    d == "localhost" || d.ends_with(".localhost")
}

/// Classifies a document URL for a Local Browser frame. `app_origin` is the app's own origin
/// when it is served over loopback (debug builds), or `None`.
pub fn classify(url: &str, app_origin: Option<&str>) -> UrlClass {
    let Some(u) = parse(url) else {
        return UrlClass::Refused;
    };
    if app_origin.is_some_and(|app| is_app_origin(url, app)) {
        return UrlClass::Refused;
    }
    if is_loopback_url(url) {
        return UrlClass::Allowed;
    }
    if matches!(u.scheme(), "http" | "https") && !has_userinfo(&u) && !local_looking_host(&u) {
        return UrlClass::External;
    }
    UrlClass::Refused
}

/// Drops the `frame-ancestors` directive from a CSP header value, keeping the rest. A header may
/// carry several comma-separated policies. Returns `None` when nothing is left.
pub fn strip_frame_ancestors(value: &str) -> Option<String> {
    let policies: Vec<String> = value
        .split(',')
        .map(|policy| {
            policy
                .split(';')
                .map(str::trim)
                .filter(|d| {
                    !d.is_empty()
                        && !d
                            .split_ascii_whitespace()
                            .next()
                            .is_some_and(|n| n.eq_ignore_ascii_case("frame-ancestors"))
                })
                .collect::<Vec<_>>()
                .join("; ")
        })
        .filter(|p| !p.is_empty())
        .collect();
    (!policies.is_empty()).then(|| policies.join(", "))
}

/// Rewrites response headers so the document can render in a frame. Returns `None` when no
/// header blocks framing, so the caller can let the response through untouched. The body handed
/// back to Chromium is already decoded, so encoding and length headers go too.
pub fn unframe_headers(headers: &[(String, String)]) -> Option<Vec<(String, String)>> {
    let blocks = |name: &str, value: &str| {
        name.eq_ignore_ascii_case("x-frame-options")
            || (is_csp(name) && strip_frame_ancestors(value).as_deref() != Some(value.trim()))
    };
    if !headers.iter().any(|(n, v)| blocks(n, v)) {
        return None;
    }
    let mut out = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "x-frame-options" | "content-encoding" | "content-length" | "transfer-encoding"
        ) {
            continue;
        }
        if is_csp(name) {
            if let Some(v) = strip_frame_ancestors(value) {
                out.push((name.clone(), v));
            }
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    Some(out)
}

fn is_csp(name: &str) -> bool {
    name.eq_ignore_ascii_case("content-security-policy")
        || name.eq_ignore_ascii_case("content-security-policy-report-only")
}

#[cfg(test)]
mod tests {
    use super::*;

    const APP: &str = "http://localhost:1420";

    #[test]
    fn loopback_forms() {
        for u in [
            "http://localhost:5173/",
            "http://localhost/",
            "http://127.0.0.1:8080/x?y#z",
            "http://LOCALHOST:3000",
            "https://localhost:7001/",
            "https://127.0.0.1:5001/x",
        ] {
            assert!(is_loopback_url(u), "{u}");
            assert_eq!(classify(u, Some(APP)), UrlClass::Allowed, "{u}");
        }
    }

    #[test]
    fn not_loopback() {
        for u in [
            "http://user@localhost:5173/",
            "https://user@localhost:7001/",
            "http://a:b@127.0.0.1/",
            "http://foo.localhost:5173/",
            "https://foo.localhost:5173/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://localhost.evil.com/",
            "http://127.0.0.2/",
            "http://[::1]:3000/",
            "file:///C:/x",
            "ws://localhost:5173/",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(!is_loopback_url(u), "{u}");
        }
    }

    #[test]
    fn classification() {
        assert_eq!(classify("http://tauri.localhost/", None), UrlClass::Refused);
        assert_eq!(
            classify("http://foo.localhost:3000/", None),
            UrlClass::Refused
        );
        assert_eq!(classify("https://localhost:3000/", None), UrlClass::Allowed);
        assert_eq!(classify("https://tauri.localhost/", None), UrlClass::Refused);
        assert_eq!(classify("http://127.0.0.2/", None), UrlClass::Refused);
        assert_eq!(classify("http://0.0.0.0:3000/", None), UrlClass::Refused);
        assert_eq!(classify("http://[::1]:3000/", None), UrlClass::Refused);
        assert_eq!(classify("file:///C:/x", None), UrlClass::Refused);
        assert_eq!(
            classify("http://localhost.evil.com/", None),
            UrlClass::External
        );
        assert_eq!(classify("https://example.com/", None), UrlClass::External);
        assert_eq!(classify("http://example.com/", None), UrlClass::External);
        assert_eq!(
            classify("https://user@example.com/", None),
            UrlClass::Refused
        );
    }

    #[test]
    fn app_origin_refused_on_every_loopback_host() {
        for u in [
            "http://localhost:1420/",
            "http://127.0.0.1:1420/x",
            "https://localhost:1420/",
        ] {
            assert!(is_app_origin(u, APP), "{u}");
            assert_eq!(classify(u, Some(APP)), UrlClass::Refused, "{u}");
        }
        assert!(!is_app_origin("http://localhost:1421/", APP));
        assert_eq!(classify("http://localhost:1420/", None), UrlClass::Allowed);
        assert!(is_app_origin(
            "http://tauri.localhost/x",
            "http://tauri.localhost"
        ));
    }

    #[test]
    fn strips_only_frame_ancestors() {
        assert_eq!(strip_frame_ancestors("frame-ancestors 'none'"), None);
        assert_eq!(
            strip_frame_ancestors("default-src 'self'; Frame-Ancestors 'none'; img-src *")
                .as_deref(),
            Some("default-src 'self'; img-src *")
        );
        assert_eq!(
            strip_frame_ancestors("frame-ancestors 'self', script-src 'self'").as_deref(),
            Some("script-src 'self'")
        );
    }

    fn h(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect()
    }

    #[test]
    fn unframe_rewrites_only_when_needed() {
        assert_eq!(
            unframe_headers(&h(&[
                ("content-type", "text/html"),
                ("content-security-policy", "script-src 'self'")
            ])),
            None
        );
        let out = unframe_headers(&h(&[
            ("Content-Type", "text/html"),
            ("X-Frame-Options", "DENY"),
            ("Content-Encoding", "gzip"),
            ("Content-Length", "10"),
            ("Set-Cookie", "a=1"),
            ("Set-Cookie", "b=2"),
            (
                "Content-Security-Policy-Report-Only",
                "frame-ancestors 'none'; script-src 'self'",
            ),
        ]))
        .unwrap();
        assert_eq!(
            out,
            h(&[
                ("Content-Type", "text/html"),
                ("Set-Cookie", "a=1"),
                ("Set-Cookie", "b=2"),
                ("Content-Security-Policy-Report-Only", "script-src 'self'"),
            ])
        );
        let csp_only =
            unframe_headers(&h(&[("content-security-policy", "frame-ancestors 'none'")])).unwrap();
        assert!(csp_only.is_empty());
    }
}
