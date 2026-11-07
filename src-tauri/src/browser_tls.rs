//! TLS checks against loopback servers for Local Browser (docs/design/browser.md section 4.21):
//! which scheme a port speaks, and why an https page failed to load. Chromium's error page is the
//! only place WebView2 names the cause, so the core repeats the handshake itself, against the
//! Windows certificate store as WebView2 does.

use serde::Serialize;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::Duration;
use tauri::Url;
use ureq::tls::{RootCerts, TlsConfig};

/// A plain http server that waits for a full request line never answers the hello; past this,
/// the port counts as http.
const HELLO_TIMEOUT: Duration = Duration::from_millis(800);
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);

/// A loopback server answers at once or not at all.
const TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TlsProbe {
    /// The handshake failed on the server's certificate, which Windows does not trust.
    Untrusted,
    /// The handshake failed some other way, as when the port serves plain http.
    NotTls,
    /// Nothing accepted the connection.
    Refused,
    /// The handshake succeeded, or failed for a reason none of the above covers.
    Other,
}

fn classify_rustls(e: &rustls::Error) -> TlsProbe {
    match e {
        rustls::Error::InvalidCertificate(_) => TlsProbe::Untrusted,
        _ => TlsProbe::NotTls,
    }
}

fn classify(e: &ureq::Error) -> TlsProbe {
    match e {
        ureq::Error::Rustls(r) => classify_rustls(r),
        ureq::Error::Tls(_) => TlsProbe::NotTls,
        // A handshake failure reaches ureq as an io error wrapping the rustls one.
        ureq::Error::Io(io) => match io.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
            Some(r) => classify_rustls(r),
            None if io.kind() == std::io::ErrorKind::ConnectionRefused => TlsProbe::Refused,
            None => TlsProbe::Other,
        },
        ureq::Error::ConnectionFailed => TlsProbe::Refused,
        _ => TlsProbe::Other,
    }
}

fn probe(url: &str) -> TlsProbe {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into();
    match agent.head(url).call() {
        Ok(_) => TlsProbe::Other,
        Err(e) => classify(&e),
    }
}

fn connect(host: &str, port: u16) -> Option<TcpStream> {
    // `localhost` resolves to both families, and a dev server may bind only one.
    (host, port)
        .to_socket_addrs()
        .ok()?
        .find_map(|addr| TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT).ok())
}

/// Whether `host:port` answers a TLS ClientHello with a TLS record (a ServerHello or an alert).
/// Only the record header is read, so no certificate is checked and no HTTP request is sent.
fn speaks_tls(host: &str, port: u16) -> bool {
    hello_answered(host, port).unwrap_or(false)
}

fn hello_answered(host: &str, port: u16) -> Option<bool> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .ok()?
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    let name = rustls::pki_types::ServerName::try_from(host.to_string()).ok()?;
    let mut conn = rustls::ClientConnection::new(Arc::new(config), name).ok()?;
    let mut stream = connect(host, port)?;
    stream.set_read_timeout(Some(HELLO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(HELLO_TIMEOUT)).ok()?;
    while conn.wants_write() {
        conn.write_tls(&mut stream).ok()?;
    }
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).ok()?;
    Some(matches!(head, [0x15 | 0x16, 0x03]))
}

/// The https form of an http loopback URL, keeping its port when it was http's default.
fn as_https(url: &str) -> Option<(Url, String, u16)> {
    let mut u = Url::parse(url.trim()).ok()?;
    if u.scheme() != "http" || !crate::browser_policy::is_loopback_url(url) {
        return None;
    }
    let host = u.host_str()?.to_string();
    let port = u.port_or_known_default()?;
    u.set_scheme("https").ok()?;
    if u.port().is_none() {
        u.set_port(Some(port)).ok()?;
    }
    Some((u, host, port))
}

/// `url` with https in place of http when it is an http loopback URL whose port speaks TLS, which
/// plain http can never load; any other URL comes back unchanged.
pub fn prefer_tls(url: &str) -> String {
    match as_https(url) {
        Some((https, host, port)) if speaks_tls(&host, port) => https.to_string(),
        _ => url.to_string(),
    }
}

#[tauri::command]
pub async fn browser_prefer_tls(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || prefer_tls(&url))
        .await
        .map_err(|e| e.to_string())
}

/// Probes only https on a loopback host, so the page can't use the core to reach anything else.
#[tauri::command]
pub async fn browser_probe_tls(url: String) -> Result<TlsProbe, String> {
    if !url.starts_with("https:") || !crate::browser_policy::is_loopback_url(&url) {
        return Err("only https on localhost or 127.0.0.1 can be probed".into());
    }
    tauri::async_runtime::spawn_blocking(move || probe(&url))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn certificate_errors_are_untrusted() {
        let cert = rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer);
        let wrapped = std::io::Error::new(std::io::ErrorKind::InvalidData, cert.clone());
        assert_eq!(classify(&ureq::Error::Io(wrapped)), TlsProbe::Untrusted);
        assert_eq!(classify(&ureq::Error::Rustls(cert)), TlsProbe::Untrusted);
    }

    #[test]
    fn https_form_keeps_the_port_and_path() {
        let https = |u: &str| as_https(u).map(|(u, _, _)| u.to_string());
        assert_eq!(
            https("http://localhost:7001/app?x=1").as_deref(),
            Some("https://localhost:7001/app?x=1")
        );
        assert_eq!(
            https("http://127.0.0.1").as_deref(),
            Some("https://127.0.0.1:80/")
        );
        assert_eq!(https("https://localhost:7001/"), None);
        assert_eq!(https("http://example.com/"), None);
        assert_eq!(https("http://a.localhost:3000/"), None);
    }

    const HTTP_400: &[u8] = b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n";

    /// A listener that answers its first read with `reply`, or never answers when it is empty.
    fn server(reply: &'static [u8]) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = s.read(&mut buf);
                if reply.is_empty() {
                    std::thread::sleep(Duration::from_secs(3));
                } else {
                    let _ = s.write_all(reply);
                }
            }
        });
        port
    }

    #[test]
    fn tls_records_mean_tls() {
        assert!(speaks_tls(
            "127.0.0.1",
            server(&[0x16, 0x03, 0x03, 0x00, 0x04])
        ));
        assert!(speaks_tls(
            "127.0.0.1",
            server(&[0x15, 0x03, 0x03, 0x00, 0x02, 2, 40])
        ));
    }

    #[test]
    fn plain_http_and_silence_mean_http() {
        assert!(!speaks_tls("127.0.0.1", server(HTTP_400)));
        assert!(!speaks_tls("127.0.0.1", server(b"")));
        let url = format!("http://127.0.0.1:{}/", server(HTTP_400));
        assert_eq!(prefer_tls(&url), url);
    }

    #[test]
    fn closed_port_is_refused() {
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_eq!(
            probe(&format!("https://127.0.0.1:{port}/")),
            TlsProbe::Refused
        );
    }

    #[test]
    fn plain_http_port_is_not_tls() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut s, _)) = listener.accept() {
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
            }
        });
        assert_eq!(
            probe(&format!("https://127.0.0.1:{port}/")),
            TlsProbe::NotTls
        );
    }
}
