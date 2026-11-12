//! The Local Browser's loopback file server (docs/design/browser.md section 3.21): two listeners per
//! mount (one for Trusted and Local pages, one for Downloaded pages), per-pane tokens, the request
//! checks in order, the response headers, CSP reports, and the watch on each served file. What each
//! check defends is docs/design/security.md section 9.1.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use notify::RecommendedWatcher;
use serde::Serialize;
use serde_json::Value;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use super::paths::{self, Mount};
use super::trust::{self, Trust};
use super::watch;
use crate::browser::BrowserEvent;
use crate::settings::LocalBrowser;

/// Where `browser-mounts.json` records each mount's ports.
pub const MOUNTS_FILE: &str = "browser-mounts.json";
/// Prefixes a mount's key in `browser-mounts.json` for its Downloaded listener. No canonical
/// absolute path starts with it, so it cannot collide with a shared listener's key.
const DOWNLOADED_PORT_PREFIX: &str = "downloaded:";
const REPORT_PATH: &str = "__csp-report";
const MAX_REPORT: usize = 16 * 1024;
const REPORTS_PER_SECOND: u32 = 100;
/// Live tokens a pane holds at once; serving it a file on another mount or listener past this
/// revokes the one it was served longest ago.
pub const TOKENS_PER_PANE: usize = 20;

/// What the server needs from the app, injected so tests run without one.
pub struct Env {
    /// Sends an event to a pane's channel.
    pub emit: Box<dyn Fn(&str, BrowserEvent) + Send + Sync>,
    /// The current `localBrowser` settings, read per request so an Allow applies on reload.
    pub settings: Box<dyn Fn() -> LocalBrowser + Send + Sync>,
}

pub struct Config {
    /// The user's home folder, which mounts a single file rather than the folder.
    pub home: PathBuf,
    /// `browser-mounts.json`; `None` keeps no ports across launches.
    pub mounts_file: Option<PathBuf>,
    /// The app's dev server port in debug builds. The navigation policy refuses that port on
    /// every loopback host, so a mount listening there could never be shown.
    pub reserved_port: Option<u16>,
}

/// What `browser_serve_file` returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Served {
    /// The serving address of the file.
    pub url: String,
    /// `http://127.0.0.1:<port>/<token>/`.
    pub base: String,
    /// The `localBrowser.allowedHosts` key, without the `\\?\` prefix: the mount folder, or the
    /// file itself on a single-file mount.
    pub folder: String,
    pub trust: Trust,
    /// The file without the `\\?\` prefix.
    pub path: String,
}

struct TokenEntry {
    pane_id: String,
    /// Start of the current one-second report window, and reports in it.
    window: (Instant, u32),
}

/// Which of a mount's two listeners, each its own port and so its own origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Origin {
    /// Trusted and Local pages. Never runs a file with Mark of the Web as a document.
    Shared,
    /// Downloaded pages only, and serves only files with Mark of the Web.
    Downloaded,
}

impl Origin {
    fn for_trust(trust: Trust) -> Self {
        if trust == Trust::Downloaded {
            Origin::Downloaded
        } else {
            Origin::Shared
        }
    }
}

struct Listener {
    mount: Mount,
    origin: Origin,
    port: u16,
    tokens: Mutex<HashMap<String, TokenEntry>>,
}

/// One live token of a pane, on the listener of `key` and `origin`.
struct PaneToken {
    key: PathBuf,
    origin: Origin,
    token: String,
}

#[derive(Default)]
struct PaneReg {
    /// Served longest ago first. A token outlives the page it was minted for, so Back and Forward
    /// into an earlier file page still find it (browser.md section 3.21).
    tokens: Vec<PaneToken>,
    /// The pane's current file page only.
    watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
struct Registry {
    /// Keyed by `Mount::key` and the origin.
    listeners: HashMap<(PathBuf, Origin), Arc<Listener>>,
    panes: HashMap<String, PaneReg>,
    /// The persisted ports, keyed by `port_key`.
    ports: HashMap<String, u16>,
}

fn port_key(key: &Path, origin: Origin) -> String {
    match origin {
        Origin::Shared => plain(key),
        Origin::Downloaded => format!("{DOWNLOADED_PORT_PREFIX}{}", plain(key)),
    }
}

pub struct FileServer {
    env: Arc<Env>,
    config: Config,
    reg: Mutex<Registry>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// A path without the `\\?\` verbatim prefix `canonicalize` adds on Windows.
pub fn plain(p: &Path) -> String {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => rest.to_string(),
        _ => s.into_owned(),
    }
}

/// `file:///C:/a%20b.html` to `C:\a b.html`. A URL with a host becomes a UNC path, which
/// `mount_for` refuses.
pub fn file_url_to_path(url: &str) -> Result<PathBuf, String> {
    let u = tauri::Url::parse(url.trim()).map_err(|e| format!("not a file URL: {e}"))?;
    if u.scheme() != "file" {
        return Err(format!("not a file URL: {url}"));
    }
    u.to_file_path()
        .map_err(|_| format!("not a local file: {url}"))
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("no random token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl FileServer {
    pub fn new(config: Config, env: Env) -> Self {
        let ports = config
            .mounts_file
            .as_deref()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            env: Arc::new(env),
            config,
            reg: Mutex::new(Registry {
                ports,
                ..Default::default()
            }),
        }
    }

    /// Serves `file` to `pane_id` on the listener its trust calls for, mounting its folder if
    /// needed. A file on a mount and listener the pane holds a live token for reuses that token;
    /// anything else mints one, revoking the pane's oldest past `TOKENS_PER_PANE`.
    pub fn serve_file(&self, pane_id: &str, file: &Path) -> Result<Served, String> {
        let mount = paths::mount_for(file, &self.config.home)?;
        let key = mount.key().to_path_buf();
        let settings = (self.env.settings)();
        let trust = trust::trust_level(
            &mount.file,
            trust::zone_id(&mount.file),
            &settings.trusted_folders,
        );
        let origin = Origin::for_trust(trust);

        let mut reg = lock(&self.reg);
        let listener = match reg.listeners.get(&(key.clone(), origin)) {
            Some(l) => l.clone(),
            None => self.bind(&mut reg, origin, mount.clone())?,
        };
        let held = reg.panes.get(pane_id).and_then(|p| {
            p.tokens
                .iter()
                .position(|t| t.key == key && t.origin == origin)
        });
        let token = match held {
            Some(i) => {
                let pane = reg.panes.get_mut(pane_id).expect("held token");
                let t = pane.tokens.remove(i);
                let token = t.token.clone();
                pane.tokens.push(t);
                token
            }
            None => {
                let token = new_token()?;
                lock(&listener.tokens).insert(
                    token.clone(),
                    TokenEntry {
                        pane_id: pane_id.to_string(),
                        window: (Instant::now(), 0),
                    },
                );
                let revoked: Vec<PaneToken> = {
                    let pane = reg.panes.entry(pane_id.to_string()).or_default();
                    pane.tokens.push(PaneToken {
                        key: key.clone(),
                        origin,
                        token: token.clone(),
                    });
                    let excess = pane.tokens.len().saturating_sub(TOKENS_PER_PANE);
                    pane.tokens.drain(..excess).collect()
                };
                for old in revoked {
                    self.revoke(&reg, old);
                }
                token
            }
        };

        let env = self.env.clone();
        let pane = pane_id.to_string();
        let watcher = watch::watch_file(&mount.file, move || {
            (env.emit)(&pane, BrowserEvent::FileChanged)
        })
        .map_err(|e| eprintln!("browser files: cannot watch {}: {e}", mount.file.display()))
        .ok();
        reg.panes.entry(pane_id.to_string()).or_default().watcher = watcher;

        let base = format!("http://127.0.0.1:{}/{token}/", listener.port);
        Ok(Served {
            url: format!("{base}{}", mount.entry_path()),
            base,
            folder: plain(mount.key()),
            trust,
            path: plain(&mount.file),
        })
    }

    /// Stops watching the pane's file once it shows something else. Its tokens stay live.
    pub fn unwatch(&self, pane_id: &str) {
        if let Some(pane) = lock(&self.reg).panes.get_mut(pane_id) {
            pane.watcher = None;
        }
    }

    /// Revokes every token of a closed pane and drops its watch. The mounts keep listening until
    /// the app exits.
    pub fn detach(&self, pane_id: &str) {
        let mut reg = lock(&self.reg);
        if let Some(pane) = reg.panes.remove(pane_id) {
            for t in pane.tokens {
                self.revoke(&reg, t);
            }
        }
    }

    /// The scope of the Downloaded page at `url`, `http://127.0.0.1:<port>/<token>/`, when `url`
    /// is on a Downloaded listener; `None` for any other address. Read from the listeners, not
    /// from anything the page or the pane says. The token need not be live: a page whose token
    /// was revoked keeps running in its frame. Only the Local Browser bridge, which needs
    /// WebView2, asks.
    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn downloaded_scope(&self, url: &str) -> Option<String> {
        let u = tauri::Url::parse(url).ok()?;
        if u.scheme() != "http" || u.host_str() != Some("127.0.0.1") {
            return None;
        }
        let port = u.port()?;
        let downloaded = lock(&self.reg)
            .listeners
            .values()
            .any(|l| l.origin == Origin::Downloaded && l.port == port);
        let token = u.path().strip_prefix('/')?.split('/').next()?;
        downloaded.then(|| format!("http://127.0.0.1:{port}/{token}/"))
    }

    fn revoke(&self, reg: &Registry, t: PaneToken) {
        if let Some(l) = reg.listeners.get(&(t.key, t.origin)) {
            lock(&l.tokens).remove(&t.token);
        }
    }

    fn bind(
        &self,
        reg: &mut Registry,
        origin: Origin,
        mount: Mount,
    ) -> Result<Arc<Listener>, String> {
        let key = mount.key().to_path_buf();
        let name = port_key(&key, origin);
        let wanted = reg
            .ports
            .get(&name)
            .copied()
            .filter(|&p| p != 0 && Some(p) != self.config.reserved_port);
        let server = match wanted.and_then(|p| Server::http(("127.0.0.1", p)).ok()) {
            Some(s) => s,
            None => Server::http("127.0.0.1:0")
                .map_err(|e| format!("could not start the file server: {e}"))?,
        };
        let port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or("the file server has no port")?;
        if reg.ports.get(&name) != Some(&port) {
            reg.ports.insert(name, port);
            self.save_ports(&reg.ports);
        }
        let listener = Arc::new(Listener {
            mount,
            origin,
            port,
            tokens: Mutex::new(HashMap::new()),
        });
        let l = listener.clone();
        let env = self.env.clone();
        thread::spawn(move || {
            for req in server.incoming_requests() {
                let l = l.clone();
                let env = env.clone();
                // A large file must not hold up the page's other requests.
                thread::spawn(move || handle(&l, &env, req));
            }
        });
        reg.listeners.insert((key, origin), listener.clone());
        Ok(listener)
    }

    fn save_ports(&self, ports: &HashMap<String, u16>) {
        let Some(file) = &self.config.mounts_file else {
            return;
        };
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let json = serde_json::to_vec_pretty(ports).unwrap_or_default();
        if let Err(e) = std::fs::write(file, json) {
            eprintln!("browser files: cannot save {}: {e}", file.display());
        }
    }
}

fn header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn handle(l: &Listener, env: &Env, mut req: Request) {
    if header(&req, "Host") != Some(format!("127.0.0.1:{}", l.port).as_str()) {
        return reply(req, 421, None, None);
    }
    let target = req.url().to_string();
    let Some((token, path)) = target
        .strip_prefix('/')
        .and_then(|rest| rest.split_once('/'))
    else {
        return reply(req, 404, None, None);
    };
    if !lock(&l.tokens).contains_key(token) {
        return reply(req, 404, None, None);
    }
    if path.split('?').next() == Some(REPORT_PATH) {
        if *req.method() != Method::Post {
            return reply(req, 405, None, None);
        }
        let status = report(l, env, token, &mut req);
        return reply(req, status, None, None);
    }
    if !matches!(req.method(), Method::Get | Method::Head) {
        return reply(req, 405, None, None);
    }
    let Ok(file) = paths::resolve(&l.mount, path) else {
        return reply(req, 404, None, None);
    };
    let zone = trust::zone_id(&file);
    let marked = matches!(zone, Some(3 | 4));
    let content_type = paths::content_type(&file);
    let refused = match l.origin {
        Origin::Downloaded => !marked,
        Origin::Shared => marked && runs_as_document(content_type, header(&req, "Sec-Fetch-Dest")),
    };
    // A 404 rather than a redirect to the other listener: a redirect would mint a token for
    // whatever asked, including a subframe or a fetch the pane never sees, and leave it live beside
    // the pane's own. Only the pane moves its registration: it sees its frame land on the refused
    // file and serves it again through `serve_file` (browser.md section 4.21).
    // A service worker's own fetches, and the responses it makes up for navigations in its scope,
    // carry no policy of ours, so one would lift a page's egress limit for good.
    if refused || header(&req, "Sec-Fetch-Dest") == Some("serviceworker") {
        return reply(req, 404, None, None);
    }
    let csp = carries_csp(content_type).then(|| {
        let settings = (env.settings)();
        let level = trust::trust_level(&file, zone, &settings.trusted_folders);
        let allowed = allowed_hosts(&settings, l.mount.key());
        trust::csp(level, &settings.cdn_hosts, &allowed, token)
    });
    let opened = std::fs::File::open(&file).and_then(|f| {
        let len = f.metadata()?.len();
        Ok((f, len))
    });
    match opened {
        Ok((f, len)) => reply(
            req,
            200,
            Some((Box::new(f), len as usize, content_type)),
            csp,
        ),
        Err(_) => reply(req, 404, None, None),
    }
}

/// Whether a marked file of `content_type`, fetched for `dest` (`Sec-Fetch-Dest`), could run script
/// as a document in the shared origin, which would hand a Downloaded file the reach of the folder's
/// Trusted and Local pages. HTML, SVG, and XML can all run script once navigated to; SVG loaded as
/// an image cannot, and the browser sets `Sec-Fetch-Dest`, so a page cannot claim `image`. A
/// request without the header counts as a document. Other marked types (scripts, styles, images,
/// fonts) are served: a Local page that loads one has chosen to run it with its own authority.
fn runs_as_document(content_type: &str, dest: Option<&str>) -> bool {
    match content_type {
        "text/html" | "application/xml" => true,
        "image/svg+xml" => dest != Some("image"),
        _ => false,
    }
}

/// Whether a response of `content_type` needs the trust level's CSP. Chromium takes a document's
/// policy from its own response, an SVG or XML document's as much as an HTML one's, and a worker's
/// from its script's, so any of these sent without one could reach every host.
fn carries_csp(content_type: &str) -> bool {
    matches!(
        content_type,
        "text/html" | "image/svg+xml" | "application/xml" | "text/javascript"
    )
}

/// The mount's allowed hosts. Settings keys are what the user or the pane wrote, so each is
/// canonicalized to compare with the (canonical) mount key.
fn allowed_hosts(settings: &LocalBrowser, key: &Path) -> Vec<String> {
    settings
        .allowed_hosts
        .iter()
        .filter(|(folder, _)| std::fs::canonicalize(folder).is_ok_and(|f| f == key))
        .flat_map(|(_, hosts)| hosts.iter().cloned())
        .collect()
}

/// Reads one CSP report and sends the pane an `egressBlocked` per refused URL. Returns the status.
fn report(l: &Listener, env: &Env, token: &str, req: &mut Request) -> u16 {
    if req.body_length().is_some_and(|n| n > MAX_REPORT) {
        return 413;
    }
    let mut body = Vec::new();
    // One byte past the cap, so an undeclared or understated length still trips the limit.
    let _ = req
        .as_reader()
        .take(MAX_REPORT as u64 + 1)
        .read_to_end(&mut body);
    if body.len() > MAX_REPORT {
        return 413;
    }
    let pane_id = {
        let mut tokens = lock(&l.tokens);
        let Some(t) = tokens.get_mut(token) else {
            return 404;
        };
        let now = Instant::now();
        if now.duration_since(t.window.0) >= Duration::from_secs(1) {
            t.window = (now, 0);
        }
        t.window.1 += 1;
        if t.window.1 > REPORTS_PER_SECOND {
            return 429;
        }
        t.pane_id.clone()
    };
    let Ok(json) = serde_json::from_slice::<Value>(&body) else {
        return 400;
    };
    for event in egress_events(&json) {
        (env.emit)(&pane_id, event);
    }
    204
}

/// `report-uri` sends `{"csp-report": {...}}`; the Reporting API sends an array of
/// `{"type": "csp-violation", "body": {...}}` with camelCase keys. Both are read.
fn egress_events(json: &Value) -> Vec<BrowserEvent> {
    let field = |v: &Value, keys: &[&str]| -> String {
        keys.iter()
            .find_map(|k| v[*k].as_str().filter(|s| !s.is_empty()))
            .unwrap_or_default()
            .to_string()
    };
    let one = |r: &Value| {
        egress_event(
            &field(r, &["blocked-uri", "blockedURL"]),
            &field(
                r,
                &[
                    "effective-directive",
                    "effectiveDirective",
                    "violated-directive",
                ],
            ),
        )
    };
    match json {
        Value::Array(items) => items.iter().filter_map(|i| one(&i["body"])).collect(),
        v => one(&v["csp-report"]).into_iter().collect(),
    }
}

/// `None` for a refused URL with no host (`inline`, `eval`, a scheme the policy leaves out).
fn egress_event(blocked: &str, directive: &str) -> Option<BrowserEvent> {
    let url = tauri::Url::parse(blocked).ok()?;
    // A page can post its own report, and a URL host may contain `*`, which in a CSP source is a
    // wildcard: Allow on `*` would let the page reach every host.
    let host = url
        .host_str()
        .filter(|h| !h.is_empty() && !h.contains('*'))?;
    // A CSP host source without a port matches only the scheme's default port.
    let host = match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let directive = directive
        .split_whitespace()
        .next()
        .unwrap_or("default-src")
        .to_string();
    Some(BrowserEvent::EgressBlocked {
        host,
        directive,
        url: blocked.to_string(),
    })
}

type Body = (Box<dyn Read + Send>, usize, &'static str);

/// Sends `status` with the headers every response carries (3.21), and the CSP when given.
/// Nothing here ever sets `Access-Control-Allow-Origin`.
fn reply(req: Request, status: u16, body: Option<Body>, csp: Option<String>) {
    let (reader, len, content_type) =
        body.unwrap_or((Box::new(std::io::empty()), 0, "text/plain; charset=utf-8"));
    let mut headers: Vec<Header> = [
        ("Content-Type", content_type),
        ("X-Content-Type-Options", "nosniff"),
        ("Cross-Origin-Resource-Policy", "same-origin"),
        ("Referrer-Policy", "no-referrer"),
        ("Cache-Control", "no-store"),
    ]
    .iter()
    .filter_map(|(k, v)| Header::from_bytes(k.as_bytes(), v.as_bytes()).ok())
    .collect();
    if let Some(csp) = csp {
        headers.extend(Header::from_bytes(&b"Content-Security-Policy"[..], csp.as_bytes()).ok());
    }
    let response = Response::new(StatusCode(status), headers, reader, Some(len), None);
    let _ = req.respond(response);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::net::TcpStream;

    type Events = Arc<Mutex<Vec<(String, BrowserEvent)>>>;

    struct Harness {
        dir: PathBuf,
        server: FileServer,
        events: Events,
        settings: Arc<Mutex<LocalBrowser>>,
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bashboard-browser-server-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `dir/site/` with `index.html`, `other.html`, `style.css`, `.env`, and `sub/`, beside
    /// `dir/secret.txt`.
    fn harness(tag: &str, mounts_file: Option<PathBuf>, reserved_port: Option<u16>) -> Harness {
        let dir = temp(tag);
        let site = dir.join("site");
        fs::create_dir_all(site.join("sub")).unwrap();
        fs::write(site.join("index.html"), "<p>index</p>").unwrap();
        fs::write(site.join("other.html"), "<p>other</p>").unwrap();
        fs::write(site.join("style.css"), "p{}").unwrap();
        fs::write(site.join(".env"), "SECRET=1").unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        let events: Events = Default::default();
        let settings = Arc::new(Mutex::new(
            crate::settings::Settings::default().local_browser,
        ));
        let (e, s) = (events.clone(), settings.clone());
        let server = FileServer::new(
            Config {
                home: dir.join("home"),
                mounts_file,
                reserved_port,
            },
            Env {
                emit: Box::new(move |pane, ev| lock(&e).push((pane.to_string(), ev))),
                settings: Box::new(move || lock(&s).clone()),
            },
        );
        Harness {
            dir,
            server,
            events,
            settings,
        }
    }

    impl Harness {
        fn site(&self) -> PathBuf {
            self.dir.join("site")
        }
        fn serve(&self, pane: &str, name: &str) -> Served {
            self.server
                .serve_file(pane, &self.site().join(name))
                .unwrap()
        }
    }

    struct Reply {
        status: u16,
        headers: HashMap<String, String>,
        body: String,
    }

    fn port_of(base: &str) -> u16 {
        let rest = base.strip_prefix("http://127.0.0.1:").unwrap();
        rest.split('/').next().unwrap().parse().unwrap()
    }

    fn raw(port: u16, request: &str) -> Reply {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        let _ = s.read_to_end(&mut out);
        let text = String::from_utf8_lossy(&out).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
        let mut lines = head.lines();
        let status = lines
            .next()
            .unwrap_or_default()
            .split(' ')
            .nth(1)
            .unwrap_or("0");
        let headers = lines
            .filter_map(|l| l.split_once(':'))
            .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
            .collect();
        Reply {
            status: status.parse().unwrap(),
            headers,
            body: body.to_string(),
        }
    }

    fn get(port: u16, method: &str, path: &str, host: &str) -> Reply {
        raw(
            port,
            &format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
        )
    }

    fn fetch(served: &Served, path: &str) -> Reply {
        let port = port_of(&served.base);
        let token = served
            .base
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap();
        get(
            port,
            "GET",
            &format!("/{token}/{path}"),
            &format!("127.0.0.1:{port}"),
        )
    }

    fn token_of(served: &Served) -> String {
        served
            .base
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap()
            .to_string()
    }

    fn post_report(served: &Served, body: &str, declared: usize) -> Reply {
        let port = port_of(&served.base);
        raw(
            port,
            &format!(
                "POST /{}/__csp-report HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                 Content-Type: application/csp-report\r\nContent-Length: {declared}\r\n\
                 Connection: close\r\n\r\n{body}",
                token_of(served)
            ),
        )
    }

    fn assert_common_headers(r: &Reply) {
        assert_eq!(
            r.headers.get("x-content-type-options").map(String::as_str),
            Some("nosniff")
        );
        assert_eq!(
            r.headers
                .get("cross-origin-resource-policy")
                .map(String::as_str),
            Some("same-origin")
        );
        assert_eq!(
            r.headers.get("cache-control").map(String::as_str),
            Some("no-store")
        );
        assert_eq!(
            r.headers.get("referrer-policy").map(String::as_str),
            Some("no-referrer")
        );
        assert!(r.headers.contains_key("content-type"));
        assert!(!r.headers.contains_key("access-control-allow-origin"));
    }

    #[cfg(windows)]
    fn mark(file: &Path) {
        fs::write(
            format!("{}:Zone.Identifier", file.display()),
            "[ZoneTransfer]\r\nZoneId=3\r\n",
        )
        .unwrap();
    }

    #[test]
    fn serves_the_file_with_its_url() {
        let h = harness("serve", None, None);
        let served = h.serve("p1", "index.html");
        assert_eq!(served.trust, Trust::Local);
        assert!(served.url.starts_with(&served.base));
        assert!(served.url.ends_with("/index.html"));
        assert_eq!(token_of(&served).len(), 32);
        assert!(token_of(&served).chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!served.folder.starts_with(r"\\?\"));
        assert!(served.path.ends_with("index.html"));
        assert_eq!(
            fs::canonicalize(&served.folder).unwrap(),
            fs::canonicalize(h.site()).unwrap()
        );
        let r = fetch(&served, "index.html");
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "<p>index</p>");
        assert_eq!(r.headers["content-type"], "text/html");
        assert_common_headers(&r);
        let css = fetch(&served, "style.css");
        assert_eq!(css.status, 200);
        assert_eq!(css.headers["content-type"], "text/css");
        assert!(!css.headers.contains_key("content-security-policy"));
        assert_common_headers(&css);
    }

    #[test]
    fn head_has_no_body() {
        let h = harness("head", None, None);
        let served = h.serve("p1", "index.html");
        let port = port_of(&served.base);
        let r = get(
            port,
            "HEAD",
            &format!("/{}/index.html", token_of(&served)),
            &format!("127.0.0.1:{port}"),
        );
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "");
        assert_eq!(r.headers["content-length"], "12");
        assert_common_headers(&r);
    }

    #[test]
    fn wrong_host_is_421() {
        let h = harness("host", None, None);
        let served = h.serve("p1", "index.html");
        let port = port_of(&served.base);
        let path = format!("/{}/index.html", token_of(&served));
        for host in [
            format!("localhost:{port}"),
            "127.0.0.1".to_string(),
            format!("127.0.0.1:{}", port.wrapping_add(1)),
            format!("evil.example:{port}"),
            format!("127.0.0.1:{port}.evil.example"),
        ] {
            let r = get(port, "GET", &path, &host);
            assert_eq!(r.status, 421, "{host}");
            assert_eq!(r.body, "", "{host}");
            assert_common_headers(&r);
        }
    }

    #[test]
    fn unknown_tokens_are_404() {
        let h = harness("token", None, None);
        let served = h.serve("p1", "index.html");
        let port = port_of(&served.base);
        let host = format!("127.0.0.1:{port}");
        for path in [
            "/index.html".to_string(),
            format!("/{}/index.html", "0".repeat(32)),
            format!("/{}", token_of(&served)),
            "/".to_string(),
        ] {
            let r = get(port, "GET", &path, &host);
            assert_eq!(r.status, 404, "{path}");
            assert_common_headers(&r);
        }
        h.server.detach("p1");
        assert_eq!(fetch(&served, "index.html").status, 404);
    }

    #[test]
    fn refused_paths_are_404() {
        let h = harness("paths", None, None);
        let served = h.serve("p1", "index.html");
        for path in [
            ".env",
            "%2eenv",
            "../secret.txt",
            "%2e%2e/secret.txt",
            "sub/..%2f..%2fsecret.txt",
            "sub",
            "sub/",
            "missing.html",
            "index.html:Zone.Identifier",
            "",
        ] {
            let r = fetch(&served, path);
            assert_eq!(r.status, 404, "{path}");
            assert_eq!(r.body, "", "{path}");
            assert_common_headers(&r);
        }
    }

    #[cfg(windows)]
    #[test]
    fn junction_out_of_the_mount_is_404() {
        let h = harness("junction", None, None);
        let outside = h.dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("loot.txt"), "loot").unwrap();
        let link = h.site().join("escape");
        let out = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .unwrap();
        assert!(out.status.success(), "mklink failed: {out:?}");
        let served = h.serve("p1", "index.html");
        assert_eq!(fetch(&served, "escape/loot.txt").status, 404);
        let _ = fs::remove_dir(&link);
    }

    #[test]
    fn only_get_and_head_on_files() {
        let h = harness("methods", None, None);
        let served = h.serve("p1", "index.html");
        let port = port_of(&served.base);
        let host = format!("127.0.0.1:{port}");
        let token = token_of(&served);
        for method in ["POST", "PUT", "DELETE", "OPTIONS"] {
            let r = raw(
                port,
                &format!(
                    "{method} /{token}/index.html HTTP/1.1\r\nHost: {host}\r\n\
                     Content-Length: 0\r\nConnection: close\r\n\r\n"
                ),
            );
            assert_eq!(r.status, 405, "{method}");
            assert_common_headers(&r);
        }
        let r = get(port, "GET", &format!("/{token}/__csp-report"), &host);
        assert_eq!(r.status, 405);
    }

    #[test]
    fn csp_follows_trust_and_allowed_hosts() {
        let h = harness("csp", None, None);
        let site = h.site();
        // A raw, non-canonical key, as the user might type it.
        let raw_key = format!("{}/./", site.display());
        lock(&h.settings)
            .allowed_hosts
            .insert(raw_key, vec!["api.example.com".into()]);
        lock(&h.settings)
            .allowed_hosts
            .insert(h.dir.display().to_string(), vec!["not.this.folder".into()]);
        let served = h.serve("p1", "index.html");
        let token = token_of(&served);
        let r = fetch(&served, "index.html");
        let cdn = lock(&h.settings).cdn_hosts.clone();
        assert_eq!(
            r.headers["content-security-policy"],
            trust::csp(Trust::Local, &cdn, &["api.example.com".into()], &token)
        );
        assert!(!r.headers.contains_key("access-control-allow-origin"));

        lock(&h.settings).trusted_folders = vec![site.display().to_string()];
        let served = h.serve("p1", "other.html");
        assert_eq!(served.trust, Trust::Trusted);
        assert_eq!(token_of(&served), token);
        let r = fetch(&served, "other.html");
        assert_eq!(
            r.headers["content-security-policy"],
            trust::csp(Trust::Trusted, &[], &[], &token)
        );
    }

    #[test]
    fn tokens_are_per_pane_and_per_mount() {
        let h = harness("panes", None, None);
        let a = h.serve("p1", "index.html");
        let again = h.serve("p1", "other.html");
        assert_eq!(a.base, again.base);
        assert!(again.url.ends_with("/other.html"));
        let b = h.serve("p2", "index.html");
        assert_ne!(a.base, b.base);
        assert_eq!(port_of(&a.base), port_of(&b.base));

        fs::write(h.site().join("sub").join("deep.html"), "<p>d</p>").unwrap();
        let moved = h.serve("p1", "sub/deep.html");
        assert_ne!(port_of(&moved.base), port_of(&a.base));
        // The earlier mount's token stays live, so Back into its page still loads.
        assert_eq!(fetch(&a, "index.html").status, 200);
        assert_eq!(fetch(&b, "index.html").status, 200);
        assert_eq!(fetch(&moved, "deep.html").status, 200);
        // A token is only good on its own mount's listener.
        let port = port_of(&moved.base);
        let r = get(
            port,
            "GET",
            &format!("/{}/deep.html", token_of(&b)),
            &format!("127.0.0.1:{port}"),
        );
        assert_eq!(r.status, 404);
    }

    #[cfg(windows)]
    #[test]
    fn downloaded_pages_get_their_own_origin() {
        let h = harness("motw", None, None);
        let site = h.site();
        mark(&site.join("other.html"));
        fs::write(site.join("marked.css"), "p{}").unwrap();
        mark(&site.join("marked.css"));
        // A trusted folder does not lift Mark of the Web.
        lock(&h.settings).trusted_folders = vec![site.display().to_string()];
        let local = h.serve("p1", "index.html");
        assert_eq!(local.trust, Trust::Trusted);
        let down = h.serve("p2", "other.html");
        assert_eq!(down.trust, Trust::Downloaded);
        assert_ne!(port_of(&down.base), port_of(&local.base));
        assert_eq!(down.folder, local.folder);

        let page = fetch(&down, "other.html");
        assert_eq!(page.status, 200);
        assert!(page.headers["content-security-policy"].contains("report-uri"));
        assert_common_headers(&page);
        assert_eq!(fetch(&down, "marked.css").status, 200);
        // The Downloaded listener serves nothing without Mark of the Web.
        assert_eq!(fetch(&down, "style.css").status, 404);
        assert_eq!(fetch(&down, "index.html").status, 404);
        assert_eq!(fetch(&local, "style.css").status, 200);

        // Each token is known only on its own listener.
        let cross = |port: u16, token: &str, file: &str| {
            get(
                port,
                "GET",
                &format!("/{token}/{file}"),
                &format!("127.0.0.1:{port}"),
            )
            .status
        };
        let (lp, dp) = (port_of(&local.base), port_of(&down.base));
        assert_eq!(cross(dp, &token_of(&local), "other.html"), 404);
        assert_eq!(cross(dp, &token_of(&local), "marked.css"), 404);
        assert_eq!(cross(lp, &token_of(&down), "index.html"), 404);
        assert_eq!(cross(lp, &token_of(&down), "style.css"), 404);

        // A second Downloaded page in the folder shares the Downloaded origin.
        let again = h.serve("p3", "other.html");
        assert_eq!(port_of(&again.base), dp);
        assert_ne!(token_of(&again), token_of(&down));
    }

    #[cfg(windows)]
    #[test]
    fn downloaded_scope_names_only_downloaded_listeners() {
        let h = harness("scope", None, None);
        mark(&h.site().join("other.html"));
        let local = h.serve("p1", "index.html");
        let down = h.serve("p2", "other.html");
        assert_eq!(down.trust, Trust::Downloaded);
        assert_eq!(
            h.server
                .downloaded_scope(&format!("{}other.html#x", down.base)),
            Some(down.base.clone())
        );
        // Any token on the listener: the page in the frame, not the token's state, decides.
        let dp = port_of(&down.base);
        assert_eq!(
            h.server
                .downloaded_scope(&format!("http://127.0.0.1:{dp}/stale/a.html"))
                .as_deref(),
            Some(format!("http://127.0.0.1:{dp}/stale/").as_str())
        );
        assert_eq!(h.server.downloaded_scope(&local.url), None);
        assert_eq!(
            h.server
                .downloaded_scope(&format!("http://localhost:{dp}/x/a.html")),
            None
        );
        assert_eq!(
            h.server.downloaded_scope("http://127.0.0.1:1/x/a.html"),
            None
        );
        assert_eq!(h.server.downloaded_scope("not a url"), None);
    }

    #[cfg(windows)]
    #[test]
    fn downloaded_pages_never_name_a_loopback_host() {
        let h = harness("loopback", None, None);
        let site = h.site();
        mark(&site.join("other.html"));
        {
            let mut s = lock(&h.settings);
            s.cdn_hosts.push("localhost:5173".into());
            s.allowed_hosts.insert(
                site.display().to_string(),
                vec!["127.0.0.1:3000".into(), "api.example.com".into()],
            );
        }
        let local = fetch(&h.serve("p1", "index.html"), "index.html");
        let policy = &local.headers["content-security-policy"];
        assert!(policy.contains(" localhost:5173 "), "{policy}");
        assert!(policy.contains(" 127.0.0.1:3000 "), "{policy}");

        let down = h.serve("p2", "other.html");
        assert_eq!(down.trust, Trust::Downloaded);
        let policy = &fetch(&down, "other.html").headers["content-security-policy"];
        assert!(!policy.contains("localhost"), "{policy}");
        assert!(!policy.contains("127.0.0.1"), "{policy}");
        assert!(policy.contains(" api.example.com;"), "{policy}");
    }

    #[cfg(windows)]
    #[test]
    fn shared_listener_never_runs_a_marked_document() {
        let h = harness("motw-shared", None, None);
        let site = h.site();
        for (name, body) in [
            ("other.html", "<p>other</p>"),
            ("marked.svg", "<svg/>"),
            ("marked.xml", "<x/>"),
            ("marked.js", "1"),
            ("marked.png", "png"),
        ] {
            let file = site.join(name);
            if name != "other.html" {
                fs::write(&file, body).unwrap();
            }
            mark(&file);
        }
        let local = h.serve("p1", "index.html");
        assert_eq!(local.trust, Trust::Local);
        let port = port_of(&local.base);
        let with_dest = |file: &str, dest: Option<&str>| {
            let extra = dest
                .map(|d| format!("Sec-Fetch-Dest: {d}\r\n"))
                .unwrap_or_default();
            raw(
                port,
                &format!(
                    "GET /{}/{file} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}\
                     Connection: close\r\n\r\n",
                    token_of(&local)
                ),
            )
            .status
        };
        for dest in [
            None,
            Some("document"),
            Some("iframe"),
            Some("empty"),
            Some("image"),
        ] {
            assert_eq!(with_dest("other.html", dest), 404, "html {dest:?}");
            assert_eq!(with_dest("marked.xml", dest), 404, "xml {dest:?}");
        }
        for dest in [None, Some("document"), Some("iframe"), Some("embed")] {
            assert_eq!(with_dest("marked.svg", dest), 404, "svg {dest:?}");
        }
        assert_eq!(with_dest("marked.svg", Some("image")), 200);
        // A marked script or image runs with the Local page's own authority, by its choice.
        assert_eq!(with_dest("marked.js", Some("script")), 200);
        assert_eq!(with_dest("marked.png", Some("image")), 200);
        assert_eq!(with_dest("index.html", Some("iframe")), 200);
    }

    #[test]
    fn script_capable_responses_carry_the_csp() {
        let h = harness("csp-types", None, None);
        let site = h.site();
        fs::write(site.join("pic.svg"), "<svg/>").unwrap();
        fs::write(site.join("data.xml"), "<x/>").unwrap();
        fs::write(site.join("worker.js"), "1").unwrap();
        let served = h.serve("p1", "index.html");
        let cdn = lock(&h.settings).cdn_hosts.clone();
        let policy = trust::csp(Trust::Local, &cdn, &[], &token_of(&served));
        for name in ["index.html", "pic.svg", "data.xml", "worker.js"] {
            let r = fetch(&served, name);
            assert_eq!(r.status, 200, "{name}");
            assert_eq!(
                r.headers.get("content-security-policy"),
                Some(&policy),
                "{name}"
            );
        }
        assert!(!fetch(&served, "style.css")
            .headers
            .contains_key("content-security-policy"));
    }

    #[cfg(windows)]
    #[test]
    fn a_marked_svg_document_carries_the_downloaded_csp() {
        let h = harness("csp-svg-down", None, None);
        let site = h.site();
        mark(&site.join("other.html"));
        fs::write(site.join("pic.svg"), "<svg/>").unwrap();
        mark(&site.join("pic.svg"));
        let down = h.serve("p1", "other.html");
        let r = fetch(&down, "pic.svg");
        assert_eq!(r.status, 200);
        assert!(r.headers["content-security-policy"].starts_with("default-src 'self'"));
    }

    #[test]
    fn service_worker_scripts_are_refused() {
        let h = harness("sw", None, None);
        fs::write(h.site().join("sw.js"), "1").unwrap();
        let served = h.serve("p1", "index.html");
        let port = port_of(&served.base);
        let with_dest = |dest: &str| {
            raw(
                port,
                &format!(
                    "GET /{}/sw.js HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
                     Sec-Fetch-Dest: {dest}\r\nConnection: close\r\n\r\n",
                    token_of(&served)
                ),
            )
            .status
        };
        assert_eq!(with_dest("serviceworker"), 404);
        assert_eq!(with_dest("worker"), 200);
        assert_eq!(with_dest("script"), 200);
    }

    #[cfg(windows)]
    #[test]
    fn serving_a_sibling_of_another_trust_moves_the_pane() {
        let h = harness("motw-move", None, None);
        mark(&h.site().join("other.html"));
        let local = h.serve("p1", "index.html");
        let down = h.serve("p1", "other.html");
        assert_eq!(down.trust, Trust::Downloaded);
        assert_ne!(port_of(&down.base), port_of(&local.base));
        assert_ne!(token_of(&down), token_of(&local));
        assert!(down.url.ends_with("/other.html"));
        assert_eq!(fetch(&local, "index.html").status, 200);
        assert_eq!(fetch(&down, "other.html").status, 200);

        // Back to the Local page reuses its live token rather than minting one.
        let back = h.serve("p1", "index.html");
        assert_eq!(back.base, local.base);
        assert_eq!(fetch(&down, "other.html").status, 200);
        assert_eq!(fetch(&back, "index.html").status, 200);
        // Neither token is known on the other listener, and each listener keeps its own rule.
        let cross = |served: &Served, token: &str, file: &str| {
            let port = port_of(&served.base);
            get(
                port,
                "GET",
                &format!("/{token}/{file}"),
                &format!("127.0.0.1:{port}"),
            )
            .status
        };
        assert_eq!(cross(&down, &token_of(&local), "other.html"), 404);
        assert_eq!(cross(&local, &token_of(&down), "index.html"), 404);
        assert_eq!(fetch(&down, "index.html").status, 404);
        assert_eq!(fetch(&local, "other.html").status, 404);
    }

    #[cfg(windows)]
    #[test]
    fn downloaded_ports_persist_and_fall_back() {
        let dir = temp("ports-downloaded");
        let mounts = dir.join(MOUNTS_FILE);
        let h = harness("ports-dl", Some(mounts.clone()), None);
        mark(&h.site().join("other.html"));
        let down = h.serve("p1", "other.html");
        let saved: HashMap<String, u16> =
            serde_json::from_slice(&fs::read(&mounts).unwrap()).unwrap();
        let key = format!("{DOWNLOADED_PORT_PREFIX}{}", down.folder);
        assert_eq!(saved.get(&key), Some(&port_of(&down.base)));
        // Created only when needed: no Trusted or Local page has opened here.
        assert!(!saved.contains_key(&down.folder), "{saved:?}");

        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = held.local_addr().unwrap().port();
        let reopen = |port: u16, reserved: Option<u16>| {
            fs::write(
                &mounts,
                serde_json::to_vec(&HashMap::from([(key.clone(), port)])).unwrap(),
            )
            .unwrap();
            let server = FileServer::new(
                Config {
                    home: h.dir.join("home"),
                    mounts_file: Some(mounts.clone()),
                    reserved_port: reserved,
                },
                Env {
                    emit: Box::new(|_, _| {}),
                    settings: Box::new(|| crate::settings::Settings::default().local_browser),
                },
            );
            let served = server
                .serve_file("p1", &h.site().join("other.html"))
                .unwrap();
            (port_of(&served.base), served)
        };
        assert_eq!(reopen(free, None).0, free);
        let (port, served) = reopen(taken, None);
        assert_ne!(port, taken);
        assert_eq!(fetch(&served, "other.html").status, 200);
        drop(held);
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        assert_ne!(reopen(free, Some(free)).0, free);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn csp_reports_become_events() {
        let h = harness("report", None, None);
        let served = h.serve("p1", "index.html");
        let body = r#"{"csp-report":{"document-uri":"http://127.0.0.1/x","blocked-uri":"https://evil.example:8443/leak?d=1","violated-directive":"connect-src","effective-directive":"connect-src","original-policy":"..."}}"#;
        let r = post_report(&served, body, body.len());
        assert_eq!(r.status, 204);
        assert_common_headers(&r);
        let inline =
            r#"{"csp-report":{"blocked-uri":"inline","violated-directive":"script-src-elem"}}"#;
        assert_eq!(post_report(&served, inline, inline.len()).status, 204);
        assert_eq!(
            *lock(&h.events),
            vec![(
                "p1".to_string(),
                BrowserEvent::EgressBlocked {
                    host: "evil.example:8443".into(),
                    directive: "connect-src".into(),
                    url: "https://evil.example:8443/leak?d=1".into(),
                }
            )]
        );
        assert_eq!(post_report(&served, "not json", 8).status, 400);
    }

    #[test]
    fn forged_wildcard_hosts_are_not_reported() {
        let h = harness("wildcard", None, None);
        let served = h.serve("p1", "index.html");
        for blocked in ["https://*/x", "https://*.com/x", "https://a*b.example/"] {
            let body = format!(
                r#"{{"csp-report":{{"blocked-uri":"{blocked}","effective-directive":"connect-src"}}}}"#
            );
            assert_eq!(post_report(&served, &body, body.len()).status, 204);
        }
        assert!(lock(&h.events).is_empty());
    }

    #[test]
    fn marked_documents_are_the_script_capable_types() {
        for dest in [None, Some("document"), Some("iframe"), Some("image")] {
            assert!(runs_as_document("text/html", dest), "{dest:?}");
            assert!(runs_as_document("application/xml", dest), "{dest:?}");
        }
        assert!(runs_as_document("image/svg+xml", None));
        assert!(runs_as_document("image/svg+xml", Some("iframe")));
        assert!(!runs_as_document("image/svg+xml", Some("image")));
        for ct in ["text/javascript", "text/css", "image/png", "font/woff2"] {
            assert!(!runs_as_document(ct, None), "{ct}");
        }
    }

    #[test]
    fn reporting_api_bodies_are_read() {
        let json: Value = serde_json::from_str(
            r#"[{"type":"csp-violation","body":{"blockedURL":"https://a.example/x","effectiveDirective":"img-src"}}]"#,
        )
        .unwrap();
        assert_eq!(
            egress_events(&json),
            vec![BrowserEvent::EgressBlocked {
                host: "a.example".into(),
                directive: "img-src".into(),
                url: "https://a.example/x".into(),
            }]
        );
    }

    #[test]
    fn oversize_reports_are_refused() {
        let h = harness("oversize", None, None);
        let served = h.serve("p1", "index.html");
        let big = format!(
            r#"{{"csp-report":{{"blocked-uri":"https://a.example/{}"}}}}"#,
            "x".repeat(MAX_REPORT)
        );
        assert_eq!(post_report(&served, &big, big.len()).status, 413);
        // A declared length past the cap is refused before the body is read.
        assert_eq!(post_report(&served, "", MAX_REPORT + 1).status, 413);
        assert!(lock(&h.events).is_empty());
    }

    #[test]
    fn reports_are_rate_limited_per_token() {
        let h = harness("rate", None, None);
        let served = h.serve("p1", "index.html");
        let other = h.serve("p2", "index.html");
        let body = r#"{"csp-report":{"blocked-uri":"https://a.example/","effective-directive":"img-src"}}"#;
        let statuses: Vec<u16> = (0..REPORTS_PER_SECOND + 5)
            .map(|_| post_report(&served, body, body.len()).status)
            .collect();
        // Some reports may straddle a window boundary on a slow machine, but never all 105 pass.
        assert!(statuses.contains(&429), "{statuses:?}");
        assert_eq!(post_report(&other, body, body.len()).status, 204);
    }

    #[test]
    fn ports_persist_and_are_reused() {
        let dir = temp("ports-file");
        let mounts = dir.join(MOUNTS_FILE);
        let h = harness("ports", Some(mounts.clone()), None);
        let first = h.serve("p1", "index.html");
        let saved: HashMap<String, u16> =
            serde_json::from_slice(&fs::read(&mounts).unwrap()).unwrap();
        assert_eq!(saved.get(&first.folder), Some(&port_of(&first.base)));

        // A port free now, as the next launch would find its recorded one.
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let h2 = harness("ports2", Some(mounts.clone()), None);
        let folder = plain(&fs::canonicalize(h2.site()).unwrap());
        fs::write(
            &mounts,
            serde_json::to_vec(&HashMap::from([(folder.clone(), free)])).unwrap(),
        )
        .unwrap();
        let h2 = FileServer::new(
            Config {
                home: h2.dir.join("home"),
                mounts_file: Some(mounts.clone()),
                reserved_port: None,
            },
            Env {
                emit: Box::new(|_, _| {}),
                settings: Box::new(|| crate::settings::Settings::default().local_browser),
            },
        );
        let site2 = fs::canonicalize(&folder).unwrap();
        let served = h2.serve_file("p1", &site2.join("index.html")).unwrap();
        assert_eq!(port_of(&served.base), free);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn taken_and_reserved_ports_fall_back() {
        let dir = temp("ports-taken");
        let mounts = dir.join(MOUNTS_FILE);
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let taken = held.local_addr().unwrap().port();
        let h = harness("taken", Some(mounts.clone()), None);
        let folder = plain(&fs::canonicalize(h.site()).unwrap());
        fs::write(
            &mounts,
            serde_json::to_vec(&HashMap::from([(folder, taken)])).unwrap(),
        )
        .unwrap();
        let h = harness("taken", Some(mounts.clone()), None);
        let served = h.serve("p1", "index.html");
        assert_ne!(port_of(&served.base), taken);
        assert_eq!(fetch(&served, "index.html").status, 200);
        drop(held);

        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let h = harness("reserved", Some(mounts.clone()), Some(free));
        let folder = plain(&fs::canonicalize(h.site()).unwrap());
        fs::write(
            &mounts,
            serde_json::to_vec(&HashMap::from([(folder, free)])).unwrap(),
        )
        .unwrap();
        let h = harness("reserved", Some(mounts), Some(free));
        assert_ne!(port_of(&h.serve("p1", "index.html").base), free);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn home_folder_files_are_separate_mounts() {
        let h = harness("home", None, None);
        let home = h.dir.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("a.html"), "a").unwrap();
        fs::write(home.join("b.html"), "b").unwrap();
        let a = h.server.serve_file("p1", &home.join("a.html")).unwrap();
        let b = h.server.serve_file("p2", &home.join("b.html")).unwrap();
        assert_ne!(port_of(&a.base), port_of(&b.base));
        assert_eq!(fetch(&a, "a.html").status, 200);
        assert_eq!(fetch(&a, "b.html").status, 404);
        assert_eq!(fetch(&b, "b.html").status, 200);
    }

    #[test]
    fn single_file_mounts_key_allowed_hosts_by_the_file() {
        let h = harness("home-hosts", None, None);
        let home = h.dir.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("a.html"), "a").unwrap();
        fs::write(home.join("b.html"), "b").unwrap();
        {
            let mut s = lock(&h.settings);
            s.allowed_hosts.insert(
                home.join("a.html").display().to_string(),
                vec!["a.example".into()],
            );
            s.allowed_hosts
                .insert(home.display().to_string(), vec!["home.example".into()]);
        }
        let a = h.server.serve_file("p1", &home.join("a.html")).unwrap();
        let b = h.server.serve_file("p2", &home.join("b.html")).unwrap();
        assert_eq!(a.folder, a.path);
        assert_eq!(
            fs::canonicalize(&a.folder).unwrap(),
            fs::canonicalize(home.join("a.html")).unwrap()
        );
        let csp_a = &fetch(&a, "a.html").headers["content-security-policy"];
        assert!(csp_a.contains("a.example"), "{csp_a}");
        assert!(!csp_a.contains("home.example"), "{csp_a}");
        let csp_b = &fetch(&b, "b.html").headers["content-security-policy"];
        assert!(!csp_b.contains("a.example"), "{csp_b}");
        assert!(!csp_b.contains("home.example"), "{csp_b}");

        // A folder mount keeps the folder as its key.
        let site = h.serve("p3", "index.html");
        assert_ne!(site.folder, site.path);
        assert_eq!(
            fs::canonicalize(&site.folder).unwrap(),
            fs::canonicalize(h.site()).unwrap()
        );
    }

    #[test]
    fn file_changes_reach_the_pane() {
        let h = harness("changed", None, None);
        h.serve("p1", "index.html");
        thread::sleep(Duration::from_millis(100));
        fs::write(h.site().join("index.html"), "<p>new</p>").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if lock(&h.events)
                .iter()
                .any(|e| *e == ("p1".to_string(), BrowserEvent::FileChanged))
            {
                h.server.detach("p1");
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("no fileChanged event");
    }

    #[test]
    fn tokens_outlive_leaving_the_page() {
        let h = harness("lifetime", None, None);
        let a = h.serve("p1", "index.html");
        h.server.unwatch("p1");
        assert_eq!(fetch(&a, "index.html").status, 200);
        let again = h.serve("p1", "other.html");
        assert_eq!(again.base, a.base);

        let home = h.dir.join("home");
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("x.html"), "x").unwrap();
        let elsewhere = h.server.serve_file("p1", &home.join("x.html")).unwrap();
        assert_ne!(elsewhere.base, a.base);
        assert_eq!(fetch(&a, "index.html").status, 200);
        assert_eq!(fetch(&elsewhere, "x.html").status, 200);
        assert_eq!(h.serve("p1", "index.html").base, a.base);
    }

    #[test]
    fn the_token_cap_revokes_the_oldest() {
        let h = harness("cap", None, None);
        let home = h.dir.join("home");
        fs::create_dir_all(&home).unwrap();
        // Each home-folder file is its own mount, so each needs a token of its own.
        let served: Vec<Served> = (0..=TOKENS_PER_PANE)
            .map(|i| {
                let file = home.join(format!("f{i}.html"));
                fs::write(&file, "f").unwrap();
                h.server.serve_file("p1", &file).unwrap()
            })
            .collect();
        assert_eq!(fetch(&served[0], "f0.html").status, 404);
        for (i, s) in served.iter().enumerate().skip(1) {
            assert_eq!(fetch(s, &format!("f{i}.html")).status, 200, "f{i}");
        }
        // Serving an old mount again counts as its newest use, so the next new one revokes f2.
        h.server.serve_file("p1", &home.join("f1.html")).unwrap();
        let next = home.join("next.html");
        fs::write(&next, "n").unwrap();
        h.server.serve_file("p1", &next).unwrap();
        assert_eq!(fetch(&served[1], "f1.html").status, 200);
        assert_eq!(fetch(&served[2], "f2.html").status, 404);
    }

    #[test]
    fn detach_revokes_every_token() {
        let h = harness("detach", None, None);
        let a = h.serve("p1", "index.html");
        fs::write(h.site().join("sub").join("deep.html"), "<p>d</p>").unwrap();
        let b = h.serve("p1", "sub/deep.html");
        let other = h.serve("p2", "index.html");
        h.server.detach("p1");
        assert_eq!(fetch(&a, "index.html").status, 404);
        assert_eq!(fetch(&b, "deep.html").status, 404);
        assert_eq!(fetch(&other, "index.html").status, 200);
        // A reopened pane id starts over with a fresh token.
        assert_ne!(h.serve("p1", "index.html").base, a.base);
    }

    #[test]
    fn reports_on_an_old_token_reach_its_pane() {
        let h = harness("report-old", None, None);
        let a = h.serve("p1", "index.html");
        fs::write(h.site().join("sub").join("deep.html"), "<p>d</p>").unwrap();
        h.serve("p1", "sub/deep.html");
        h.serve("p2", "index.html");
        let body = r#"{"csp-report":{"blocked-uri":"https://a.example/","effective-directive":"img-src"}}"#;
        assert_eq!(post_report(&a, body, body.len()).status, 204);
        let events = lock(&h.events);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, "p1");
    }

    #[test]
    fn file_urls() {
        let dir = fs::canonicalize(temp("urls")).unwrap();
        let file = dir.join("a b.html");
        let url = tauri::Url::from_file_path(&file).unwrap().to_string();
        assert!(url.contains("a%20b.html"));
        assert_eq!(
            fs::canonicalize(file_url_to_path(&url).unwrap().parent().unwrap()).unwrap(),
            dir
        );
        assert!(file_url_to_path("http://127.0.0.1/a.html").is_err());
        assert!(file_url_to_path("not a url").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
