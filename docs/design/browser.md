# Local Browser

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

## 4.21 Local Browser

The `browser` pane kind (4.11) shows a dev server's page beside the terminals that run it, with
URL entry, Back, Forward, Reload, Home, bookmarks, device sizes, and a drawer holding a Console
and a Network panel. It is limited to loopback: plain `http` on `localhost` or `127.0.0.1`, on any
port. The front end is `src/localBrowserPane.ts` (`LocalBrowserPane`) with its
chrome in `src/browserToolbar.ts` and `src/browserDevtools.ts`; the core side is
`src-tauri/src/browser.rs`, `src-tauri/src/browser/chords.rs`, and `src-tauri/src/browser_policy.rs`.

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
session and releases it with `Runtime.runIfWaitingForDebugger`. The pane's attachment must exist
before the frame's first document is requested, so `LocalBrowserPane` calls `browser_attach`
before it sets the frame's `src`. On non-Windows builds the commands return an error.

**Debug builds.** The app itself is served from `localhost:1420`, so a `localhost:*` frame is
same-site with it and may stay in the app's process; no session attaches and no events arrive,
though blocking and header rewriting still work. Use `127.0.0.1` to test in a debug build.
Release builds (`http://tauri.localhost`) are unaffected.

### Frame to pane correlation

Every frame carries `data-browser-pane="<paneId>"`. When a session attaches, the core asks the
main session for the frame's owner (`DOM.getFrameOwner`), describes that node (`DOM.describeNode`),
and reads the attribute from an `iframe` element. That reads the app's own DOM, which the framed
page cannot forge (`window.name` could be). A session whose frame has no such owner is left
unmonitored, and its documents pass through untouched. The registry maps sessions to panes and
panes to their event channels behind one mutex; a detached or destroyed target removes its entry,
and `browser_detach` drops the channel.

### Navigation policy

`browser_policy::classify` sorts every document URL into three classes, and `bb browse` (3.13)
shares its loopback rule:

| Class | URLs | Result |
| --- | --- | --- |
| Allowed | `http` on `localhost` or `127.0.0.1`, no userinfo, not the app | Loads in the frame |
| External | `http` or `https` on any other host | Failed, then opened in the system browser |
| Refused | Other schemes, `https` loopback, `*.localhost`, hosts that merely look local, the app's own origin | Failed, with a notice in the pane |

The app's origin is read from the Tauri configuration at runtime, never a fixed port, and the
refusal applies to the app's port on every loopback host, since all of them reach the same dev
server. The pane's address field applies the same rules (`normalizeInput` in
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
returning it to the page it showed, without reporting the error page's URL or title. A navigation
reported there is remembered, so when Fetch does see it (debug builds) the pane is not told twice.
The pane also takes an error page or failed document request that follows a `blocked` event within
a few seconds as that navigation's, not as an unreachable server.
A document that fails to load (a `chrome-error://` frame, or a failed document request) shows a
"nothing is listening" overlay with a Retry button. Nested iframes inside the framed page are not
policed; only the pane's own frame is.

### Header rewriting

A dev server may send `X-Frame-Options` or a `frame-ancestors` directive that forbids framing.
The core rewrites the response for loopback documents inside a Local Browser frame, at the
Response stage: it removes `X-Frame-Options`, drops only the `frame-ancestors` directive from
`Content-Security-Policy` and `Content-Security-Policy-Report-Only` (the rest of the policy
stays), and drops the encoding and length headers, since the body it hands back is already
decoded. A response with no framing header, a redirect, or a non-loopback URL passes through
unchanged.

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
| `navigated` | `url`, `title?` |
| `navigatedInPage` | `url` (a hash or `history.pushState` change) |
| `title` | `title` (can arrive twice for one navigation; the pane de-duplicates) |
| `blocked` | `url`, `external` |
| `console` | `level`, `text`, `source?`, `url?`, `line?`, `timestamp` |
| `exception` | `text`, `url?`, `line?`, `timestamp` |
| `request` | `requestId`, `url`, `method`, `resourceType`, `timestamp` |
| `response` | `requestId`, `status`, `statusText`, `mimeType`, `headers`, `timestamp` |
| `finished` | `requestId`, `encodedLength`, `timestamp` |
| `failed` | `requestId`, `errorText`, `canceled`, `timestamp` |
| `loadState` | `loading` |

Every `timestamp` is milliseconds since the Unix epoch. Console and exception text is cut at 10
KB. Page events count only for the frame's root frame, not frames nested in the page.

The commands are `browser_attach(paneId, onEvent)`, `browser_detach(paneId)`,
`browser_history(paneId, delta)`, `browser_reload(paneId, ignoreCache)`,
`browser_response_body(paneId, requestId)` (returning the body and whether it is base64), and
`browser_focus(paneId | null)`, wrapped by `src/browserApi.ts`. A frame target has no navigation
history to query, so Back, Forward, and Reload run `history.go(delta)` and `location.reload()` in
the frame's session; a hard reload also turns the cache off for that session.

### Chrome

The toolbar has Back, Forward, Reload (Shift+click bypasses the cache), Home, the address field,
a bookmark star, a Bookmarks menu, a device size menu, and a DevTools button with a badge counting
console errors and exceptions. Home opens `localBrowser.homeUrl` (8), or the start page when it
is empty. The address field accepts a bare port (`5173`), `:port`, `host:port/path`, or a full
loopback URL; a missing host means `localhost`. Anything else shows a message by the field saying
that only loopback addresses open. Suggestions come from bookmarks, listening ports (the Ports
pane's list, 4.19), and recently visited addresses (kept for the session, at most 50); arrows move
through them, Enter opens one, and Escape reverts the field.

The start page, shown while the pane has no page, lists the listening ports as buttons and the
bookmarks. The star toggles the current page in `localBrowser.bookmarks` through `settings_set`.

The pane's title is the page's title, or the page's host before it has one, or "Local Browser".

### DevTools drawer

A drawer at the pane's bottom, resizable by its top edge, holds two panels; its open state, tab,
and height are saved with the pane. Both read the event stream and keep their own buffers
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
other keys by what the layout types), so Dvorak chords match.

The pane reports focus by watching the app window blur while its frame is the active element, and
reports none when focus returns to the app, the pane collapses, or it is disposed.

### Saved state

The workspace saves `{ kind: "browser", url, devtools, device }` per pane (4.9); each field is
read leniently, with missing or invalid values falling back to the start page, a closed drawer on
Console, and Responsive. A page reloads when its tab is hidden and shown again. Bookmarks and the
home page live in settings (8), not in the workspace.

### Entry points

The kind menu (4.11) and the Launch menu (4.6, key **b**) open a pane on `localBrowser.homeUrl`, or on the start page when it is empty.
`bb browse [<url>] [--tab|-t] [--collapsed]` (3.13) opens one at an address in the same shorthand
as the address field and refuses a non-loopback address. The Ports pane's Open button and a row's
double-click open the port in Local Browser, and the port and container menus offer **Open in
Local Browser** and **Open in system browser**. In a terminal, Ctrl+click on a loopback `http`
link opens Local Browser beside the terminal, and Ctrl+Shift+click opens the system browser;
other links open the system browser as before (9).

### Limits

- Loopback `http` only: no `https`, no remote hosts, no `*.localhost`.
- No popups: the sandbox is `allow-scripts allow-forms allow-same-origin allow-modals`, with no
  `allow-popups` and no `allow-top-navigation`, and the frame's referrer policy is `no-referrer`.
- No downloads, extensions, or full DevTools window.
- In a debug build, `localhost` frames send no events (see Design).
