//! Trust levels for file pages and the CSP each one gets (docs/design/browser.md section 3.21,
//! Trust levels).

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;

/// Where a file page may send requests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trust {
    /// Under a trusted folder, without Mark of the Web: any host.
    Trusted,
    /// Anywhere else, without Mark of the Web: its mount, CDN hosts, and the folder's allowed hosts.
    Local,
    /// Mark of the Web (zone 3 or 4), wherever it is: as Local, with Allow confirmed first.
    Downloaded,
}

/// The `ZoneId` from a file's Mark of the Web, or `None` when it has none.
#[cfg(windows)]
pub fn zone_id(path: &Path) -> Option<u8> {
    let mut stream = path.as_os_str().to_owned();
    stream.push(":Zone.Identifier");
    let bytes = std::fs::read(&stream).ok()?;
    parse_zone_id(&decode(&bytes))
}

#[cfg(not(windows))]
pub fn zone_id(_path: &Path) -> Option<u8> {
    None
}

/// Some writers save the stream as UTF-16 with a byte order mark rather than ANSI.
#[cfg(windows)]
fn decode(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
fn parse_zone_id(text: &str) -> Option<u8> {
    text.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim().eq_ignore_ascii_case("ZoneId") {
            value.trim().parse().ok()
        } else {
            None
        }
    })
}

/// The trust level of `file` (canonical) given its zone and the trusted folders from settings.
pub fn trust_level<P: AsRef<Path>>(file: &Path, zone: Option<u8>, trusted_folders: &[P]) -> Trust {
    if matches!(zone, Some(3 | 4)) {
        return Trust::Downloaded;
    }
    // Canonicalized so the comparison matches `file`'s form (verbatim on Windows, links resolved);
    // a folder that does not exist cannot hold the file, so it is skipped.
    let trusted = trusted_folders
        .iter()
        .filter_map(|f| std::fs::canonicalize(f.as_ref()).ok())
        .any(|folder| file.starts_with(folder));
    if trusted {
        Trust::Trusted
    } else {
        Trust::Local
    }
}

/// True when `host` is safe to put in a CSP source list: one token that cannot end the directive
/// or start a keyword, so a setting cannot inject policy.
pub fn is_valid_host(host: &str) -> bool {
    !host.is_empty()
        && host
            .chars()
            .all(|c| !c.is_whitespace() && !c.is_control() && !matches!(c, ';' | ',' | '\'' | '"'))
}

/// True when `host` names this machine: `localhost`, any `*.localhost`, `127.0.0.0/8`, `0.0.0.0`,
/// or `[::1]`, with or without a scheme and port, in any case. Addresses are read the way a URL
/// reads them, so `127.1` and `[::ffff:127.0.0.1]` count. `isLoopbackHost` in
/// `src/browserEgressModel.ts` mirrors this, with the same cases in both test suites.
pub fn is_loopback_host(host: &str) -> bool {
    let Some(host) = host_part(host) else {
        return false;
    };
    if host.contains('*') {
        return false;
    }
    let Ok(url) = tauri::Url::parse(&format!("http://{host}/")) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if let Some(v6) = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
        return v6.parse::<Ipv6Addr>().is_ok_and(|ip| {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_loopback() || v4.is_unspecified())
        });
    }
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return ip.is_loopback() || ip.is_unspecified();
    }
    let host = host.trim_end_matches('.');
    host == "localhost" || host.ends_with(".localhost")
}

/// The host of a CSP host source or `host:port`, without scheme, port, or path, lowercased.
/// `None` for a scheme-only source such as `https:`.
fn host_part(source: &str) -> Option<String> {
    let source = source.trim().to_ascii_lowercase();
    let rest = match source.split_once("://") {
        Some((_, rest)) => rest.to_string(),
        None if source.ends_with(':') => return None,
        None => source,
    };
    let host = if rest.starts_with('[') {
        rest.find(']').map_or(rest.as_str(), |end| &rest[..=end])
    } else {
        rest.split([':', '/']).next().unwrap_or("")
    };
    Some(host.to_string())
}

/// True when a CSP source could match a loopback host: a loopback host itself, a scheme-only
/// source, `*`, or a wildcard whose remainder a loopback host can end with (`*.localhost`,
/// `*.0.0.1`), since Chromium matches `*.<rest>` as a plain suffix, IP addresses included.
fn source_may_reach_loopback(source: &str) -> bool {
    let Some(host) = host_part(source) else {
        return true;
    };
    match host.strip_prefix('*') {
        Some(rest) => {
            let rest = rest.trim_start_matches('.').trim_end_matches('.');
            rest.is_empty()
                || rest == "localhost"
                || rest.ends_with(".localhost")
                || rest.chars().all(|c| c.is_ascii_digit() || c == '.')
        }
        None => is_loopback_host(&host),
    }
}

/// The `Content-Security-Policy` for an HTML response at `trust`. Invalid hosts are left out, and
/// so is any source that could reach this machine when the page is Downloaded (`'self'` is the
/// page's own listener only).
pub fn csp(trust: Trust, cdn_hosts: &[String], allowed_hosts: &[String], token: &str) -> String {
    match trust {
        Trust::Trusted => {
            "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'self'".into()
        }
        Trust::Local | Trust::Downloaded => {
            debug_assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
            let mut sources = String::from("'self' data: blob: 'unsafe-inline' 'unsafe-eval'");
            for host in cdn_hosts
                .iter()
                .chain(allowed_hosts)
                .filter(|h| is_valid_host(h))
                .filter(|h| trust != Trust::Downloaded || !source_may_reach_loopback(h))
            {
                sources.push(' ');
                sources.push_str(host);
            }
            format!("default-src {sources}; form-action 'self'; report-uri /{token}/__csp-report")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-browser-trust-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[cfg(windows)]
    #[test]
    fn parses_zone_ids() {
        assert_eq!(
            parse_zone_id("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=https://x/\r\n"),
            Some(3)
        );
        assert_eq!(parse_zone_id("[ZoneTransfer]\nzoneid = 4\n"), Some(4));
        assert_eq!(parse_zone_id("[ZoneTransfer]\r\n"), None);
        let utf16: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("ZoneId=3\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        assert_eq!(parse_zone_id(&decode(&utf16)), Some(3));
    }

    #[cfg(windows)]
    #[test]
    fn reads_mark_of_the_web() {
        let dir = temp("zone");
        let file = dir.join("page.html");
        fs::write(&file, "<p>x</p>").unwrap();
        assert_eq!(zone_id(&file), None);
        let stream = format!("{}:Zone.Identifier", file.display());
        fs::write(&stream, "[ZoneTransfer]\r\nZoneId=3\r\n").unwrap();
        assert_eq!(zone_id(&file), Some(3));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn trust_levels() {
        let dir = temp("levels");
        let trusted = dir.join("trusted");
        fs::create_dir_all(&trusted).unwrap();
        let inside = trusted.join("a.html");
        let outside = dir.join("b.html");
        let folders = [trusted.clone(), dir.join("missing")];
        assert_eq!(trust_level(&inside, None, &folders), Trust::Trusted);
        assert_eq!(trust_level(&inside, Some(1), &folders), Trust::Trusted);
        assert_eq!(trust_level(&outside, None, &folders), Trust::Local);
        assert_eq!(trust_level(&inside, Some(3), &folders), Trust::Downloaded);
        assert_eq!(trust_level(&outside, Some(4), &folders), Trust::Downloaded);
        // A sibling whose name extends the trusted folder's is not inside it.
        assert_eq!(
            trust_level(&dir.join("trusted2").join("c.html"), None, &folders),
            Trust::Local
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[cfg(windows)]
    #[test]
    fn mark_of_the_web_overrides_a_trusted_folder() {
        let dir = temp("motw");
        let file = dir.join("page.html");
        fs::write(&file, "x").unwrap();
        fs::write(
            format!("{}:Zone.Identifier", file.display()),
            "[ZoneTransfer]\r\nZoneId=3\r\n",
        )
        .unwrap();
        assert_eq!(
            trust_level(&file, zone_id(&file), &[dir.clone()]),
            Trust::Downloaded
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn exact_policies() {
        let cdn = strings(&["cdnjs.cloudflare.com", "unpkg.com"]);
        let allowed = strings(&["api.example.com"]);
        assert_eq!(
            csp(Trust::Trusted, &cdn, &allowed, "ab12"),
            "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'self'"
        );
        let local = "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' \
                     cdnjs.cloudflare.com unpkg.com api.example.com; form-action 'self'; \
                     report-uri /ab12/__csp-report";
        assert_eq!(csp(Trust::Local, &cdn, &allowed, "ab12"), local);
        assert_eq!(csp(Trust::Downloaded, &cdn, &allowed, "ab12"), local);
        assert_eq!(
            csp(Trust::Local, &[], &[], "ab12"),
            "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'self'; \
             report-uri /ab12/__csp-report"
        );
    }

    /// The same cases as `isLoopbackHost` in `src/browserEgressModel.test.ts`.
    const LOOPBACK: &[&str] = &[
        "localhost",
        "LOCALHOST",
        "localhost:3000",
        "localhost.",
        "app.localhost",
        "Api.App.Localhost:8080",
        "http://localhost:5173",
        "https://127.0.0.1",
        "ws://127.0.0.1:9229/path",
        "127.0.0.1",
        "127.0.0.1:8080",
        "127.1.2.3",
        "127.255.255.254:1",
        "127.1",
        "0.0.0.0",
        "0.0.0.0:3000",
        "[::1]",
        "[::1]:8080",
        "http://[::1]:8080",
        "[0:0:0:0:0:0:0:1]",
        "[::ffff:127.0.0.1]",
    ];
    const NOT_LOOPBACK: &[&str] = &[
        "example.com",
        "api.example.com:443",
        "localhost.example.com",
        "notlocalhost",
        "mylocalhost.com",
        "128.0.0.1",
        "10.0.0.1",
        "192.168.1.10:3000",
        "1.0.0.0",
        "[::2]",
        "[2001:db8::1]",
        "https:",
        "",
    ];

    #[test]
    fn loopback_hosts() {
        for host in LOOPBACK {
            assert!(is_loopback_host(host), "{host:?}");
        }
        for host in NOT_LOOPBACK {
            assert!(!is_loopback_host(host), "{host:?}");
        }
    }

    #[test]
    fn downloaded_policies_drop_every_loopback_source() {
        let wild = [
            "*",
            "*:*",
            "http://*",
            "https:",
            "ws:",
            "*.localhost",
            "*.app.localhost:3000",
            "*.0.0.1",
            "*.1",
        ];
        let mut sources: Vec<&str> = LOOPBACK.to_vec();
        sources.extend(wild);
        for source in &sources {
            let one = strings(&[source]);
            let down = csp(Trust::Downloaded, &one, &one, "ab");
            assert_eq!(
                down,
                csp(Trust::Downloaded, &[], &[], "ab"),
                "{source:?} reached a Downloaded policy"
            );
            assert!(csp(Trust::Local, &[], &one, "ab").contains(&format!(" {source};")));
        }
        // Wildcards that cannot match this machine, and ordinary hosts, stay.
        let kept = strings(&[
            "*.example.com",
            "api.example.com:8443",
            "https://cdn.example.org",
        ]);
        let down = csp(Trust::Downloaded, &[], &kept, "ab");
        for host in &kept {
            assert!(down.contains(host.as_str()), "{host}");
        }
        assert_eq!(
            csp(Trust::Trusted, &[], &strings(&["localhost:3000"]), "ab"),
            csp(Trust::Trusted, &[], &[], "ab")
        );
    }

    #[test]
    fn hosts_cannot_inject_directives() {
        for bad in [
            "evil.com; script-src *",
            "a.com;",
            "a.com b.com",
            "a,b",
            "'unsafe-hashes'",
            "\"x\"",
            "",
            "a\nb",
        ] {
            assert!(!is_valid_host(bad), "{bad:?}");
        }
        assert!(is_valid_host("https://api.example.com:8443"));
        assert!(is_valid_host("*.example.com"));
        let policy = csp(
            Trust::Local,
            &strings(&["evil.com; script-src *"]),
            &strings(&["ok.com"]),
            "ab",
        );
        assert!(!policy.contains("evil.com"));
        assert!(policy.contains(" ok.com;"));
        assert_eq!(policy.matches(';').count(), 2);
    }
}
