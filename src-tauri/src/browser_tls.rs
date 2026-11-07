//! Why an https loopback page failed to load in Local Browser (docs/design/browser.md section
//! 4.21). Chromium's error page is the only place WebView2 names the cause, so the core repeats
//! the TLS handshake itself, against the Windows certificate store as WebView2 does.

use serde::Serialize;
use std::time::Duration;
use ureq::tls::{RootCerts, TlsConfig};

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
