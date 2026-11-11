# Local Browser

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 3.21 Local file server (`src-tauri/src/browser_files/`)

The Local Browser shows a local HTML file by having the core serve it over loopback, not by
framing a `file://` URL. WebView2 does not frame `file://` documents in an `http` page, and a
`file://` page gets no `fetch` and no ES modules. Served over loopback, a file page is an ordinary
loopback document to the rest of 4.21: the navigation policy, header rewriting, events, and
DevTools drawer apply unchanged, and relative stylesheets, scripts, and images resolve.

### Mounts

Opening a file mounts its folder. The mount root is the file's parent folder, canonicalized
(`std::fs::canonicalize`, so junctions and symlinks resolve before any check). Two exceptions
mount the file alone, serving no other path: a folder that is a drive root, and the user's home
folder itself, since either would expose far more than the page needs. UNC paths
(`\\server\share`) are refused.

Each mount has two listeners on `127.0.0.1`, each on its own port and so its own origin: the
shared listener, for the folder's Trusted and Local pages, and the Downloaded listener, for its
Downloaded pages (Trust levels). Each is started when the first page that needs it opens. Chromium's
same-origin policy then keeps a page in one folder from reading another folder's files, cookies, or
storage, and keeps a Downloaded page from reaching the frame, token, or `fetch` of a Trusted or
Local page in its own folder, with no check of ours. The invariant that makes the split hold: a
file with Mark of the Web never runs as a document on the shared listener (Requests). The core
records each listener's port in `browser-mounts.json` in the app data folder, keyed by the mount
for the shared listener and by `downloaded:` and the mount for the Downloaded one, and asks for the
same port on the next launch, so a page's `localStorage` (keyed by origin) survives a restart; a
port that is taken gets a fresh one, and a mount never listens on the app's dev server port, which
the navigation policy refuses. Mounts live until the app exits.

A mount is named by its folder, or by its file for a single-file mount. That name keys its
listeners, its ports, and its entry in `localBrowser.allowedHosts` (Trust levels), so two pages
opened directly from the home folder are separate mounts with separate allowed hosts.

Each pane that opens a file registers a token on the listener the file's trust calls for: 128
random bits, hex, made per pane per launch. The serving address is
`http://127.0.0.1:<port>/<token>/<path>`. The token ties every request to one pane, which is how
CSP reports and file changes reach the right pane, and it keeps a page elsewhere (another pane, or
a site in the system browser) from reading a mount it does not know the token for. A pane holds
one token per mount and listener it has been served: a file on a mount and listener it already
holds a token for reuses that token, and a file on another mount, or a sibling of the other kind (a
Downloaded file after a Local one, or the reverse), gets a new token on the right listener beside
the others. A token is known only on the listener it was made for. The tokens live until the pane
closes, so Back and Forward into a file page the pane has left, or across a move between listeners,
still load; a pane holds at most 20, and a new one past that revokes the one served longest ago.

### Requests

The listener answers `GET` and `HEAD` for files, and `POST` only at `/<token>/__csp-report`.
Before serving, it:

1. checks that `Host` is exactly `127.0.0.1:<port>`, refusing anything else with 421, which stops a
   DNS rebinding page from reading through a name it controls;
2. looks up the token, answering 404 for an unknown one, as for a missing file;
3. percent-decodes the path, refuses any segment that is empty, `.`, `..`, or starts with `.`
   (so `.git`, `.env`, and `.ssh` are never served), and refuses a path with `:` (alternate data
   streams);
4. joins it to the mount root, canonicalizes, and requires the result to sit under the root, so a
   junction inside the folder cannot point out of it, with no part below the root starting with
   `.`, so an 8.3 short name (`GIT~1`) cannot stand in for a dot-leading one;
5. serves files only. A folder answers 404; there are no directory listings.

The two listeners then split the mount's files by Mark of the Web (a `ZoneId` of 3 or 4, Trust
levels):

- The Downloaded listener serves only files with Mark of the Web, so a downloaded page reads only
  what arrived with it.
- The shared listener answers 404 for a marked HTML or XML file, and for a marked SVG file unless
  the request's `Sec-Fetch-Dest` is `image`. Each of those can run script once loaded as a document,
  which would give a downloaded file the shared origin's reach; Chromium sets `Sec-Fetch-Dest` and a
  page cannot, and a request without it counts as a document. This holds for frames nested in a
  page too: a Local page that frames a marked sibling gets the 404, not the sibling running in its
  origin. Other marked files (scripts, stylesheets, images, fonts) are served, since a Local page
  that loads one has chosen to run it with its own authority.

The refusal is a 404 rather than a redirect to the other listener: a redirect would mint a token for
whatever asked, including a nested frame or a `fetch` the pane never sees, and leave it live beside
the pane's own. Only the pane moves its registration. When its own frame lands on a file of the
other kind, the pane serves that file again and loads it from the right listener (4.21, File
pages).

Every response carries:

| Header | Value |
| --- | --- |
| `Content-Type` | From the extension; unknown extensions are `application/octet-stream` |
| `X-Content-Type-Options` | `nosniff` |
| `Cross-Origin-Resource-Policy` | `same-origin`, so no other origin can embed a mount's files |
| `Referrer-Policy` | `no-referrer` |
| `Cache-Control` | `no-store`, so a reload after a change always reads the disk |
| `Content-Security-Policy` | On HTML, SVG, XML, and JavaScript, by trust level (below) |

No response carries `Access-Control-Allow-Origin`, so no other origin can read one.

Chromium takes a document's policy from its own response, an SVG or XML document's as much as an
HTML one's, and a worker's from its script's, so each of those carries the CSP; a page that framed
an SVG file or started a worker from a script without one would reach every host. A service
worker script (`Sec-Fetch-Dest: serviceworker`) answers 404 on both listeners: a service worker
could answer navigations in its scope with documents it makes up, which carry no policy of ours.

### Trust levels

A file page's trust level decides where it may send requests. The browser enforces it through the
CSP header the core puts on each document and script response; nothing is injected into the page. The level is
fixed when the document loads, and changing it reloads the page.

| Level | Applies to | Can reach |
| --- | --- | --- |
| Trusted | A file under a folder in `localBrowser.trustedFolders` (8), without Mark of the Web | Any host |
| Local | Any other file without Mark of the Web | Its own mount, `localBrowser.cdnHosts`, and its folder's allowed hosts |
| Downloaded | A file with Mark of the Web, wherever it is, including inside a trusted folder | The same as Local, except any loopback service; allowing a host asks first |

Mark of the Web is the `Zone.Identifier` alternate data stream Windows writes on files from a
browser download, an email attachment, or an archive extracted from one. The core reads it with
the file, and a `ZoneId` of 3 (Internet) or 4 (Restricted) makes the page Downloaded.

The CSPs, with `<cdn>` the CDN hosts and `<allowed>` the folder's allowed hosts:

| Level | Policy |
| --- | --- |
| Trusted | `default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; form-action 'self'` |
| Local, Downloaded | `default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval' <cdn> <allowed>; form-action 'self'; report-uri /<token>/__csp-report` |

A Downloaded page's policy leaves out every source that could match this machine, whether it came
from `localBrowser.cdnHosts` or `localBrowser.allowedHosts`, including one typed into
`settings.json`: `localhost`, any `*.localhost`, `127.0.0.0/8`, `0.0.0.0`, and `[::1]`, with or
without a scheme or port and in any case, plus scheme-only sources (`https:`), `*`, and wildcards
such as `*.localhost` or `*.0.0.1`. `'self'` is the page's own Downloaded listener and no other
port, so a Downloaded page never fetches from, loads from, or frames a loopback service
(`trust::is_loopback_host`). CSP does not govern where a page navigates its own frame, so the
bridge refuses that route (4.21 Navigation policy, File pages). Trusted and Local policies keep
these sources.

Inline scripts and `eval` are allowed at every level. Generated reports are mostly inline, and a
script that cannot send anything out has nothing to leak. Every directive falls back to
`default-src`, so `connect-src` (`fetch`, XHR, WebSocket, EventSource), `img-src`, `script-src`,
`style-src`, `font-src`, `media-src`, and `frame-src` all share the one list. That matters because
an image or script URL can carry data in its query string as easily as a `fetch` can.

`localBrowser.cdnHosts` defaults to the public CDNs a generated page usually loads from:
`cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `fonts.googleapis.com`, and
`fonts.gstatic.com`. A CDN serves files but does not show who requested them, so loading from one
is not a way to send data out.

**Refused requests.** Chromium sends a report for each request the CSP refuses to
`/<token>/__csp-report` (JSON, at most 16 KB, with at most 100 reports a second per token). The core
sends the pane an `egressBlocked` event with the refused URL's host, the directive, and the URL. The
pane collects the hosts in a bar under the toolbar, each with an Allow button. Allow adds the host
to the mount's entry in `localBrowser.allowedHosts` (8) through `settings_set`, and the page reloads
with the host in its policy. On a Downloaded page Allow first asks "This file came from the
internet. Let it send requests to example.com?", and a refused loopback host shows "Downloaded pages
can't reach local services" in place of Allow, since its policy would leave the host out anyway. On
a Local page Allow for a loopback host first asks "localhost is a service running on this computer,
port 3000. Let this page send requests to it and read its responses?". Allowed hosts belong to a
mount, not to one page: a folder's entry covers every page in it, Downloaded pages included, and a
page opened directly from the home folder or a drive root has an entry of its own, keyed by its
file.

### Changes on disk

The core watches each served HTML file (the `notify` crate, as `settings/watch.rs` does) and
sends its pane `fileChanged`, debounced by 300 ms, since generators often write a file in several
steps. Only a pane's current file page is watched: the watch moves with each file the pane is
served and stops when the pane leaves file pages. With `localBrowser.reloadOnChange` (8) on, the default, the pane serves the file again and
reloads the frame, so a save that adds or drops Mark of the Web moves the page to the right
listener; off, it shows a "Changed on disk" notice with a Reload button that does the same. Only the opened file is watched, not its
stylesheets or scripts.

## 4.21 Local Browser

The `browser` pane kind (4.11) shows a dev server's page beside the terminals that run it, with
URL entry, Back, Forward, Reload, Home, bookmarks, device sizes, and a drawer holding a Console
and a Network panel. It shows two kinds of page: loopback addresses (`http` or `https` on
`localhost` or `127.0.0.1`, on any port), and local HTML files, which the core serves over
loopback itself (3.21). The front end is `src/localBrowserPane.ts` (`LocalBrowserPane`) with its
chrome in `src/browserToolbar.ts` and `src/browserDevtools.ts`; the core side is
`src-tauri/src/browser.rs`, `src-tauri/src/browser/chords.rs`, `src-tauri/src/browser_policy.rs`,
`src-tauri/src/browser_tls.rs`, and `src-tauri/src/browser_files/`. The pane's threat model and
every measure that contains a framed page are collected in [security.md](security.md) (9.1).

### Design

The page renders in a sandboxed `<iframe>`. A native child webview would draw over the app's
menus, dialogs, and scrim, and an iframe takes part in the layout like any other element. A page
on another origin is opaque to the app, so the app never reads the frame; nothing is injected
into the page, and no `message` listener exists on the app side. Instead the Rust core drives the
frame over the WebView2 DevTools Protocol (CDP) through the host API
(`CallDevToolsProtocolMethod`, `CallDevToolsProtocolMethodForSession`, and the event receivers),
which works in release builds, where WebView2's DevTools are off. The core learns the page's URL,
title, console output, and network traffic that way, steers history, removes framing headers for
loopback documents, and stops navigations that leave loopback.

`browser::init` arms the bridge once per window, next to the accelerator-key handling in
`lib.rs`: it enables `DOM` on the main session and calls `Target.setAutoAttach` with
`autoAttach`, `waitForDebuggerOnStart`, and `flatten`. Each out-of-process iframe then attaches
as its own session. On attach the core enables `Runtime`, `Network`, `Page`, and `Fetch` on that
session, turns on the same auto-attach for it (so out-of-process frames nested in the page attach
through it), and releases it with `Runtime.runIfWaitingForDebugger`. The pane's attachment must
exist before the frame's first document is requested, so `LocalBrowserPane` calls `browser_attach`
before it sets the frame's `src`. On non-Windows builds the commands return an error.

**Off-screen panes.** An iframe that leaves the document reloads its original `src` when it
returns, losing the page's state. The pane marks its host `data-keep-alive`, and `LayoutView`
(`src/layoutView.ts`) never detaches such a host: when a render leaves it out (another tab, a zoom
on another pane, the pane collapsed), it moves to a hidden park element under `<body>`, and every
move in or out uses `moveBefore`, Chromium's state-preserving move. A pane opened off screen is
placed in the park at once, so its page loads before it is shown.

**Debug builds.** The app itself is served from `localhost:1420`, so a `localhost:*` frame is
same-site with it and may stay in the app's process; no session attaches and no events arrive,
though blocking and header rewriting still work. Use `127.0.0.1` to test in a debug build.
Release builds (`http://tauri.localhost`) are unaffected.

### Frame to pane correlation

Every frame carries `data-browser-pane="<paneId>"`. When a session attaches, the core asks the
main session for the frame's owner (`DOM.getFrameOwner`), describes that node (`DOM.describeNode`),
and reads the attribute from an `iframe` element. That reads the app's own DOM, which the framed
page cannot forge (`window.name` could be). A session whose frame has no such owner is left
unmonitored, and its documents pass through untouched. A frame that attaches through a pane's
session sits inside the framed page; it is bound to the same pane as a nested session, which is
policed but sends the pane no events. The registry maps sessions to panes and panes to their event
channels behind one mutex; a detached or destroyed target removes its entry, and `browser_detach`
drops the channel.

### Navigation policy

`browser_policy::classify` sorts every document URL into three classes, and `bb browse` (3.13)
shares its loopback rule:

| Class | URLs | Result |
| --- | --- | --- |
| Allowed | `http` or `https` on `localhost` or `127.0.0.1`, no userinfo, not the app | Loads in the frame |
| External | `http` or `https` on any other host | Failed, then opened in the system browser |
| Refused | Other schemes, `*.localhost`, hosts that merely look local, the app's own origin | Failed, with a notice in the pane |

The app's origin is read from the Tauri configuration at runtime, never a fixed port, and the
refusal applies to the app's port on every loopback host and scheme, since all of them reach the
same dev server. The pane's address field applies the same rules (`normalizeInput` in
`src/localBrowserModel.ts`) before it sets the frame's `src`.

At the Request stage of `Fetch.requestPaused` for `Document` resources, the core fails a
non-allowed navigation with `Fetch.failRequest` and the reason `Aborted`. `Aborted` cancels the
navigation and keeps the current page; `BlockedByClient` would replace the frame with a
`chrome-error://` page. The pane gets a `blocked` event. For an external one it opens the address
through `open_url` and shows "Opened example.com in your browser."; for a refused one it shows why.

In a release build the app's CSP `frame-src` stops a navigation the framed page starts toward a
non-loopback address (a link to example.com, or to `http://tauri.localhost`) before any request
exists, so Fetch never sees it and the frame commits a `chrome-error://` page. The core therefore
also watches `Page.frameRequestedNavigation` on the pane's frame: a non-allowed URL there sends the
same `blocked` event, and when the error page commits the core runs `history.back()` in the frame,
returning it to the page it showed, without reporting the error page's URL or title or the
requests it makes. A navigation reported there is remembered, so when Fetch does see it (debug
builds) the pane is not told twice.

Two other navigations reach the error page with no `frameRequestedNavigation`: a server redirect to
a non-allowed address, and Forward onto the entry a blocked navigation left. The core recognizes
them by the error page's `unreachableUrl`, which policy refuses: it sends `blocked` and goes back.
After Back or Forward (`browser_history`) the event is never `external`, so a blocked address is
not opened in the system browser a second time. Back is skipped while the frame has shown no page
of its own, since going back from its first entry would leave its history; the error page stays,
with the notice.

**File pages.** A page served from a local file (3.21) follows the same classes, with one
difference: an external navigation it makes is never opened in the system browser on its own. A
script can navigate with data in the query string, and opening that address automatically would
carry the data out. The pane shows "This page tried to open example.com" with an Open button, and
only a click sends the address to `open_url`.

A Downloaded page never navigates its frame to a loopback service. When the frame's current
document is on a Downloaded listener, which the core learns by asking the file server about the
address the frame last committed (`downloaded_scope`), never from the page or the pane, a
navigation it asks for to a loopback host (`trust::is_loopback_host`) outside its own listener and
token is refused (`browser_policy::leaves_downloaded_scope`). The rule reads
`Page.frameRequestedNavigation` on the pane's frame, which reports the navigations the frame's own
document starts (a link, a script setting `location`, a form, a meta refresh) and not the pane's:
the address field, Home, a bookmark, or Retry set the iframe's `src` from the app's document. A
history traversal raises no such event, so the rule also reads `Page.frameStartedNavigating`, whose
`navigationType` of `historyDifferentDocument` or `historySameDocument` marks one, and refuses the
page's own `history.back()` or `history.go(n)` onto an earlier loopback entry of its frame. The
pane's Back and Forward are told apart by a mark: `browser_history` records it on the pane's frame
just before running `history.go`, the first traversal that starts spends it, and it lapses after
two seconds, so the user can always leave the page. The core's own `history.back()` that undoes an
error page carries the same mark. A refused address that `classify` would allow is remembered, and
the Fetch Request stage fails it with `Aborted`, so no request reaches the service and a refused
traversal leaves the frame on its page and its history index where it was; `location.replace`
from `browser_replace` is the core's own navigation and is exempt. The pane gets a `blocked` event with `downloaded` and shows "Blocked
127.0.0.1:8000. Downloaded pages can't open local services.", with no Open button. Its own marked
siblings, under the same token, load as before, and an external address still waits for a click.
A frame nested in a Downloaded page cannot load a loopback service either: the page's `frame-src`
names none, and the Fetch path refuses one that leaves the pane's page's scope, with a `console`
warning.

The pane keeps every serving base it has been given, with its file and folder, for its lifetime
(at most 20, matching the core's tokens), so an address under any of them maps back to its file.
When the frame commits a document under one, the pane shows the file's path, and if that is a
different file from the one it shows, the address is not under its current token, or the pane was
not showing a file page (Back or Forward from a loopback page), serves the file again with
`browser_serve_file`. That restores file mode with the folder used for Allow, refreshes the trust
badge and the file watch, and when the file belongs on the other listener (a Local page's link to a
downloaded sibling, which the shared listener answered with 404, or a file whose Mark of the Web
changed since), the pane loads the file from the address the core returns with
`browser_replace`, in place of the frame's current history entry. A new entry would leave the 404
behind it, and Back onto that would serve the file forward again, so Back could never reach the
page before it. A document under no
known base leaves file mode: the badge, egress bar, and notices clear, and the file watch stops,
while the bases and their tokens stay.

The pane takes an error page or failed document request that follows a `blocked` event within a
few seconds as that navigation's, not as an unreachable server. Any other document that fails to
load (a `chrome-error://` frame, or a failed document request) shows a "nothing is listening"
overlay naming the failed address (the error page's `unreachableUrl`), with a Retry button; the
address field and the pane's title follow that address.

**Scheme.** Port tiles, Ports pane rows, container ports, a bare port, and printed links all
name `http`, though a dev server may speak only `https`. Before the pane loads an `http` loopback
address it calls `browser_prefer_tls` (`src-tauri/src/browser_tls.rs`), which connects to the port,
writes a rustls ClientHello, and reads two bytes: a TLS record header (handshake or alert)
means the port speaks TLS, and the pane loads the `https` form instead, keeping the port and
path. Plain http answers with something else, and a server that waits for a full request line
times out after 0.8 s, so either way the address stays `http`. No certificate is checked and no
HTTP request is sent. Only the address the pane is given is checked; navigations inside the page
are not. `open_url` applies the same rule to the system browser.

**https failures.** WebView2 has no click-through for a certificate error in a frame, and only
Chromium's error page says why the load failed. For an `https` address the pane therefore holds the
overlay back and calls `browser_probe_tls`, which repeats the TLS handshake from the core with
`ureq` and the platform verifier, so it trusts the same Windows certificate store WebView2 does.
The command accepts only `https` loopback URLs. Its answer picks the overlay: `untrusted` (the
certificate failed verification) names `dotnet dev-certs https --trust` as the fix, `notTls` (the
port does not speak TLS) suggests the `http` address, and `refused` or `other` keeps "nothing is
listening". A page that commits, or a later failure, supersedes a probe still in flight.

**Nested frames.** A document request for any other frame in a pane's session, or in a nested
session, is a frame inside the framed page. It follows the same classes, except that a refused one
is never opened in the system browser: the core fails it with `Aborted` and sends a `console`
warning naming the address. Loopback documents in nested frames are unframed like the pane's own
(Header rewriting).

### Header rewriting

A dev server may send `X-Frame-Options` or a `frame-ancestors` directive that forbids framing.
The core rewrites the response for loopback documents inside a Local Browser frame, at the
Response stage: it removes `X-Frame-Options`, drops only the `frame-ancestors` directive from
`Content-Security-Policy` and `Content-Security-Policy-Report-Only` (the rest of the policy
stays), and drops the encoding and length headers, since the body it hands back is already
decoded. A response with no framing header, a redirect, or a non-loopback URL passes through
unchanged.

`Strict-Transport-Security` from an `https` loopback page needs no rewriting: WebView2 ignores it
for `localhost`, so it never upgrades later `http` loopback frames, or the debug app's own origin,
to `https`.

The rewrite is a fulfill, not a continue: Chromium checks framing against the original response
headers, so `Fetch.continueResponse` with edited headers has no effect. The core calls
`Fetch.getResponseBody`, then `Fetch.fulfillRequest` with the same status, the filtered headers,
and the body. The main session intercepts the frame's first document, because the frame's own
session does not exist yet; the frame's session intercepts every later document navigation. Both
enable `Fetch` for `Document` resources only. Anything that is not a Local Browser frame is
continued immediately, so the app's own documents are never touched, and a paused request is
never left unanswered (a failed fulfill falls back to continuing).

### Events

The core sends the pane `BrowserEvent` values (`kind` in camelCase) on a Tauri `Channel`, and
`src/devtoolsModel.ts` holds the matching TypeScript union:

| Event | Fields |
| --- | --- |
| `navigated` | `url`, `title?`, `unreachableUrl?` (on an error page, the address that failed) |
| `navigatedInPage` | `url` (a hash or `history.pushState` change) |
| `title` | `title` (can arrive twice for one navigation; the pane de-duplicates) |
| `blocked` | `url`, `external`, `downloaded?` (a Downloaded page asked for a loopback service) |
| `console` | `level`, `text`, `source?`, `url?`, `line?`, `timestamp` |
| `exception` | `text`, `url?`, `line?`, `timestamp` |
| `request` | `requestId`, `url`, `method`, `resourceType`, `headers`, `timestamp` |
| `response` | `requestId`, `status`, `statusText`, `mimeType`, `headers`, `timestamp` |
| `finished` | `requestId`, `encodedLength`, `timestamp` |
| `failed` | `requestId`, `errorText`, `canceled`, `timestamp` |
| `loadState` | `loading` |
| `fileChanged` | (none; the served file changed on disk, 3.21) |
| `egressBlocked` | `host`, `directive`, `url` (a file page's request that its CSP refused, 3.21) |

Every `timestamp` is milliseconds since the Unix epoch. Console and exception text is cut at 10
KB. Page events count only for the frame's root frame, not frames nested in the page.

A frame's first document loads before its own session attaches, so its `Network` events never
arrive. The main session's Fetch, which intercepts that document, sends its `request` and
`response` (or `failed`) instead, keyed by Fetch's `networkId`, which is the Network request id, so
a later report from the frame's session updates the same row.

The commands are `browser_attach(paneId, onEvent)`, `browser_detach(paneId)`,
`browser_history(paneId, delta)`, `browser_reload(paneId, ignoreCache)`,
`browser_replace(paneId, from, to)`,
`browser_response_body(paneId, requestId)` (returning the body and whether it is base64),
`browser_focus(paneId | null)`, and `browser_chords(keys)` (see App chords), wrapped by
`src/browserApi.ts`. A frame target has no navigation
history to query, so Back, Forward, and Reload run `history.go(delta)` and `location.reload()` in
the frame's session; a hard reload also turns the cache off for that session. `browser_replace`
runs `location.replace(to)` there, only while the frame still shows `from` (File pages).

### Chrome

The toolbar has Back, Forward, Reload (Shift+click bypasses the cache), Home, the address field,
a bookmark star, a Bookmarks menu, a device size menu, and a DevTools button with a badge counting
console errors and exceptions. Home opens `localBrowser.homeUrl` (8), or the start page when it
is empty. The address field accepts a bare port (`5173`), `:port`, `host:port/path`, or a full
loopback URL; a missing host means `localhost`. It also accepts a path to an `.html` or `.htm`
file: Windows (`C:\notes\a.html`, `C:/notes/a.html`), Git Bash (`/c/notes/a.html`), `~/`, or a
`file:///` URL. A file page shows its path in the field, never the core's serving address.
Anything else shows a message by the field saying that only loopback addresses and local HTML
files open.

On a file page the toolbar shows a trust badge (Trusted, Local, or Downloaded, 3.21), and a bar
under the toolbar lists the hosts the page tried to reach and was refused, each with its count of
refused requests and an Allow button, or on a Downloaded page, for a loopback host, the note
"Downloaded pages can't reach local services" (Trust levels). The pane decides which with
`isLoopbackHost` (`src/browserEgressModel.ts`), which mirrors the core's check case for case.
Suggestions come from bookmarks, listening ports (the Ports pane's list, 4.19), and recently visited
addresses (kept for the session, at most 50); arrows move through them, Enter opens one, and Escape
reverts the field. When the pane is 600 px wide or less (a container query on the pane body), the
toolbar wraps: the address field takes a row of its own, so it and its suggestions span the pane,
and the text buttons shrink before they overflow.

The start page, shown while the pane has no page, lists the listening ports as buttons and the
bookmarks. The star toggles the current page in `localBrowser.bookmarks` through `settings_set`.

The pane's title is the page's title, or the page's host before it has one, or "Local Browser".

### DevTools drawer

A drawer at the pane's bottom, resizable by its top edge, holds two panels, shown one at a time
by tab or, with Split on (the default), side by side (Console left, Network right) with a draggable divider
between them. Its open state, tab, height, split, and Console's share of the split width are
saved with the pane. Both read the event stream and keep their own buffers
(`ConsoleLog` holds 2,000 entries, `NetworkLog` 1,000 rows).

- **Console.** Level chips (log, info, warn, error), a text filter, Clear, and Preserve log. A
  top-frame navigation clears the console unless Preserve log is on. Exceptions show as errors.
- **Network.** One row per request with method, status, path, type, size, and time; type chips
  (All, Fetch/XHR, Doc, JS, CSS, Img, Other), a text filter, and Clear. A row opens request and
  response headers and the response body, fetched on demand with `browser_response_body`; JSON is
  indented and a binary body shows its size instead.

### Device sizes

`src/devicePresets.ts` lists Responsive (fills the pane), Phone 390x844, Phone large 430x932,
Tablet 820x1180, Laptop 1280x800, and Desktop 1920x1080, in CSS pixels. A fixed preset sits in a
centered box and is scaled down to fit the pane (`fitScale` never scales up); Rotate swaps width
and height. The choice is saved as the preset id, with `:rotated` appended when turned.

### App chords with a page focused

Keys typed into the out-of-process frame never reach `keys.ts` (4.5). While `browser_focus` names
a pane, `src-tauri/src/browser/chords.rs` handles WebView2's `AcceleratorKeyPressed` for key-down
events: a chord that matches an effective keybinding (defaults layered with the user's) is marked
handled, so the page never sees it, and sent as `browser://chord`; `src/browserChords.ts` turns it
into the same action `keys.ts` would dispatch. Chords with Ctrl or Alt, and bound bare function
keys, are forwarded; plain typing and unbound keys stay with the page. The `copy`, `paste`, and
`sendInput` actions are never forwarded, so Ctrl+C, Ctrl+V, and Shift+Enter keep reaching the
page. The matcher follows the keyboard layout the way the front end does (digits by position,
other keys by what the layout types), so Dvorak chords match. The keymap (`buildKeymap` in
`src/keymap.ts`) skips an invalid binding, such as an unknown action or `moveFocus` without a
direction, so each time it is built `LiveSettings` sends the core the `keys` of every binding it
accepted (`browser_chords`); a chord outside that list stays with the page. Until the first report,
every binding counts.

The pane reports focus by watching the app window blur while its frame is the active element, and
reports none when focus returns to the app, the pane collapses, or it is disposed.

### Saved state

The workspace saves `{ kind: "browser", url, devtools, device }` per pane (4.9); each field is
read leniently, with missing or invalid values falling back to the start page, a closed, split
drawer on Console, and Responsive. A file page saves its `file:///` URL, never the serving
address, whose token changes every launch. A pane saved on its start page (a null `url`) reopens on it;
only a pane created with no `url` at all opens on `localBrowser.homeUrl`. Bookmarks and the home page live in
settings (8), not in the workspace.

### Entry points

The kind menu (4.11) and the Launch menu (4.6, key **b**) open a pane on `localBrowser.homeUrl`, or on the start page when it is empty.
`bb browse [<url>] [--tab|-t] [--collapsed]` (3.13) opens one at an address in the same shorthand
as the address field and refuses a non-loopback address; a file path is resolved against the
shell's working folder. In the Files pane, an `.html` or `.htm` file's menu offers **Open in Local
Browser**. The Ports pane's Open button and a row's
double-click open the port in Local Browser, and the port and container menus offer **Open in
Local Browser** and **Open in system browser**. In a terminal, Ctrl+click on a loopback
link opens Local Browser beside the terminal, and Ctrl+Shift+click opens the system browser;
other links open the system browser as before (9).

### Limits

- Loopback and local HTML files only: no remote hosts, no `*.localhost`, no UNC paths.
- A file page reaches the web only as its trust level allows (3.21).
- `https` loads only with a certificate Windows trusts; there is no way to proceed past a
  certificate error.
- Frames nested in the page load only what the pane's own frame may (see Nested frames).
- No popups: the sandbox is `allow-scripts allow-forms allow-same-origin allow-modals`, with no
  `allow-popups` and no `allow-top-navigation`, and the frame's referrer policy is `no-referrer`.
- No downloads, extensions, or full DevTools window.
- In a debug build, `localhost` frames send no events (see Design).
