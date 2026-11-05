//! Turning a git remote URL into a `RepoRef` (docs/design.md section 3.20). Pure apart from
//! `gh_hosts`, which reads GitHub CLI's `hosts.yml`.

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

/// Picks the provider: the `forge.hosts` setting (keys already lowercased) wins, then the
/// well-known hosts, then a host GitHub CLI is signed in to is GitHub Enterprise Server.
/// `None` when the host is unknown or the path does not fit the provider.
pub fn classify(
    parsed: &ParsedRemote,
    hosts: &HashMap<String, ProviderKind>,
    gh_hosts: &[String],
) -> Option<RepoRef> {
    // GitHub's ssh-over-443 endpoint is github.com itself.
    let host = if parsed.host == "ssh.github.com" {
        "github.com"
    } else {
        parsed.host.as_str()
    };
    let kind = hosts
        .get(host)
        .copied()
        .or_else(|| builtin_kind(host))
        .or_else(|| {
            gh_hosts
                .iter()
                .any(|h| h.eq_ignore_ascii_case(host))
                .then_some(ProviderKind::Github)
        })?;
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
}
