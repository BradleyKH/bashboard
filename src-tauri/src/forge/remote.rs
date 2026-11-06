//! Turning a git remote URL into a `RepoRef` (docs/design.md section 3.20). Pure apart from
//! `gh_hosts` and `read_glab_hosts`, which read GitHub CLI's `hosts.yml` and GitLab CLI's
//! `config.yml`.

use std::collections::HashMap;
use std::path::PathBuf;

use super::types::{ProviderKind, RepoRef};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRemote {
    /// Lowercased host name, without a port.
    pub host: String,
    /// The port of an https remote, kept because the web and API URLs use it too. An ssh
    /// port says nothing about the web host, so it is dropped.
    pub port: Option<u16>,
    /// The `user@` of an https remote, which names the account to sign in as.
    pub user: Option<String>,
    pub path: Vec<String>,
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Escapes a path segment or query value; ADO project names often hold spaces.
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn split_path(path: &str) -> Option<Vec<String>> {
    let path = path.trim_matches('/');
    let path = path
        .strip_suffix(".git")
        .unwrap_or(path)
        .trim_end_matches('/');
    let segs: Vec<String> = path
        .split('/')
        .filter(|s| !s.is_empty())
        .map(percent_decode)
        .collect();
    if segs.is_empty() || segs.iter().any(|s| s == "." || s == "..") {
        return None;
    }
    Some(segs)
}

fn valid_host(host: &str) -> bool {
    // A single letter is a Windows drive (`C:/repo` looks like scp form).
    host.len() > 1
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// `[user@]host[:port]`, returning the user, host, and port.
fn split_authority(auth: &str) -> Option<(Option<String>, String, Option<u16>)> {
    let (user, hostport) = match auth.rsplit_once('@') {
        // Only the user name is kept; a `:password` part is dropped unread.
        Some((u, h)) => {
            let name = u.split(':').next().unwrap_or("");
            ((!name.is_empty()).then(|| percent_decode(name)), h)
        }
        None => (None, auth),
    };
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, Some(p.parse::<u16>().ok()?)),
        None => (hostport, None),
    };
    let host = host.to_ascii_lowercase();
    valid_host(&host).then_some((user, host, port))
}

/// Parses `https://[user@]host[:port]/a/b(.git)`, `ssh://[user@]host[:port]/a/b(.git)`, and
/// scp form `[user@]host:a/b(.git)`, plus every Azure DevOps form, which normalize to
/// `[org, project, repo]` on host `dev.azure.com`.
pub fn parse_remote(url: &str) -> Option<ParsedRemote> {
    let url = url.trim();
    if url.is_empty() || url.contains('\\') || url.contains(char::is_whitespace) {
        return None;
    }
    let parsed = if let Some(rest) = url.strip_prefix("https://") {
        let (auth, path) = rest.split_once('/')?;
        let (user, host, port) = split_authority(auth)?;
        let port = port.filter(|p| *p != 443);
        ParsedRemote {
            host,
            port,
            user,
            path: split_path(path)?,
        }
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        let (auth, path) = rest.split_once('/')?;
        let (_, host, _) = split_authority(auth)?;
        ParsedRemote {
            host,
            port: None,
            user: None,
            path: split_path(path)?,
        }
    } else if !url.contains("://") {
        let (auth, path) = url.split_once(':')?;
        if auth.contains('/') {
            return None;
        }
        let (_, host, port) = split_authority(auth)?;
        if port.is_some() {
            return None;
        }
        ParsedRemote {
            host,
            port: None,
            user: None,
            path: split_path(path)?,
        }
    } else {
        return None;
    };
    normalize_azure(parsed)
}

/// Rewrites the Azure DevOps forms to host `dev.azure.com` and `[org, project, repo]`; other
/// hosts pass through untouched.
fn normalize_azure(mut p: ParsedRemote) -> Option<ParsedRemote> {
    let ado = |p: &mut ParsedRemote, org: String, proj: String, repo: String| {
        p.host = "dev.azure.com".into();
        p.port = None;
        p.user = None;
        p.path = vec![org, proj, repo];
    };
    let path = p.path.clone();
    match p.host.as_str() {
        "dev.azure.com" => match path.as_slice() {
            [org, proj, git, repo] if git == "_git" => {
                ado(&mut p, org.clone(), proj.clone(), repo.clone())
            }
            // Azure DevOps names a project after its first repo, so the project may be omitted.
            [org, git, repo] if git == "_git" => ado(&mut p, org.clone(), repo.clone(), repo.clone()),
            _ => return None,
        },
        "ssh.dev.azure.com" | "vs-ssh.visualstudio.com" => match path.as_slice() {
            [v3, org, proj, repo] if v3 == "v3" => {
                ado(&mut p, org.clone(), proj.clone(), repo.clone())
            }
            _ => return None,
        },
        h if h.ends_with(".visualstudio.com") => {
            let org = h.trim_end_matches(".visualstudio.com").to_string();
            let rest = match path.as_slice() {
                [first, rest @ ..] if first.eq_ignore_ascii_case("DefaultCollection") => rest,
                all => all,
            };
            match rest {
                [proj, git, repo] if git == "_git" => ado(&mut p, org, proj.clone(), repo.clone()),
                [git, repo] if git == "_git" => ado(&mut p, org, repo.clone(), repo.clone()),
                _ => return None,
            }
        }
        _ => {}
    }
    Some(p)
}

fn builtin_kind(host: &str) -> Option<ProviderKind> {
    match host {
        "github.com" => Some(ProviderKind::Github),
        "bitbucket.org" => Some(ProviderKind::Bitbucket),
        "gitlab.com" => Some(ProviderKind::Gitlab),
        "dev.azure.com" => Some(ProviderKind::AzureDevOps),
        _ => None,
    }
}

/// GitHub's ssh-over-443 endpoint is github.com itself.
fn web_host(host: &str) -> &str {
    if host == "ssh.github.com" {
        "github.com"
    } else {
        host
    }
}

/// `glab_hosts` is called only for a host nothing else names, so a known host never reads
/// glab's config file.
fn kind_of(
    host: &str,
    hosts: &HashMap<String, ProviderKind>,
    gh_hosts: &[String],
    glab_hosts: impl FnOnce() -> Vec<String>,
) -> Option<ProviderKind> {
    let listed = |list: &[String]| list.iter().any(|h| h.eq_ignore_ascii_case(host));
    hosts
        .get(host)
        .copied()
        .or_else(|| builtin_kind(host))
        .or_else(|| listed(gh_hosts).then_some(ProviderKind::Github))
        .or_else(|| listed(&glab_hosts()).then_some(ProviderKind::Gitlab))
}

/// Picks the provider: the `ship.hosts` setting (keys already lowercased) wins, then the
/// well-known hosts, then a host GitHub CLI is signed in to is GitHub Enterprise Server, then a
/// host in GitLab CLI's config is self-managed GitLab.
/// `None` when the host is unknown or the path does not fit the provider.
pub fn classify(
    parsed: &ParsedRemote,
    hosts: &HashMap<String, ProviderKind>,
    gh_hosts: &[String],
) -> Option<RepoRef> {
    classify_with(parsed, hosts, gh_hosts, read_glab_hosts)
}

fn classify_with(
    parsed: &ParsedRemote,
    hosts: &HashMap<String, ProviderKind>,
    gh_hosts: &[String],
    glab_hosts: impl FnOnce() -> Vec<String>,
) -> Option<RepoRef> {
    let host = web_host(&parsed.host);
    let kind = kind_of(host, hosts, gh_hosts, glab_hosts)?;
    let authority = match parsed.port {
        Some(p) => format!("{host}:{p}"),
        None => host.to_string(),
    };
    let path = &parsed.path;
    let enc = |segs: &[String]| {
        segs.iter()
            .map(|s| percent_encode(s))
            .collect::<Vec<_>>()
            .join("/")
    };
    let web_url = match kind {
        ProviderKind::Github | ProviderKind::Bitbucket => {
            if path.len() != 2 {
                return None;
            }
            format!("https://{authority}/{}", enc(path))
        }
        ProviderKind::Gitlab => {
            if path.len() < 2 {
                return None;
            }
            format!("https://{authority}/{}", enc(path))
        }
        ProviderKind::AzureDevOps => match path.as_slice() {
            [org, proj, repo] => format!(
                "https://{authority}/{}/{}/_git/{}",
                percent_encode(org),
                percent_encode(proj),
                percent_encode(repo)
            ),
            _ => return None,
        },
    };
    Some(RepoRef {
        provider: kind,
        host: authority,
        path: path.clone(),
        web_url,
    })
}

/// A pinned repo's `<host>/<path...>`, or what someone pastes into the Add-repo box: that form,
/// an https, ssh, or scp remote URL, or a web URL into the repo (a pull request, a pipeline, a
/// file). A web URL's trailing page is dropped by the provider's path shape.
pub fn parse_repo_input(
    input: &str,
    hosts: &HashMap<String, ProviderKind>,
    gh_hosts: &[String],
) -> Option<RepoRef> {
    let input = input.trim();
    let input = input.split(['?', '#']).next().unwrap_or(input);
    let input = input
        .strip_prefix("http://")
        .map(|rest| format!("https://{rest}"))
        .unwrap_or_else(|| input.to_string());
    let mut parsed = if let Some(path) = azure_pin_path(&input) {
        ParsedRemote {
            host: "dev.azure.com".into(),
            port: None,
            user: None,
            path,
        }
    } else if input.contains("://") || is_scp_form(&input) {
        parse_remote(&input)?
    } else {
        parse_remote(&format!("https://{input}"))?
    };
    match kind_of(web_host(&parsed.host), hosts, gh_hosts, read_glab_hosts)? {
        ProviderKind::Github | ProviderKind::Bitbucket => parsed.path.truncate(2),
        // GitLab puts every repo page under a `-` segment.
        ProviderKind::Gitlab => {
            if let Some(dash) = parsed.path.iter().position(|s| s == "-") {
                parsed.path.truncate(dash);
            }
        }
        ProviderKind::AzureDevOps => {}
    }
    classify(&parsed, hosts, gh_hosts)
}

/// The Azure DevOps pin form `dev.azure.com/<org>/<project>/<repo>`, with or without `https://`.
/// Segments are the raw names a pin stores, so they may hold spaces, which `parse_remote`
/// rejects; percent-encoded names from a pasted address decode the same way. A leading `_` marks
/// a web page (`_git`, `_build`) rather than a name.
fn azure_pin_path(input: &str) -> Option<Vec<String>> {
    const HOST: &str = "dev.azure.com/";
    let rest = input.strip_prefix("https://").unwrap_or(input);
    let rest = rest.get(HOST.len()..).filter(|_| {
        rest.get(..HOST.len())
            .is_some_and(|h| h.eq_ignore_ascii_case(HOST))
    })?;
    let segs: Vec<String> = rest
        .trim_end_matches('/')
        .split('/')
        .map(percent_decode)
        .collect();
    let ok = segs.len() == 3
        && segs
            .iter()
            .all(|s| !s.trim().is_empty() && !s.starts_with('_') && s != "." && s != "..");
    ok.then_some(segs)
}

/// `host:path` rather than `host:port/path`: the text after the first colon is not a port.
fn is_scp_form(s: &str) -> bool {
    let Some((auth, rest)) = s.split_once(':') else {
        return false;
    };
    if auth.contains('/') {
        return false;
    }
    let port = rest.split('/').next().unwrap_or("");
    port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit())
}

/// The top-level keys of a `hosts.yml`, lowercased: every host GitHub CLI is signed in to.
pub fn parse_gh_hosts(text: &str) -> Vec<String> {
    text.lines()
        .filter(|l| !l.starts_with(char::is_whitespace) && !l.starts_with('#'))
        .filter_map(|l| l.trim_end().strip_suffix(':'))
        .map(|k| unquote(k).to_ascii_lowercase())
        .filter(|k| !k.is_empty())
        .collect()
}

fn unquote(s: &str) -> &str {
    let s = s.trim();
    s.strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .or_else(|| s.strip_prefix('\'').and_then(|x| x.strip_suffix('\'')))
        .unwrap_or(s)
}

/// GitHub CLI's config folder: `GH_CONFIG_DIR`, else `%APPDATA%\GitHub CLI`.
pub fn gh_config_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("GH_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("GitHub CLI"))
}

pub fn read_gh_hosts_yml() -> Option<String> {
    std::fs::read_to_string(gh_config_dir()?.join("hosts.yml")).ok()
}

pub fn gh_hosts() -> Vec<String> {
    read_gh_hosts_yml()
        .map(|t| parse_gh_hosts(&t))
        .unwrap_or_default()
}

/// The keys under the top-level `hosts:` of GitLab CLI's `config.yml`, lowercased and deduped.
/// Only key names are read, never a `token:` value.
pub fn parse_glab_hosts(text: &str) -> Vec<String> {
    let indent = |l: &str| l.len() - l.trim_start().len();
    let lines: Vec<&str> = text
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('#'))
        .collect();
    let Some(start) = lines
        .iter()
        .position(|l| indent(l) == 0 && l.trim_end() == "hosts:")
    else {
        return Vec::new();
    };
    let block = lines[start + 1..].iter().take_while(|l| indent(l) > 0);
    let Some(child) = lines.get(start + 1).map(|l| indent(l)).filter(|&n| n > 0) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for line in block.filter(|l| indent(l) == child) {
        let Some(key) = line.trim_end().strip_suffix(':') else {
            continue;
        };
        let key = unquote(key).to_ascii_lowercase();
        if !key.is_empty() && !out.contains(&key) {
            out.push(key);
        }
    }
    out
}

/// GitLab CLI's config folder, as glab resolves it: `GLAB_CONFIG_DIR`, then the legacy
/// `~/.config/glab-cli` when it holds a `config.yml`, then `glab-cli` under the XDG config home,
/// which on Windows is `XDG_CONFIG_HOME` or else `%LOCALAPPDATA%`.
pub fn glab_config_dir() -> Option<PathBuf> {
    let var = |name: &str| {
        std::env::var_os(name)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if let Some(d) = var("GLAB_CONFIG_DIR") {
        return Some(d);
    }
    if let Some(legacy) = var("USERPROFILE").map(|h| h.join(".config").join("glab-cli")) {
        if legacy.join("config.yml").is_file() {
            return Some(legacy);
        }
    }
    var("XDG_CONFIG_HOME")
        .or_else(|| var("LOCALAPPDATA"))
        .map(|d| d.join("glab-cli"))
}

pub fn read_glab_hosts() -> Vec<String> {
    glab_config_dir()
        .and_then(|d| std::fs::read_to_string(d.join("config.yml")).ok())
        .map(|t| parse_glab_hosts(&t))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(url: &str) -> Option<ParsedRemote> {
        parse_remote(url)
    }

    fn path(url: &str) -> Vec<String> {
        p(url).unwrap_or_else(|| panic!("{url} did not parse")).path
    }

    fn v(segs: &[&str]) -> Vec<String> {
        segs.iter().map(|s| s.to_string()).collect()
    }

    fn none() -> HashMap<String, ProviderKind> {
        HashMap::new()
    }

    fn cls(url: &str) -> Option<RepoRef> {
        classify(&p(url)?, &none(), &[])
    }

    #[test]
    fn https_forms() {
        let r = p("https://github.com/BradleyKH/bashboard.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.path, v(&["BradleyKH", "bashboard"]));
        assert_eq!(r.user, None);
        assert_eq!(r.port, None);
        assert_eq!(path("https://github.com/a/b"), v(&["a", "b"]));
        assert_eq!(path("https://github.com/a/b/"), v(&["a", "b"]));
        assert_eq!(path("https://github.com/a/b.git/"), v(&["a", "b"]));
        let r = p("https://bradley@bitbucket.org/keysys/repo.git").unwrap();
        assert_eq!(r.user.as_deref(), Some("bradley"));
        assert_eq!(r.host, "bitbucket.org");
        let r = p("https://user:secret@GitHub.com/a/b").unwrap();
        assert_eq!(r.user.as_deref(), Some("user"));
        assert_eq!(r.host, "github.com");
    }

    #[test]
    fn ports() {
        let r = p("https://ghe.example.com:8443/a/b.git").unwrap();
        assert_eq!(r.port, Some(8443));
        assert_eq!(p("https://github.com:443/a/b").unwrap().port, None);
        let r = p("ssh://git@ghe.example.com:2222/a/b.git").unwrap();
        assert_eq!(r.host, "ghe.example.com");
        assert_eq!(r.port, None);
        assert_eq!(r.path, v(&["a", "b"]));
        assert_eq!(p("https://host:notaport/a/b"), None);
    }

    #[test]
    fn ssh_and_scp_forms() {
        assert_eq!(path("ssh://git@github.com/a/b.git"), v(&["a", "b"]));
        assert_eq!(path("ssh://github.com/a/b"), v(&["a", "b"]));
        let r = p("git@github.com:BradleyKH/bashboard.git").unwrap();
        assert_eq!(r.host, "github.com");
        assert_eq!(r.user, None);
        assert_eq!(r.path, v(&["BradleyKH", "bashboard"]));
        assert_eq!(path("github.com:a/b"), v(&["a", "b"]));
        assert_eq!(
            path("git@gitlab.com:group/sub/proj.git"),
            v(&["group", "sub", "proj"])
        );
    }

    #[test]
    fn azure_devops_forms_normalize() {
        let want = v(&["my org", "My Project", "my repo"]);
        for url in [
            "https://dev.azure.com/my%20org/My%20Project/_git/my%20repo",
            "https://my%20org@dev.azure.com/my%20org/My%20Project/_git/my%20repo",
            "git@ssh.dev.azure.com:v3/my%20org/My%20Project/my%20repo",
            "my%20org@vs-ssh.visualstudio.com:v3/my%20org/My%20Project/my%20repo",
        ] {
            let r = p(url).unwrap_or_else(|| panic!("{url}"));
            assert_eq!(r.host, "dev.azure.com", "{url}");
            assert_eq!(r.path, want, "{url}");
            assert_eq!(r.user, None, "{url}");
        }
        for url in [
            "https://contoso.visualstudio.com/Proj/_git/Repo",
            "https://contoso.visualstudio.com/DefaultCollection/Proj/_git/Repo",
        ] {
            let r = p(url).unwrap();
            assert_eq!(r.host, "dev.azure.com");
            assert_eq!(r.path, v(&["contoso", "Proj", "Repo"]));
        }
        let r = cls("https://dev.azure.com/o/My%20Project/_git/r").unwrap();
        assert_eq!(r.provider, ProviderKind::AzureDevOps);
        assert_eq!(r.web_url, "https://dev.azure.com/o/My%20Project/_git/r");
        assert_eq!(p("https://dev.azure.com/o/p/r"), None);
    }

    #[test]
    fn azure_devops_without_a_project_repeats_the_repo() {
        for url in [
            "https://dev.azure.com/contoso/_git/Repo",
            "https://contoso@dev.azure.com/contoso/_git/Repo",
            "https://contoso.visualstudio.com/_git/Repo",
            "https://contoso.visualstudio.com/DefaultCollection/_git/Repo",
        ] {
            let r = p(url).unwrap_or_else(|| panic!("{url}"));
            assert_eq!(r.host, "dev.azure.com", "{url}");
            assert_eq!(r.path, v(&["contoso", "Repo", "Repo"]), "{url}");
        }
        let r = cls("https://dev.azure.com/contoso/_git/Repo").unwrap();
        assert_eq!(r.web_url, "https://dev.azure.com/contoso/Repo/_git/Repo");
        // Near misses: no repo, or a stray segment, still reject.
        for url in [
            "https://dev.azure.com/contoso/_git",
            "https://dev.azure.com/contoso/_git/",
            "https://contoso.visualstudio.com/_git",
            "https://dev.azure.com/contoso/_build/Repo",
        ] {
            assert_eq!(p(url), None, "{url}");
        }
    }

    #[test]
    fn azure_devops_pin_form() {
        // A pin is `host/owner/name` with the raw, decoded names, so spaces are literal.
        for s in [
            "dev.azure.com/my org/My Project/my repo",
            "https://dev.azure.com/my org/My Project/my repo",
            "dev.azure.com/my%20org/My%20Project/my%20repo",
            "DEV.AZURE.COM/my org/My Project/my repo/",
        ] {
            let r = input(s).unwrap_or_else(|| panic!("{s}"));
            assert_eq!(r.provider, ProviderKind::AzureDevOps, "{s}");
            assert_eq!(r.host, "dev.azure.com", "{s}");
            assert_eq!(r.path, v(&["my org", "My Project", "my repo"]), "{s}");
            assert_eq!(
                r.web_url, "https://dev.azure.com/my%20org/My%20Project/_git/my%20repo",
                "{s}"
            );
        }
        let r = input("dev.azure.com/o/p/r").unwrap();
        assert_eq!(r.path, v(&["o", "p", "r"]));
        // Round trip through the id the front end builds from the resolved repo.
        assert_eq!(
            repo_key(&input("dev.azure.com/my org/My Project/my repo").unwrap()),
            "dev.azure.com/my org/My Project/my repo"
        );
        // Near misses: two segments, four segments that are not `_git`, and web pages.
        for s in [
            "dev.azure.com/o/p",
            "dev.azure.com/o",
            "dev.azure.com/o/p/r/extra",
            "dev.azure.com/o/p/_git",
            "dev.azure.com/o/p/_build",
            "dev.azure.com/o//r",
        ] {
            assert_eq!(input(s), None, "{s}");
        }
    }

    #[test]
    fn junk_is_none() {
        for url in [
            "",
            "   ",
            "not a url",
            "C:/repos/thing",
            "C:\\repos\\thing",
            "/home/me/repo.git",
            "../other",
            "file:///c/repos/x",
            "https://",
            "https://github.com",
            "https://github.com/",
            "git@github.com:",
            "ftp://github.com/a/b",
            "https://bad host/a/b",
        ] {
            assert_eq!(p(url), None, "{url:?}");
        }
    }

    #[test]
    fn classifies_well_known_hosts() {
        let g = cls("git@github.com:a/b.git").unwrap();
        assert_eq!(g.provider, ProviderKind::Github);
        assert_eq!(g.host, "github.com");
        assert_eq!(g.path, v(&["a", "b"]));
        assert_eq!(g.web_url, "https://github.com/a/b");
        let b = cls("https://me@bitbucket.org/keysys/repo.git").unwrap();
        assert_eq!(b.provider, ProviderKind::Bitbucket);
        assert_eq!(b.web_url, "https://bitbucket.org/keysys/repo");
        let l = cls("git@gitlab.com:group/sub/proj.git").unwrap();
        assert_eq!(l.provider, ProviderKind::Gitlab);
        assert_eq!(l.web_url, "https://gitlab.com/group/sub/proj");
        assert_eq!(
            cls("ssh://git@ssh.github.com:443/a/b.git").unwrap().host,
            "github.com"
        );
        // GitHub and Bitbucket need exactly owner and name.
        assert_eq!(cls("https://github.com/a/b/c"), None);
        assert_eq!(cls("https://bitbucket.org/a"), None);
        assert_eq!(cls("https://unknown.example.com/a/b"), None);
    }

    #[test]
    fn github_enterprise_from_gh_hosts() {
        let gh = vec!["github.com".to_string(), "ghe.example.com".to_string()];
        let r = classify(
            &p("https://ghe.example.com:8443/team/app.git").unwrap(),
            &none(),
            &gh,
        )
        .unwrap();
        assert_eq!(r.provider, ProviderKind::Github);
        assert_eq!(r.host, "ghe.example.com:8443");
        assert_eq!(r.web_url, "https://ghe.example.com:8443/team/app");
        let r = classify(
            &p("git@GHE.example.com:team/app.git").unwrap(),
            &none(),
            &gh,
        )
        .unwrap();
        assert_eq!(r.host, "ghe.example.com");
        assert_eq!(r.web_url, "https://ghe.example.com/team/app");
    }

    #[test]
    fn forge_hosts_setting_wins() {
        let mut hosts = HashMap::new();
        hosts.insert("code.corp.example".to_string(), ProviderKind::Gitlab);
        hosts.insert("github.com".to_string(), ProviderKind::Bitbucket);
        let gh = vec!["code.corp.example".to_string()];
        let r = classify(&p("git@Code.Corp.Example:g/s/p.git").unwrap(), &hosts, &gh).unwrap();
        assert_eq!(r.provider, ProviderKind::Gitlab);
        assert_eq!(r.web_url, "https://code.corp.example/g/s/p");
        let r = classify(&p("https://github.com/a/b").unwrap(), &hosts, &[]).unwrap();
        assert_eq!(r.provider, ProviderKind::Bitbucket);
    }

    /// A pin's identity: the host (with any port) and path, joined by `/`.
    fn repo_key(repo: &RepoRef) -> String {
        format!("{}/{}", repo.host, repo.path.join("/"))
    }

    fn input(s: &str) -> Option<RepoRef> {
        parse_repo_input(s, &none(), &[])
    }

    #[test]
    fn repo_input_bare_and_remote_forms() {
        let want = |s: &str, kind: ProviderKind, key: &str| {
            let r = input(s).unwrap_or_else(|| panic!("{s} did not parse"));
            assert_eq!((r.provider, repo_key(&r).as_str()), (kind, key), "{s}");
        };
        use ProviderKind::{Bitbucket, Github};
        for s in [
            "bitbucket.org/keysys/kweb",
            "  Bitbucket.org/keysys/kweb/  ",
            "https://bitbucket.org/keysys/kweb.git",
            "https://me@bitbucket.org/keysys/kweb.git",
            "git@bitbucket.org:keysys/kweb.git",
            "ssh://git@bitbucket.org/keysys/kweb.git",
        ] {
            want(s, Bitbucket, "bitbucket.org/keysys/kweb");
        }
        for s in [
            "github.com/a/b",
            "github.com:a/b",
            "git@github.com:a/b.git",
            "ssh://git@ssh.github.com:443/a/b.git",
            "http://github.com/a/b",
        ] {
            want(s, Github, "github.com/a/b");
        }
        // A pin's key parses back to itself.
        let r = input("bitbucket.org/keysys/kweb").unwrap();
        assert_eq!(input(&repo_key(&r)), Some(r));
    }

    #[test]
    fn repo_input_web_urls_drop_the_page() {
        for s in [
            "https://github.com/a/b/pull/12",
            "https://github.com/a/b/actions/runs/99?query=x",
            "https://github.com/a/b#readme",
            "github.com/a/b/tree/main/src",
        ] {
            assert_eq!(repo_key(&input(s).unwrap()), "github.com/a/b", "{s}");
        }
        for s in [
            "https://bitbucket.org/keysys/kweb/pipelines/results/512",
            "https://bitbucket.org/keysys/kweb/pull-requests/7/overview",
            "https://bitbucket.org/keysys/kweb/src/main/",
        ] {
            assert_eq!(
                repo_key(&input(s).unwrap()),
                "bitbucket.org/keysys/kweb",
                "{s}"
            );
        }
    }

    #[test]
    fn repo_input_ports_and_gitlab_paths() {
        let gh = vec!["ghe.example.com".to_string()];
        for s in [
            "ghe.example.com:8443/team/app",
            "https://ghe.example.com:8443/team/app/pulls",
        ] {
            let r = parse_repo_input(s, &none(), &gh).unwrap_or_else(|| panic!("{s}"));
            assert_eq!(r.provider, ProviderKind::Github);
            assert_eq!(r.host, "ghe.example.com:8443");
            assert_eq!(r.path, v(&["team", "app"]));
            assert_eq!(r.web_url, "https://ghe.example.com:8443/team/app");
            assert_eq!(repo_key(&r), "ghe.example.com:8443/team/app");
        }
        for s in [
            "gitlab.com/group/sub/proj",
            "git@gitlab.com:group/sub/proj.git",
            "https://gitlab.com/group/sub/proj/-/merge_requests/3",
        ] {
            let r = input(s).unwrap_or_else(|| panic!("{s}"));
            assert_eq!(r.provider, ProviderKind::Gitlab, "{s}");
            assert_eq!(r.path, v(&["group", "sub", "proj"]), "{s}");
        }
        let mut hosts = HashMap::new();
        hosts.insert("code.corp.example".to_string(), ProviderKind::Bitbucket);
        let r = parse_repo_input("code.corp.example/ws/slug/browse", &hosts, &[]).unwrap();
        assert_eq!(
            (r.provider, r.path.clone()),
            (ProviderKind::Bitbucket, v(&["ws", "slug"]))
        );
    }

    #[test]
    fn repo_input_junk_is_none() {
        for s in [
            "",
            "github.com",
            "github.com/",
            "github.com/a",
            "unknown.example.com/a/b",
            "C:/repos/thing",
            "not a repo",
            "ftp://github.com/a/b",
        ] {
            assert_eq!(input(s), None, "{s:?}");
        }
    }

    #[test]
    fn parses_gh_hosts_top_level_keys() {
        assert_eq!(
            parse_gh_hosts(super::super::auth::tests::SAMPLE_HOSTS_YML),
            v(&["github.com", "ghe.example.com"])
        );
        assert!(parse_gh_hosts("").is_empty());
    }

    #[test]
    fn gh_hosts_output_never_holds_a_token() {
        let out = parse_gh_hosts(super::super::auth::tests::SAMPLE_HOSTS_YML).join("\n");
        assert!(!out.contains("gho_"));
    }

    /// A glab `config.yml` with two hosts (one repeated in another case); the tokens are fake.
    const SAMPLE_GLAB_CONFIG: &str = "\
# What protocol to use when performing Git operations.
git_protocol: ssh
editor:
hosts:
    gitlab.com:
        # Your GitLab access token.
        token: glpat-FAKEgitlabToken00
        api_host: gitlab.com
        user: alice
    gitlab.example.com:
        token: glpat-FAKEselfManaged0
        api_protocol: https
    GitLab.Example.com:
        token: glpat-FAKEduplicate000
no_prompt: false
";

    #[test]
    fn parses_glab_hosts() {
        assert_eq!(
            parse_glab_hosts(SAMPLE_GLAB_CONFIG),
            v(&["gitlab.com", "gitlab.example.com"])
        );
        assert!(parse_glab_hosts("").is_empty());
        assert!(parse_glab_hosts("git_protocol: ssh\nhosts:\n").is_empty());
    }

    #[test]
    fn glab_hosts_output_never_holds_a_token() {
        let out = parse_glab_hosts(SAMPLE_GLAB_CONFIG).join("\n");
        assert!(!out.contains("glpat"), "{out}");
        assert!(!out.contains("token"), "{out}");
    }

    #[test]
    fn self_managed_gitlab_from_glab_hosts() {
        let glab = || v(&["gitlab.example.com"]);
        let parsed = p("git@gitlab.example.com:group/sub/app.git").unwrap();
        let r = classify_with(&parsed, &none(), &[], glab).unwrap();
        assert_eq!(r.provider, ProviderKind::Gitlab);
        assert_eq!(r.web_url, "https://gitlab.example.com/group/sub/app");
        let mut hosts = none();
        hosts.insert("gitlab.example.com".into(), ProviderKind::Github);
        let parsed = p("https://gitlab.example.com/team/app.git").unwrap();
        let r = classify_with(&parsed, &hosts, &[], glab).unwrap();
        assert_eq!(r.provider, ProviderKind::Github, "ship.hosts wins");
        let parsed = p("https://other.example.com/team/app.git").unwrap();
        assert_eq!(classify_with(&parsed, &none(), &[], glab), None);
    }
}
