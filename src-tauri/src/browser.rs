//! Local Browser bridge (docs/design/browser.md section 4.21): drives each Local Browser iframe
//! over the WebView2 DevTools Protocol through the host API, so nothing is injected into the
//! framed page. The main session auto-attaches every out-of-process iframe as its own session;
//! a session whose frame is owned by a `data-browser-pane` iframe is bound to that pane and its
//! events are translated into `BrowserEvent`s on the pane's channel.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

use crate::browser_policy::{self, UrlClass};

mod chords;

/// Console and exception text beyond this many bytes is cut, so one huge log line can't flood
/// the channel.
const MAX_TEXT: usize = 10 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BrowserEvent {
    Navigated {
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    NavigatedInPage {
        url: String,
    },
    Title {
        title: String,
    },
    Blocked {
        url: String,
        external: bool,
    },
    Console {
        level: String,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u64>,
        timestamp: f64,
    },
    Exception {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u64>,
        timestamp: f64,
    },
    Request {
        request_id: String,
        url: String,
        method: String,
        resource_type: String,
        timestamp: f64,
    },
    Response {
        request_id: String,
        status: u64,
        status_text: String,
        mime_type: String,
        headers: Value,
        timestamp: f64,
    },
    Finished {
        request_id: String,
        encoded_length: f64,
        timestamp: f64,
    },
    Failed {
        request_id: String,
        error_text: String,
        canceled: bool,
        timestamp: f64,
    },
    LoadState {
        loading: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct ResponseBody {
    pub body: String,
    pub base64: bool,
}

/// One attached iframe session bound to a pane.
#[derive(Debug, Clone)]
struct Binding {
    pane_id: String,
    /// The OOPIF's root frame id, which equals its target id.
    frame_id: String,
    /// Wall clock minus CDP's monotonic network clock, in ms, learned from `requestWillBeSent`.
    clock_offset_ms: Option<f64>,
    /// A hard reload turned the cache off; turn it back on once the page stops loading.
    restore_cache: bool,
    /// A navigation the frame asked for that policy refuses, already reported as `Blocked`.
    blocked: Option<String>,
    /// The frame is on the error page a blocked navigation left and is going back.
    restoring: bool,
}

#[derive(Default)]
struct Registry {
    sessions: HashMap<String, Binding>,
    channels: HashMap<String, Channel<BrowserEvent>>,
    focused: Option<String>,
}

impl Registry {
    fn session_for_pane(&self, pane_id: &str) -> Option<String> {
        self.sessions
            .iter()
            .find(|(_, b)| b.pane_id == pane_id)
            .map(|(s, _)| s.clone())
    }

    /// True, and forgotten, when the pane's frame already reported `url` as blocked, so the
    /// Fetch path does not report the same navigation twice.
    fn take_blocked(&mut self, pane_id: &str, url: &str) -> bool {
        self.sessions
            .values_mut()
            .filter(|b| b.pane_id == pane_id)
            .any(|b| {
                let hit = b
                    .blocked
                    .as_deref()
                    .is_some_and(|u| without_fragment(u) == without_fragment(url));
                if hit {
                    b.blocked = None;
                }
                hit
            })
    }
}

#[derive(Default, Clone)]
pub struct BrowserState(Arc<Mutex<Registry>>);

impl BrowserState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The pane whose frame holds keyboard focus, if any. A pane that has detached no longer
    /// counts, so a focus report that raced its pane's disposal cannot claim keys.
    pub fn focused_pane_attached(&self) -> Option<String> {
        let reg = self.lock();
        reg.focused.clone().filter(|p| reg.channels.contains_key(p))
    }

    fn emit(&self, pane_id: &str, event: BrowserEvent) {
        let channel = self.lock().channels.get(pane_id).cloned();
        if let Some(channel) = channel {
            let _ = channel.send(event);
        }
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn cap(mut text: String) -> String {
    if text.len() > MAX_TEXT {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("...");
    }
    text
}

fn str_of(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

/// CDP line numbers are zero-based.
fn line_of(v: &Value) -> Option<u64> {
    v.as_u64().map(|n| n + 1)
}

fn console_level(kind: &str) -> &'static str {
    match kind {
        "warning" => "warn",
        "error" | "assert" => "error",
        "info" => "info",
        "debug" => "debug",
        _ => "log",
    }
}

fn format_arg(arg: &Value) -> String {
    if let Some(s) = arg["value"].as_str() {
        return s.to_string();
    }
    if !arg["value"].is_null() {
        return arg["value"].to_string();
    }
    if let Some(d) = arg["description"].as_str() {
        return d.to_string();
    }
    match arg["type"].as_str() {
        Some("undefined") => "undefined".into(),
        Some(t) => t.to_string(),
        None => String::new(),
    }
}

/// Converts a CDP network `MonotonicTime` (seconds) to ms since the Unix epoch.
fn network_ms(binding: &Binding, monotonic: &Value) -> f64 {
    match (binding.clock_offset_ms, monotonic.as_f64()) {
        (Some(offset), Some(t)) => t * 1000.0 + offset,
        _ => now_ms(),
    }
}

fn without_fragment(url: &str) -> &str {
    url.split('#').next().unwrap_or(url)
}

/// What the bridge does about a navigation event on a pane's own frame.
#[derive(Debug, PartialEq)]
enum Police {
    Pass,
    Block {
        url: String,
        external: bool,
    },
    /// The frame committed the error page of a blocked navigation; send it back.
    Restore,
}

/// The app's CSP `frame-src` rejects a non-loopback navigation before any request exists, so
/// Fetch never sees it and the frame commits an error page. `frameRequestedNavigation` comes
/// first, which is where such a navigation is reported; the error page it leaves is then undone.
fn police(method: &str, p: &Value, binding: &mut Binding, app_origin: Option<&str>) -> Police {
    let root = |frame_id: &Value| frame_id.as_str() == Some(binding.frame_id.as_str());
    match method {
        "Page.frameRequestedNavigation"
            if root(&p["frameId"]) && p["disposition"].as_str() == Some("currentTab") =>
        {
            let url = str_of(&p["url"]);
            match browser_policy::classify(&url, app_origin) {
                UrlClass::Allowed => {
                    binding.blocked = None;
                    Police::Pass
                }
                class => {
                    binding.blocked = Some(url.clone());
                    Police::Block {
                        url,
                        external: class == UrlClass::External,
                    }
                }
            }
        }
        "Page.frameNavigated" if root(&p["frame"]["id"]) => {
            let error_page = p["frame"]["url"]
                .as_str()
                .is_some_and(|u| u.starts_with("chrome-error:"));
            if error_page && binding.blocked.take().is_some() {
                binding.restoring = true;
                return Police::Restore;
            }
            binding.blocked = None;
            binding.restoring = false;
            Police::Pass
        }
        _ => Police::Pass,
    }
}

/// Translates one child-session CDP event into the events the pane sees. Page events count only
/// for the session's root frame, not frames nested inside the framed page.
fn translate(method: &str, p: &Value, binding: &mut Binding) -> Vec<BrowserEvent> {
    let root = |frame_id: &Value| frame_id.as_str() == Some(binding.frame_id.as_str());
    match method {
        "Page.frameNavigated" if root(&p["frame"]["id"]) => {
            vec![BrowserEvent::Navigated {
                url: str_of(&p["frame"]["url"]),
                title: None,
            }]
        }
        "Page.navigatedWithinDocument" if root(&p["frameId"]) => {
            vec![BrowserEvent::NavigatedInPage {
                url: str_of(&p["url"]),
            }]
        }
        "Page.frameStartedLoading" if root(&p["frameId"]) => {
            vec![BrowserEvent::LoadState { loading: true }]
        }
        "Page.frameStoppedLoading" if root(&p["frameId"]) => {
            vec![BrowserEvent::LoadState { loading: false }]
        }
        "Runtime.consoleAPICalled" => {
            let text = p["args"]
                .as_array()
                .map(|a| a.iter().map(format_arg).collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            let frame = &p["stackTrace"]["callFrames"][0];
            vec![BrowserEvent::Console {
                level: console_level(p["type"].as_str().unwrap_or("log")).into(),
                text: cap(text),
                source: Some("console-api".into()),
                url: opt_str(&frame["url"]),
                line: line_of(&frame["lineNumber"]),
                timestamp: p["timestamp"].as_f64().unwrap_or_else(now_ms),
            }]
        }
        "Runtime.exceptionThrown" => {
            let d = &p["exceptionDetails"];
            let text = opt_str(&d["exception"]["description"])
                .or_else(|| opt_str(&d["text"]))
                .unwrap_or_default();
            vec![BrowserEvent::Exception {
                text: cap(text),
                url: opt_str(&d["url"]),
                line: line_of(&d["lineNumber"]),
                timestamp: p["timestamp"].as_f64().unwrap_or_else(now_ms),
            }]
        }
        "Network.requestWillBeSent" => {
            if let (Some(wall), Some(mono)) = (p["wallTime"].as_f64(), p["timestamp"].as_f64()) {
                binding.clock_offset_ms = Some(wall * 1000.0 - mono * 1000.0);
            }
            vec![BrowserEvent::Request {
                request_id: str_of(&p["requestId"]),
                url: str_of(&p["request"]["url"]),
                method: str_of(&p["request"]["method"]),
                resource_type: p["type"].as_str().unwrap_or("Other").to_string(),
                timestamp: network_ms(binding, &p["timestamp"]),
            }]
        }
        "Network.responseReceived" => {
            let r = &p["response"];
            vec![BrowserEvent::Response {
                request_id: str_of(&p["requestId"]),
                status: r["status"].as_f64().unwrap_or(0.0) as u64,
                status_text: str_of(&r["statusText"]),
                mime_type: str_of(&r["mimeType"]),
                headers: if r["headers"].is_object() {
                    r["headers"].clone()
                } else {
                    Value::Object(Default::default())
                },
                timestamp: network_ms(binding, &p["timestamp"]),
            }]
        }
        "Network.loadingFinished" => vec![BrowserEvent::Finished {
            request_id: str_of(&p["requestId"]),
            encoded_length: p["encodedDataLength"].as_f64().unwrap_or(0.0),
            timestamp: network_ms(binding, &p["timestamp"]),
        }],
        "Network.loadingFailed" => vec![BrowserEvent::Failed {
            request_id: str_of(&p["requestId"]),
            error_text: str_of(&p["errorText"]),
            canceled: p["canceled"].as_bool().unwrap_or(false),
            timestamp: network_ms(binding, &p["timestamp"]),
        }],
        _ => Vec::new(),
    }
}

/// Reads `data-browser-pane` from a `DOM.describeNode` result, only for an iframe element.
fn pane_from_node(described: &Value) -> Option<String> {
    let node = &described["node"];
    if !node["nodeName"]
        .as_str()
        .is_some_and(|n| n.eq_ignore_ascii_case("iframe"))
    {
        return None;
    }
    let attrs = node["attributes"].as_array()?;
    attrs
        .chunks(2)
        .find(|kv| kv[0].as_str() == Some("data-browser-pane"))
        .and_then(|kv| kv.get(1)?.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[cfg(windows)]
pub use win::init;

#[cfg(windows)]
mod win {
    use super::*;
    use std::rc::Rc;
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2DevToolsProtocolEventReceivedEventArgs2, ICoreWebView2_11,
    };
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler, DevToolsProtocolEventReceivedEventHandler,
    };
    use windows::core::{HSTRING, PWSTR};
    use windows_core::Interface;

    /// The main session is the empty session id.
    const MAIN: &str = "";

    /// Request stage enforces the navigation policy; response stage unframes loopback documents.
    const FETCH_PATTERNS: &str = r#"{"patterns":[{"urlPattern":"*","requestStage":"Request","resourceType":"Document"},{"urlPattern":"*","requestStage":"Response","resourceType":"Document"}]}"#;

    type Then = Box<dyn FnOnce(Result<Value, String>)>;

    pub(super) fn call(core: &ICoreWebView2, session: &str, method: &str, params: Value) {
        call_then(core, session, method, params, Box::new(|_| {}));
    }

    pub(super) fn call_then(
        core: &ICoreWebView2,
        session: &str,
        method: &str,
        params: Value,
        then: Then,
    ) {
        let name = method.to_string();
        let then = Rc::new(std::cell::RefCell::new(Some(then)));
        let in_handler = then.clone();
        let handler =
            CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |hr, result| {
                let outcome = if hr.is_ok() {
                    Ok(serde_json::from_str(&result).unwrap_or(Value::Null))
                } else {
                    Err(format!("{name}: {result}"))
                };
                if let Some(t) = in_handler.borrow_mut().take() {
                    t(outcome);
                }
                Ok(())
            }));
        let params = HSTRING::from(params.to_string());
        let r = unsafe {
            if session.is_empty() {
                core.CallDevToolsProtocolMethod(&HSTRING::from(method), &params, &handler)
            } else {
                core.cast::<ICoreWebView2_11>().and_then(|c| {
                    c.CallDevToolsProtocolMethodForSession(
                        &HSTRING::from(session),
                        &HSTRING::from(method),
                        &params,
                        &handler,
                    )
                })
            }
        };
        if let Err(e) = r {
            if let Some(t) = then.borrow_mut().take() {
                t(Err(format!("{method}: {e}")));
            }
        }
    }

    type OnEvent = Rc<dyn Fn(&ICoreWebView2, String, Value)>;

    fn subscribe(core: &ICoreWebView2, event: &str, on: OnEvent) {
        unsafe {
            let receiver = match core.GetDevToolsProtocolEventReceiver(&HSTRING::from(event)) {
                Ok(r) => r,
                Err(e) => return eprintln!("browser: no receiver for {event}: {e}"),
            };
            let handler =
                DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |sender, args| {
                    let (Some(sender), Some(args)) = (sender, args) else {
                        return Ok(());
                    };
                    let mut json = PWSTR::null();
                    args.ParameterObjectAsJson(&mut json)?;
                    let params: Value = serde_json::from_str(&take_pwstr(json)).unwrap_or_default();
                    let session =
                        match args.cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>() {
                            Ok(a2) => {
                                let mut sid = PWSTR::null();
                                a2.SessionId(&mut sid)?;
                                take_pwstr(sid)
                            }
                            Err(_) => String::new(),
                        };
                    on(&sender, session, params);
                    Ok(())
                }));
            let mut token = 0i64;
            if let Err(e) = receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) {
                eprintln!("browser: subscribe {event} failed: {e}");
            }
        }
    }

    /// WebView2 hands out CoTaskMem strings the caller frees.
    fn take_pwstr(p: PWSTR) -> String {
        webview2_com::CoTaskMemPWSTR::from(p).to_string()
    }

    struct Ctx {
        state: BrowserState,
        /// The app's own origin when served over loopback (debug builds), refused in frames.
        app_origin: Option<String>,
        /// The app's top-level frame id, which equals the page's target id.
        main_frame: std::cell::RefCell<Option<String>>,
    }

    pub fn init(window: &tauri::WebviewWindow) {
        let state = window.state::<BrowserState>().inner().clone();
        #[cfg(debug_assertions)]
        let app_origin = window
            .config()
            .build
            .dev_url
            .as_ref()
            .map(|u| u.to_string());
        #[cfg(not(debug_assertions))]
        let app_origin: Option<String> = None;
        let _ = window.with_webview(move |webview| {
            let core = match unsafe { webview.controller().CoreWebView2() } {
                Ok(c) => c,
                Err(e) => return eprintln!("browser: WebView2 core unavailable: {e}"),
            };
            arm(
                &core,
                Rc::new(Ctx {
                    state,
                    app_origin,
                    main_frame: Default::default(),
                }),
            );
        });
        super::chords::register(window);
    }

    fn arm(core: &ICoreWebView2, ctx: Rc<Ctx>) {
        let c = ctx.clone();
        subscribe(
            core,
            "Target.attachedToTarget",
            Rc::new(move |core, _, p| on_attached(core, &c, &p)),
        );
        let c = ctx.clone();
        subscribe(
            core,
            "Target.detachedFromTarget",
            Rc::new(move |_, _, p| {
                c.state
                    .lock()
                    .sessions
                    .remove(p["sessionId"].as_str().unwrap_or_default());
            }),
        );
        let c = ctx.clone();
        subscribe(
            core,
            "Fetch.requestPaused",
            Rc::new(move |core, session, p| on_paused(core, &c, session, p)),
        );
        for event in [
            "Page.frameRequestedNavigation",
            "Page.frameNavigated",
            "Page.navigatedWithinDocument",
            "Page.frameStartedLoading",
            "Page.frameStoppedLoading",
            "Runtime.consoleAPICalled",
            "Runtime.exceptionThrown",
            "Network.requestWillBeSent",
            "Network.responseReceived",
            "Network.loadingFinished",
            "Network.loadingFailed",
        ] {
            let c = ctx.clone();
            subscribe(
                core,
                event,
                Rc::new(move |core, session, p| on_child_event(core, &c, event, &session, &p)),
            );
        }
        call(core, MAIN, "DOM.enable", Value::Object(Default::default()));
        // The app's own document must never wait on a frame-owner lookup: DOM commands stall
        // while the main frame navigates, so the paused request would never be answered. Learn
        // the main frame id before any interception starts.
        let core2 = core.clone();
        call_then(
            core,
            MAIN,
            "Target.getTargetInfo",
            Value::Object(Default::default()),
            Box::new(move |info| {
                match info {
                    Ok(v) => *ctx.main_frame.borrow_mut() = opt_str(&v["targetInfo"]["targetId"]),
                    Err(e) => return eprintln!("browser: not armed, {e}"),
                }
                // Fetch on the main session catches each iframe's first document, which loads
                // before its own target exists.
                call(
                    &core2,
                    MAIN,
                    "Fetch.enable",
                    serde_json::from_str(FETCH_PATTERNS).unwrap(),
                );
                call(
                    &core2,
                    MAIN,
                    "Target.setAutoAttach",
                    serde_json::json!({ "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true }),
                );
            }),
        );
    }

    /// Finds the pane that owns a frame by asking the app's DOM for the frame's `<iframe>` and
    /// reading its `data-browser-pane`. The framed page cannot change that attribute, unlike
    /// anything read from inside the frame.
    fn frame_pane(core: &ICoreWebView2, frame_id: &str, then: Box<dyn FnOnce(Option<String>)>) {
        let core2 = core.clone();
        call_then(
            core,
            MAIN,
            "DOM.getFrameOwner",
            serde_json::json!({ "frameId": frame_id }),
            Box::new(move |owner| {
                let Some(node) = owner.ok().and_then(|o| o["backendNodeId"].as_i64()) else {
                    return then(None);
                };
                call_then(
                    &core2,
                    MAIN,
                    "DOM.describeNode",
                    serde_json::json!({ "backendNodeId": node }),
                    Box::new(move |d| then(d.ok().as_ref().and_then(pane_from_node))),
                );
            }),
        );
    }

    fn run(core: &ICoreWebView2, session: &str) {
        call(
            core,
            session,
            "Runtime.runIfWaitingForDebugger",
            Value::Object(Default::default()),
        );
    }

    /// Every auto-attached target starts paused, so each one is resumed whatever happens; only
    /// iframes owned by a Local Browser pane get domains enabled first.
    fn on_attached(core: &ICoreWebView2, ctx: &Rc<Ctx>, p: &Value) {
        let session = str_of(&p["sessionId"]);
        let target = str_of(&p["targetInfo"]["targetId"]);
        if p["targetInfo"]["type"].as_str() != Some("iframe") {
            return run(core, &session);
        }
        let core2 = core.clone();
        let ctx = ctx.clone();
        let lookup = target.clone();
        frame_pane(
            core,
            &lookup,
            Box::new(move |pane| {
                if let Some(pane_id) = pane {
                    ctx.state.lock().sessions.insert(
                        session.clone(),
                        Binding {
                            pane_id,
                            frame_id: target,
                            clock_offset_ms: None,
                            restore_cache: false,
                            blocked: None,
                            restoring: false,
                        },
                    );
                    let empty = || Value::Object(Default::default());
                    call(&core2, &session, "Runtime.enable", empty());
                    call(&core2, &session, "Network.enable", empty());
                    call(&core2, &session, "Page.enable", empty());
                    call(
                        &core2,
                        &session,
                        "Fetch.enable",
                        serde_json::from_str(FETCH_PATTERNS).unwrap(),
                    );
                }
                run(&core2, &session);
            }),
        );
    }

    fn continue_request(core: &ICoreWebView2, session: &str, request_id: &Value) {
        call(
            core,
            session,
            "Fetch.continueRequest",
            serde_json::json!({ "requestId": request_id }),
        );
    }

    /// Every paused request is answered exactly once on every path, or the frame (or the app's
    /// own document) hangs.
    fn on_paused(core: &ICoreWebView2, ctx: &Rc<Ctx>, session: String, p: Value) {
        let frame_id = str_of(&p["frameId"]);
        if session.is_empty() {
            if ctx
                .main_frame
                .borrow()
                .as_deref()
                .is_none_or(|m| m == frame_id)
            {
                return continue_request(core, MAIN, &p["requestId"]);
            }
            let core2 = core.clone();
            let ctx = ctx.clone();
            frame_pane(
                core,
                &frame_id,
                Box::new(move |pane| handle_paused(&core2, &ctx, &session, &p, pane)),
            );
        } else {
            let pane = ctx
                .state
                .lock()
                .sessions
                .get(&session)
                .filter(|b| b.frame_id == frame_id)
                .map(|b| b.pane_id.clone());
            handle_paused(core, ctx, &session, &p, pane);
        }
    }

    fn handle_paused(
        core: &ICoreWebView2,
        ctx: &Rc<Ctx>,
        session: &str,
        p: &Value,
        pane: Option<String>,
    ) {
        let id = &p["requestId"];
        let Some(pane_id) = pane else {
            return continue_request(core, session, id);
        };
        let url = str_of(&p["request"]["url"]);
        let response_stage =
            !p["responseStatusCode"].is_null() || !p["responseErrorReason"].is_null();
        if !response_stage {
            let class = browser_policy::classify(&url, ctx.app_origin.as_deref());
            if class == UrlClass::Allowed {
                return continue_request(core, session, id);
            }
            // Aborted cancels the navigation and keeps the current page; BlockedByClient would
            // replace the frame with a chrome-error:// page.
            call(
                core,
                session,
                "Fetch.failRequest",
                serde_json::json!({ "requestId": id, "errorReason": "Aborted" }),
            );
            if ctx.state.lock().take_blocked(&pane_id, &url) {
                return;
            }
            return ctx.state.emit(
                &pane_id,
                BrowserEvent::Blocked {
                    url,
                    external: class == UrlClass::External,
                },
            );
        }
        let status = p["responseStatusCode"].as_u64().unwrap_or(0);
        if !p["responseErrorReason"].is_null()
            || (300..400).contains(&status)
            || !browser_policy::is_loopback_url(&url)
        {
            return continue_request(core, session, id);
        }
        let headers: Vec<(String, String)> = p["responseHeaders"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|h| (str_of(&h["name"]), str_of(&h["value"])))
                    .collect()
            })
            .unwrap_or_default();
        let Some(headers) = browser_policy::unframe_headers(&headers) else {
            return continue_request(core, session, id);
        };
        // Chromium checks framing against the original response headers, so editing them with
        // `continueResponse` has no effect; the document has to be fulfilled with new headers.
        let headers: Vec<Value> = headers
            .into_iter()
            .map(|(n, v)| serde_json::json!({ "name": n, "value": v }))
            .collect();
        let phrase = opt_str(&p["responseStatusText"]);
        let (core2, session2, id2) = (core.clone(), session.to_string(), id.clone());
        call_then(
            core,
            session,
            "Fetch.getResponseBody",
            serde_json::json!({ "requestId": id }),
            Box::new(move |body| {
                let body = match body {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("browser: {e}");
                        return continue_request(&core2, &session2, &id2);
                    }
                };
                let encoded = if body["base64Encoded"].as_bool() == Some(true) {
                    str_of(&body["body"])
                } else {
                    b64_encode(body["body"].as_str().unwrap_or_default().as_bytes())
                };
                let mut params = serde_json::json!({
                    "requestId": id2, "responseCode": status, "responseHeaders": headers, "body": encoded,
                });
                if let Some(phrase) = phrase {
                    params["responsePhrase"] = phrase.into();
                }
                let (core3, session3, id3) = (core2.clone(), session2.clone(), id2.clone());
                call_then(
                    &core2,
                    &session2,
                    "Fetch.fulfillRequest",
                    params,
                    Box::new(move |r| {
                        if let Err(e) = r {
                            eprintln!("browser: {e}");
                            continue_request(&core3, &session3, &id3);
                        }
                    }),
                );
            }),
        );
    }

    fn on_child_event(core: &ICoreWebView2, ctx: &Rc<Ctx>, method: &str, session: &str, p: &Value) {
        if session.is_empty() {
            return;
        }
        let (pane_id, events, restore_cache, step, restoring) = {
            let mut reg = ctx.state.lock();
            let Some(binding) = reg.sessions.get_mut(session) else {
                return;
            };
            let step = police(method, p, binding, ctx.app_origin.as_deref());
            let events = if step == Police::Restore {
                Vec::new()
            } else {
                translate(method, p, binding)
            };
            let stopped = matches!(
                events.first(),
                Some(BrowserEvent::LoadState { loading: false })
            );
            let restore = stopped && std::mem::take(&mut binding.restore_cache);
            (
                binding.pane_id.clone(),
                events,
                restore,
                step,
                binding.restoring,
            )
        };
        match step {
            Police::Pass => {}
            Police::Block { url, external } => ctx
                .state
                .emit(&pane_id, BrowserEvent::Blocked { url, external }),
            // The error page sits in its own history entry; Back returns to the page the frame
            // showed before the blocked navigation.
            Police::Restore => call(
                core,
                session,
                "Runtime.evaluate",
                serde_json::json!({ "expression": "history.back()" }),
            ),
        }
        // The error page's title is the blocked host, which the pane must not adopt.
        let wants_title = !restoring
            && events.iter().any(|e| {
                matches!(
                    e,
                    BrowserEvent::LoadState { loading: false }
                        | BrowserEvent::NavigatedInPage { .. }
                )
            });
        for event in events {
            ctx.state.emit(&pane_id, event);
        }
        if restore_cache {
            call(
                core,
                session,
                "Network.setCacheDisabled",
                serde_json::json!({ "cacheDisabled": false }),
            );
        }
        if wants_title {
            let ctx = ctx.clone();
            call_then(
                core,
                session,
                "Runtime.evaluate",
                serde_json::json!({ "expression": "document.title", "returnByValue": true }),
                Box::new(move |r| {
                    if let Some(title) = r
                        .ok()
                        .and_then(|v| v["result"]["value"].as_str().map(str::to_string))
                    {
                        ctx.state.emit(&pane_id, BrowserEvent::Title { title });
                    }
                }),
            );
        }
    }

    pub(super) fn with_core(
        window: &tauri::WebviewWindow,
        f: impl FnOnce(&ICoreWebView2) + Send + 'static,
    ) -> Result<(), String> {
        window
            .with_webview(move |webview| {
                if let Ok(core) = unsafe { webview.controller().CoreWebView2() } {
                    f(&core);
                }
            })
            .map_err(|e| e.to_string())
    }

    pub(super) fn evaluate(
        window: &tauri::WebviewWindow,
        session: String,
        expression: String,
    ) -> Result<(), String> {
        with_core(window, move |core| {
            call(
                core,
                &session,
                "Runtime.evaluate",
                serde_json::json!({ "expression": expression }),
            );
        })
    }

    fn b64_encode(bytes: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for c in bytes.chunks(3) {
            let n = (c[0] as u32) << 16
                | (*c.get(1).unwrap_or(&0) as u32) << 8
                | *c.get(2).unwrap_or(&0) as u32;
            out.push(T[(n >> 18) as usize & 63] as char);
            out.push(T[(n >> 12) as usize & 63] as char);
            out.push(if c.len() > 1 {
                T[(n >> 6) as usize & 63] as char
            } else {
                '='
            });
            out.push(if c.len() > 2 {
                T[n as usize & 63] as char
            } else {
                '='
            });
        }
        out
    }

    #[cfg(test)]
    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    }
}

const NOT_WINDOWS: &str = "the Local Browser needs WebView2 (Windows only)";

fn session_for(state: &BrowserState, pane_id: &str) -> Result<String, String> {
    state
        .lock()
        .session_for_pane(pane_id)
        .ok_or_else(|| "no page is loaded in this pane".to_string())
}

#[tauri::command]
pub fn browser_attach(
    state: tauri::State<'_, BrowserState>,
    pane_id: String,
    on_event: Channel<BrowserEvent>,
) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(NOT_WINDOWS.into());
    }
    state.lock().channels.insert(pane_id, on_event);
    Ok(())
}

#[tauri::command]
pub fn browser_detach(state: tauri::State<'_, BrowserState>, pane_id: String) {
    let mut reg = state.lock();
    reg.channels.remove(&pane_id);
    if reg.focused.as_deref() == Some(pane_id.as_str()) {
        reg.focused = None;
    }
}

#[tauri::command]
pub fn browser_focus(state: tauri::State<'_, BrowserState>, pane_id: Option<String>) {
    state.lock().focused = pane_id;
}

#[tauri::command]
pub fn browser_history(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    pane_id: String,
    delta: i32,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let session = session_for(&state, &pane_id)?;
        win::evaluate(&window, session, format!("history.go({delta})"))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, pane_id, delta);
        Err(NOT_WINDOWS.into())
    }
}

#[tauri::command]
pub fn browser_reload(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    pane_id: String,
    ignore_cache: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let session = session_for(&state, &pane_id)?;
        if ignore_cache {
            if let Some(b) = state.lock().sessions.get_mut(&session) {
                b.restore_cache = true;
            }
            let s = session.clone();
            win::with_core(&window, move |core| {
                win::call(
                    core,
                    &s,
                    "Network.setCacheDisabled",
                    serde_json::json!({ "cacheDisabled": true }),
                );
            })?;
        }
        win::evaluate(&window, session, "location.reload()".into())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, pane_id, ignore_cache);
        Err(NOT_WINDOWS.into())
    }
}

#[tauri::command]
pub async fn browser_response_body(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, BrowserState>,
    pane_id: String,
    request_id: String,
) -> Result<ResponseBody, String> {
    #[cfg(windows)]
    {
        let session = session_for(&state, &pane_id)?;
        let (tx, mut rx) = tauri::async_runtime::channel::<Result<ResponseBody, String>>(1);
        win::with_core(&window, move |core| {
            win::call_then(
                core,
                &session,
                "Network.getResponseBody",
                serde_json::json!({ "requestId": request_id }),
                Box::new(move |r| {
                    let _ = tx.try_send(r.map(|v| ResponseBody {
                        body: str_of(&v["body"]),
                        base64: v["base64Encoded"].as_bool().unwrap_or(false),
                    }));
                }),
            );
        })?;
        rx.recv()
            .await
            .unwrap_or_else(|| Err("the page went away".into()))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, state, pane_id, request_id);
        Err(NOT_WINDOWS.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn binding() -> Binding {
        Binding {
            pane_id: "p1".into(),
            frame_id: "F".into(),
            clock_offset_ms: None,
            restore_cache: false,
            blocked: None,
            restoring: false,
        }
    }

    #[test]
    fn events_serialize_per_contract() {
        let e = BrowserEvent::NavigatedInPage { url: "u".into() };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "navigatedInPage", "url": "u" })
        );
        let e = BrowserEvent::Finished {
            request_id: "1".into(),
            encoded_length: 5.0,
            timestamp: 2.0,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "finished", "requestId": "1", "encodedLength": 5.0, "timestamp": 2.0 })
        );
        let e = BrowserEvent::LoadState { loading: true };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "loadState", "loading": true })
        );
        let e = BrowserEvent::Navigated {
            url: "u".into(),
            title: None,
        };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({ "kind": "navigated", "url": "u" })
        );
    }

    #[test]
    fn page_events_only_for_root_frame() {
        let mut b = binding();
        let nav = |id: &str| json!({ "frame": { "id": id, "url": "http://127.0.0.1:5199/p2", "parentId": "APP" } });
        assert_eq!(
            translate("Page.frameNavigated", &nav("F"), &mut b),
            vec![BrowserEvent::Navigated {
                url: "http://127.0.0.1:5199/p2".into(),
                title: None
            }]
        );
        assert!(translate("Page.frameNavigated", &nav("NESTED"), &mut b).is_empty());
        assert_eq!(
            translate(
                "Page.frameStoppedLoading",
                &json!({ "frameId": "F" }),
                &mut b
            ),
            vec![BrowserEvent::LoadState { loading: false }]
        );
    }

    #[test]
    fn blocked_navigation_is_reported_once_and_undone() {
        let mut b = binding();
        let ask = |url: &str, frame: &str| json!({ "frameId": frame, "url": url, "disposition": "currentTab", "reason": "anchorClick" });
        let nav = |url: &str| json!({ "frame": { "id": "F", "url": url } });
        let ext = "https://example.com/#x";
        let req = "Page.frameRequestedNavigation";
        assert_eq!(
            police(req, &ask("http://127.0.0.1:5199/p2", "F"), &mut b, None),
            Police::Pass
        );
        assert_eq!(police(req, &ask(ext, "NESTED"), &mut b, None), Police::Pass);
        assert_eq!(
            police(req, &ask(ext, "F"), &mut b, None),
            Police::Block {
                url: ext.into(),
                external: true
            }
        );
        let mut reg = Registry::default();
        reg.sessions.insert("S".into(), b.clone());
        assert!(!reg.take_blocked("p2", "https://example.com/"));
        assert!(reg.take_blocked("p1", "https://example.com/"));
        assert!(!reg.take_blocked("p1", "https://example.com/"));

        let error = nav("chrome-error://chromewebdata/");
        assert_eq!(
            police("Page.frameNavigated", &error, &mut b, None),
            Police::Restore
        );
        assert!(b.restoring && b.blocked.is_none());
        let back = nav("http://127.0.0.1:5199/p1");
        assert_eq!(
            police("Page.frameNavigated", &back, &mut b, None),
            Police::Pass
        );
        assert!(!b.restoring);
        // An unreachable server's error page is not a blocked navigation.
        assert_eq!(
            police("Page.frameNavigated", &error, &mut b, None),
            Police::Pass
        );
        assert_eq!(
            police(req, &ask("http://tauri.localhost/", "F"), &mut b, None),
            Police::Block {
                url: "http://tauri.localhost/".into(),
                external: false
            }
        );
    }

    #[test]
    fn console_levels_text_and_cap() {
        let mut b = binding();
        let p = json!({
            "type": "warning", "timestamp": 1000.5,
            "args": [{ "type": "string", "value": "hi" }, { "type": "number", "value": 3 }, { "type": "object", "description": "Object" }, { "type": "undefined" }],
            "stackTrace": { "callFrames": [{ "url": "http://x/", "lineNumber": 9 }] }
        });
        let ev = translate("Runtime.consoleAPICalled", &p, &mut b);
        assert_eq!(
            ev,
            vec![BrowserEvent::Console {
                level: "warn".into(),
                text: "hi 3 Object undefined".into(),
                source: Some("console-api".into()),
                url: Some("http://x/".into()),
                line: Some(10),
                timestamp: 1000.5,
            }]
        );
        let long = "\u{e9}".repeat(MAX_TEXT);
        let p = json!({ "type": "log", "timestamp": 1.0, "args": [{ "type": "string", "value": long }] });
        let BrowserEvent::Console { text, .. } =
            &translate("Runtime.consoleAPICalled", &p, &mut b)[0]
        else {
            panic!()
        };
        assert!(text.len() <= MAX_TEXT + 3 && text.ends_with("..."));
    }

    #[test]
    fn network_timestamps_become_epoch_ms() {
        let mut b = binding();
        let req = json!({
            "requestId": "7", "type": "Fetch", "wallTime": 1_700_000_000.0, "timestamp": 100.0,
            "request": { "url": "http://localhost:1/a", "method": "GET" }
        });
        let BrowserEvent::Request { timestamp, .. } =
            translate("Network.requestWillBeSent", &req, &mut b)[0].clone()
        else {
            panic!()
        };
        assert_eq!(timestamp, 1_700_000_000_000.0);
        let fin = json!({ "requestId": "7", "timestamp": 100.25, "encodedDataLength": 42 });
        assert_eq!(
            translate("Network.loadingFinished", &fin, &mut b),
            vec![BrowserEvent::Finished {
                request_id: "7".into(),
                encoded_length: 42.0,
                timestamp: 1_700_000_000_250.0
            }]
        );
    }

    #[test]
    fn frame_owner_attribute() {
        let d = json!({ "node": { "nodeName": "IFRAME", "attributes": ["class", "x", "data-browser-pane", "t1"] } });
        assert_eq!(pane_from_node(&d).as_deref(), Some("t1"));
        let d = json!({ "node": { "nodeName": "DIV", "attributes": ["data-browser-pane", "t1"] } });
        assert_eq!(pane_from_node(&d), None);
        let d = json!({ "node": { "nodeName": "IFRAME", "attributes": ["src", "x"] } });
        assert_eq!(pane_from_node(&d), None);
    }
}
