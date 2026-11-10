# Security

Section numbers are ids shared across every file in `docs/design/`, so a citation such as
"section 4.5" names one section wherever it lives; [the index](README.md#index) maps each to its file.

The app-wide measures are in [section 9 of the README](README.md#9-security). This file covers
the Local Browser pane (4.21), the one pane that runs code the app did not write.

## 9.1 Local Browser

A Local Browser pane runs whatever page it is pointed at: a dev server's app, a generated report,
or an HTML file someone sent. Every other pane renders data the app parsed itself; this one hands
a page a JavaScript engine. The design gives that page everything a web page normally has and
nothing more, and leans on Chromium and Windows to enforce it wherever they can, so the code we
maintain is a policy and not a sandbox.

### What is protected

In order of harm:

1. **The app.** A page that reached the Tauri IPC bridge could run any app command: spawn shells,
   write files, read Ship tokens.
2. **The shells.** A page that reached the hook receiver's `/cli` path could open panes and type
   into them.
3. **Local files.** A page that could read the disk, and then send what it read off the machine.
4. **Other local services.** Dev servers, the dashboard helper, and anything else on loopback.
5. **The user's attention.** Popups, downloads, prompts, and navigation away from the pane.

### Threats considered

- A dev server page with a compromised dependency.
- A generated report that loads a script from a CDN that serves something it should not.
- A downloaded HTML file written to read nearby files and send them away.
- A page that tries to reach the app's origin, or other loopback services, by navigation or
  DNS rebinding.

Out of scope: a Chromium sandbox escape (patched through WebView2 updates, which Windows delivers
on its own schedule), and malware already running as the user, which can read the disk directly.

### Measures we get without writing them

These come from Chromium, WebView2, or Windows, and hold whatever our code does.

| Measure | What it contains |
| --- | --- |
| Out-of-process frame with site isolation | A cross-origin frame runs in its own sandboxed renderer process, with no OS access and no access to the app's page |
| Same-origin policy and CORS | A page reads only its own origin's responses; other loopback ports are other origins, and none of our servers send CORS headers |
| `sandbox` attribute | No popups, no top navigation, no downloads (`allow-downloads` is not granted) |
| Permissions Policy defaults | Camera, microphone, location, and clipboard reading are off in a frame unless granted, and none are |
| App CSP `frame-src` | The app frames only `http(s)` on `localhost` and `127.0.0.1`; `*.localhost`, and so the release app's own `tauri.localhost` origin, can never be framed |
| CSP on file pages | Chromium enforces the trust level's request allowlist (3.21) on every fetch, subresource, and frame; a page cannot remove a header-delivered policy |
| Mark of the Web | Windows marks files that came from the internet; the core reads that mark, it does not guess |
| SmartScreen | WebView2 checks navigations and downloads against Microsoft's reputation list; nothing here relies on it covering a frame's other requests |

### Measures we enforce

Each rule lives in one place, with tests beside it.

**No channel to the app.** Nothing is injected into a framed page, and the app has no `message`
listener, so a page has nothing to call. The core reads the frame from outside over the DevTools
Protocol (4.21 Design). The frame's owner is read from the app's own DOM (`data-browser-pane`),
which the page cannot forge.

**No route to the app's origin.** `browser_policy::classify` refuses the app's origin, and the dev
server's port on every loopback host and scheme, for typed addresses, in-frame navigations,
redirects, and nested frames (4.21 Navigation policy).

**Hook receiver.** `/hook` and `/cli` require the `X-Bashboard-Token` header holding a per-launch
random token. A custom header forces a CORS preflight from any other origin, which the receiver
never answers, and the token exists only in pane environments and the core's memory, never in the
page. The file server (3.21) is a separate listener, so a file page is not even same-origin with
the receiver.

**Navigation leaves the frame only by a click.** A document navigation to a non-loopback address is
failed in the frame. From a dev server page an external `http(s)` address opens in the system
browser; from a file page it does not open until the user clicks Open, since a script can put data
in the address (4.21 Navigation policy).

**Header rewriting is narrow.** The core removes `X-Frame-Options` and the `frame-ancestors`
directive, and nothing else, only from loopback documents inside a Local Browser frame (4.21
Header rewriting). The rest of a page's CSP stays in force.

**File serving is scoped** (3.21):

- one origin per folder, so folders cannot read each other;
- a per-pane random token in every address, so a page that does not know it reads nothing;
- an exact `Host` check against DNS rebinding;
- canonicalized paths that must stay under the mount root, with no dot segments, no alternate data
  streams, and no directory listings;
- a drive root or the home folder mounts the single file, not the folder;
- `GET` and `HEAD` only, besides the CSP report path;
- `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and no CORS headers;
- a Downloaded page's mount serves only files that also carry Mark of the Web.

**Egress follows trust** (3.21 Trust levels). Reading local files and sending data out is the
combination that does harm, so a page outside a trusted folder may load from its own mount and
known CDNs, and anything else waits for the user to allow that host. A refused request is reported
to the pane, which names the host, so a page that wants a legitimate API is one click from working
and a page that wants to leak data is visible doing it.

### What is deliberately not done

**No heuristic detection.** The pane does not inspect request bodies or score pages as malicious. A
leak and a legitimate API call look the same on the wire, a heuristic is easy to slip past, and a
check that sometimes works teaches the user to trust it. Containment by origin, path, and egress
list holds whatever the page's intent.

**No script injection into pages.** Patching page APIs (removing `RTCPeerConnection`, wrapping
`fetch`) would mean running our code in the page's world, where the page can see and undo it, and
would break the rule that a framed page has no contact with the app.

### Known gaps

- **Trusted pages and allowed hosts.** A page in a trusted folder, or one whose host was allowed,
  can send anything its mount serves to that host. That is what trust means; folder-sized mounts
  keep the reach to that folder.
- **WebRTC.** CSP does not govern `RTCPeerConnection`, so a Local or Downloaded page could send
  data through a STUN or TURN server of its choosing. Closing this needs either a WebView2 switch
  that turns WebRTC off for the whole app or script injection, and both cost more than the risk
  here, which needs a page written specifically to use it.
- **DNS prefetch.** CSP does not govern `<link rel="dns-prefetch">`, so a page can make the
  machine resolve a name it picks, which leaks a few bytes to whoever runs that name's DNS server.
- **Downloads folder.** A Downloaded page in the Downloads folder can read the other downloads,
  since they carry the mark too; it cannot send them anywhere without an Allow the user confirmed.
- **Dev server pages** carry no trust levels: their CSP is the dev server's own. The server
  decides what it exposes, and the pane frames it as it is (4.21).
