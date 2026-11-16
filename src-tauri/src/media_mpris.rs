//! The pure half of the Linux Media worker: what an MPRIS player reports, mapped to the dashboard's
//! `MediaSnapshot`, and the rules for which player to follow (docs/design/dashboard.md section 3.29).
//!
//! Nothing here touches D-Bus, so the worker reads each property into `PlayerProps` and these
//! functions decide what to show. The module is built on every OS so its tests run in each CI job,
//! but only the Linux worker calls it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::media::MediaSnapshot;

/// Every MPRIS player owns a bus name that starts with this.
pub const BUS_PREFIX: &str = "org.mpris.MediaPlayer2.";

/// The `Metadata` entries the section uses.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TrackMeta {
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    /// `mpris:length`, in microseconds.
    pub length_us: Option<i64>,
    pub art_url: Option<String>,
    /// `mpris:trackid`, an object path; `SetPosition` needs it.
    pub track_id: Option<String>,
}

/// What the worker reads from one player.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PlayerProps {
    /// The root interface's `Identity`.
    pub identity: String,
    pub bus_name: String,
    /// `Playing`, `Paused`, or `Stopped`.
    pub playback_status: String,
    pub can_play: bool,
    pub can_pause: bool,
    pub can_go_next: bool,
    pub can_go_previous: bool,
    pub can_seek: bool,
    pub can_control: bool,
    /// `None` when the player has no `Shuffle` property.
    pub shuffle: Option<bool>,
    /// `None`, `Track`, or `Playlist`; `None` when the player has no `LoopStatus` property.
    pub loop_status: Option<String>,
    /// `Position`, in microseconds.
    pub position_us: i64,
    /// `None` when the player has no `Volume` property.
    pub volume: Option<f64>,
    pub metadata: TrackMeta,
}

pub fn is_player_bus_name(name: &str) -> bool {
    name.starts_with(BUS_PREFIX)
}

/// The section's snapshot of one player. `art_id` comes from `art_id_for` (0 when no art could be
/// loaded) and `now_ms` is Unix ms, the time the position was read.
pub fn snapshot(props: &PlayerProps, art_id: u64, now_ms: u64) -> MediaSnapshot {
    let meta = &props.metadata;
    let artist = meta
        .artists
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    MediaSnapshot {
        app: app_name(&props.identity, &props.bus_name),
        title: meta.title.clone(),
        artist,
        album: meta.album.clone(),
        art_id,
        playing: props.playback_status == "Playing",
        can_play_pause: props.can_control && (props.can_play || props.can_pause),
        can_next: props.can_go_next,
        can_previous: props.can_go_previous,
        can_seek: props.can_seek,
        shuffle: props.shuffle,
        repeat: props.loop_status.as_deref().and_then(loop_status_to_repeat),
        position_ms: micros_to_ms(props.position_us),
        duration_ms: meta.length_us.map_or(0, micros_to_ms),
        position_at: now_ms,
        volume: clamp_volume(props.volume),
        muted: false,
    }
}

/// Microseconds to ms; a negative value (a player that has not set the position) is 0.
fn micros_to_ms(us: i64) -> u64 {
    u64::try_from(us / 1000).unwrap_or(0)
}

/// A player without a `Volume` property shows full volume, which is what a player with no gain
/// stage plays at.
fn clamp_volume(volume: Option<f64>) -> f32 {
    match volume {
        Some(v) if v.is_finite() => v.clamp(0.0, 1.0) as f32,
        Some(_) => 0.0,
        None => 1.0,
    }
}

/// MPRIS `LoopStatus` to the snapshot's `repeat`; `None` for a value the section does not know.
pub fn loop_status_to_repeat(status: &str) -> Option<&'static str> {
    match status {
        "None" => Some("none"),
        "Track" => Some("track"),
        "Playlist" => Some("list"),
        _ => None,
    }
}

/// The snapshot's `repeat` to the MPRIS `LoopStatus` to write; an unknown value turns repeat off.
pub fn repeat_to_loop_status(repeat: &str) -> &'static str {
    match repeat {
        "track" => "Track",
        "list" => "Playlist",
        _ => "None",
    }
}

/// The name shown for a player: its `Identity`, else the bus name's suffix without the
/// `.instance123` part that players with several windows add.
pub fn app_name(identity: &str, bus_name: &str) -> String {
    let identity = identity.trim();
    if !identity.is_empty() {
        return identity.to_string();
    }
    let suffix = bus_name.strip_prefix(BUS_PREFIX).unwrap_or(bus_name);
    let name = suffix.find(".instance").map_or(suffix, |at| &suffix[..at]);
    if name.is_empty() {
        bus_name.to_string()
    } else {
        name.to_string()
    }
}

/// Which player to follow. A playing player wins, and the current one stays while it is still
/// playing or when nothing plays; otherwise the most recently changed player (the earliest listed
/// on a tie). Each candidate is its bus name, whether it is playing, and when it last changed.
pub fn choose_player<S: AsRef<str>>(
    candidates: &[(S, bool, u64)],
    current: Option<&str>,
) -> Option<String> {
    let any_playing = candidates.iter().any(|(_, playing, _)| *playing);
    let kept = current.and_then(|c| candidates.iter().find(|(n, _, _)| n.as_ref() == c));
    if let Some((name, playing, _)) = kept
        && (*playing || !any_playing)
    {
        return Some(name.as_ref().to_string());
    }
    let mut best: Option<&(S, bool, u64)> = None;
    for candidate in candidates.iter().filter(|c| c.1 == any_playing) {
        if best.is_none_or(|b| candidate.2 > b.2) {
            best = Some(candidate);
        }
    }
    best.map(|(name, _, _)| name.as_ref().to_string())
}

/// A stable id for an art URL (FNV-1a), so the id changes exactly when the art does; 0 for none.
pub fn art_id_for(url: &str) -> u64 {
    if url.is_empty() {
        return 0;
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    // 0 is reserved for "no art".
    hash.max(1)
}

/// How far a freshly read position may stray from where the last snapshot's would have counted
/// to before it counts as a seek.
const POSITION_SLACK_MS: u64 = 1500;

/// Keeps the previous snapshot's position and its time when the fresh read only shows the time
/// passing, so a refresh caused by something else does not emit a new snapshot just because the
/// clock moved. MPRIS players do not signal position changes, so the worker reads it on every
/// refresh.
pub fn settle_position(prev: Option<&MediaSnapshot>, next: &mut MediaSnapshot) {
    let Some(prev) = prev else { return };
    if prev.playing != next.playing {
        return;
    }
    let elapsed = if prev.playing {
        next.position_at.saturating_sub(prev.position_at)
    } else {
        0
    };
    let expected = prev.position_ms.saturating_add(elapsed);
    if expected.abs_diff(next.position_ms) <= POSITION_SLACK_MS {
        next.position_ms = prev.position_ms;
        next.position_at = prev.position_at;
    }
}

/// The path bytes of a local `file://` URL (an empty or `localhost` host), percent-decoded; `None`
/// for any other URL or a malformed escape.
pub fn file_url_path(url: &str) -> Option<Vec<u8>> {
    let rest = url.strip_prefix("file://")?;
    let path = rest.strip_prefix("localhost").unwrap_or(rest);
    if !path.starts_with('/') {
        return None;
    }
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            if !hex.iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    Some(out)
}

/// How the worker should load the art for a URL it has just started following.
#[derive(Debug, PartialEq, Eq)]
pub enum ArtLoad {
    /// Nothing to start: no art, the same URL, or a fetch for it is already running.
    Nothing,
    /// Load it on the worker thread (a local file, or a URL that fails at once).
    Here,
    /// Fetch it on a thread of its own and report back through `ArtState::loaded`.
    Fetch,
}

/// The followed player's art: its URL, the JPEG bytes once loaded (empty until then, or for good
/// when loading failed), and the remote URLs being fetched. Remote art loads off the worker thread
/// so a slow server cannot outlast the five seconds a `Media::ask` waits for the worker.
#[derive(Debug, Default)]
pub struct ArtState {
    url: String,
    bytes: Vec<u8>,
    fetching: std::collections::HashSet<String>,
}

impl ArtState {
    /// Follows `url`, dropping the previous art.
    pub fn follow(&mut self, url: &str) -> ArtLoad {
        if url == self.url {
            return ArtLoad::Nothing;
        }
        self.url = url.to_string();
        self.bytes = Vec::new();
        if url.is_empty() {
            ArtLoad::Nothing
        } else if !(url.starts_with("https://") || url.starts_with("http://")) {
            ArtLoad::Here
        } else if self.fetching.insert(url.to_string()) {
            ArtLoad::Fetch
        } else {
            ArtLoad::Nothing
        }
    }

    /// Takes the bytes loaded for `url`; true when they are the current art, false when the player
    /// has moved on to another URL since.
    pub fn loaded(&mut self, url: &str, bytes: Vec<u8>) -> bool {
        self.fetching.remove(url);
        if url != self.url {
            return false;
        }
        self.bytes = bytes;
        true
    }

    /// The id for the snapshot: 0 until bytes are ready, so the page fetches them only once they
    /// exist and again whenever the art changes.
    pub fn id(&self) -> u64 {
        if self.bytes.is_empty() {
            0
        } else {
            art_id_for(&self.url)
        }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_art_is_fetched_once_and_late_results_are_dropped() {
        let mut art = ArtState::default();
        assert_eq!(art.follow(""), ArtLoad::Nothing);
        assert_eq!(art.follow("file:///tmp/a.png"), ArtLoad::Here);
        assert!(art.loaded("file:///tmp/a.png", vec![1]));
        assert_eq!(art.id(), art_id_for("file:///tmp/a.png"));

        let a = "https://example.com/a.jpg";
        let b = "https://example.com/b.jpg";
        assert_eq!(art.follow(a), ArtLoad::Fetch);
        // No art shows while the fetch runs.
        assert_eq!((art.id(), art.bytes().len()), (0, 0));
        assert_eq!(art.follow(a), ArtLoad::Nothing);
        assert_eq!(art.follow(b), ArtLoad::Fetch);
        // Back to a while its fetch is still running: no second fetch.
        assert_eq!(art.follow(a), ArtLoad::Nothing);
        // b finishes after the player moved on: ignored.
        assert!(!art.loaded(b, vec![2]));
        assert_eq!(art.id(), 0);
        assert!(art.loaded(a, vec![3]));
        assert_eq!((art.id(), art.bytes()), (art_id_for(a), &[3u8][..]));
        // b's fetch is done, so following it again fetches again.
        assert_eq!(art.follow(b), ArtLoad::Fetch);
        // A failed fetch leaves no art and is not retried for the same URL.
        assert!(art.loaded(b, Vec::new()));
        assert_eq!(art.id(), 0);
        assert_eq!(art.follow(b), ArtLoad::Nothing);
    }

    fn props() -> PlayerProps {
        PlayerProps {
            identity: "Fake Player".into(),
            bus_name: "org.mpris.MediaPlayer2.fakeplayer".into(),
            playback_status: "Playing".into(),
            can_play: true,
            can_pause: true,
            can_go_next: true,
            can_go_previous: false,
            can_seek: true,
            can_control: true,
            shuffle: Some(true),
            loop_status: Some("Playlist".into()),
            position_us: 12_345_678,
            volume: Some(0.5),
            metadata: TrackMeta {
                title: "Song".into(),
                artists: vec!["A".into(), "B".into()],
                album: "Album".into(),
                length_us: Some(200_000_000),
                art_url: Some("file:///tmp/a.png".into()),
                track_id: Some("/track/1".into()),
            },
        }
    }

    #[test]
    fn snapshot_maps_a_full_player() {
        let s = snapshot(&props(), 7, 1_700_000_000_000);
        assert_eq!(s.app, "Fake Player");
        assert_eq!(s.title, "Song");
        assert_eq!(s.artist, "A, B");
        assert_eq!(s.album, "Album");
        assert_eq!(s.art_id, 7);
        assert!(s.playing);
        assert!(s.can_play_pause);
        assert!(s.can_next);
        assert!(!s.can_previous);
        assert!(s.can_seek);
        assert_eq!(s.shuffle, Some(true));
        assert_eq!(s.repeat, Some("list"));
        assert_eq!(s.position_ms, 12_345);
        assert_eq!(s.duration_ms, 200_000);
        assert_eq!(s.position_at, 1_700_000_000_000);
        assert_eq!(s.volume, 0.5);
        assert!(!s.muted);
    }

    #[test]
    fn snapshot_of_a_bare_player_uses_defaults() {
        let bare = PlayerProps {
            identity: String::new(),
            bus_name: "org.mpris.MediaPlayer2.vlc.instance4242".into(),
            playback_status: "Stopped".into(),
            ..Default::default()
        };
        let s = snapshot(&bare, 0, 5);
        assert_eq!(s.app, "vlc");
        assert_eq!(s.title, "");
        assert_eq!(s.artist, "");
        assert!(!s.playing);
        assert!(!s.can_play_pause);
        assert_eq!(s.shuffle, None);
        assert_eq!(s.repeat, None);
        assert_eq!(s.duration_ms, 0);
        assert_eq!(s.volume, 1.0);
    }

    #[test]
    fn only_playing_counts_as_playing() {
        for status in ["Paused", "Stopped", "", "playing"] {
            let p = PlayerProps {
                playback_status: status.into(),
                ..props()
            };
            assert!(!snapshot(&p, 0, 0).playing, "{status}");
        }
    }

    #[test]
    fn play_pause_needs_control_and_either_verb() {
        let with = |can_play, can_pause, can_control| {
            let p = PlayerProps {
                can_play,
                can_pause,
                can_control,
                ..props()
            };
            snapshot(&p, 0, 0).can_play_pause
        };
        assert!(with(true, false, true));
        assert!(with(false, true, true));
        assert!(with(true, true, true));
        assert!(!with(false, false, true));
        assert!(!with(true, true, false));
    }

    #[test]
    fn artists_skip_blanks_and_trim() {
        let mut p = props();
        p.metadata.artists = vec![" A ".into(), "".into(), "  ".into(), "B".into()];
        assert_eq!(snapshot(&p, 0, 0).artist, "A, B");
        p.metadata.artists = vec![];
        assert_eq!(snapshot(&p, 0, 0).artist, "");
    }

    #[test]
    fn negative_times_are_zero() {
        let mut p = props();
        p.position_us = -5_000;
        p.metadata.length_us = Some(-1);
        let s = snapshot(&p, 0, 0);
        assert_eq!(s.position_ms, 0);
        assert_eq!(s.duration_ms, 0);
    }

    #[test]
    fn volume_is_clamped_and_defaults_to_full() {
        let vol = |v| {
            let p = PlayerProps {
                volume: v,
                ..props()
            };
            snapshot(&p, 0, 0).volume
        };
        assert_eq!(vol(Some(1.7)), 1.0);
        assert_eq!(vol(Some(-0.2)), 0.0);
        assert_eq!(vol(Some(0.25)), 0.25);
        assert_eq!(vol(Some(f64::NAN)), 0.0);
        assert_eq!(vol(Some(f64::INFINITY)), 0.0);
        assert_eq!(vol(None), 1.0);
    }

    #[test]
    fn loop_status_maps_both_ways() {
        assert_eq!(loop_status_to_repeat("None"), Some("none"));
        assert_eq!(loop_status_to_repeat("Track"), Some("track"));
        assert_eq!(loop_status_to_repeat("Playlist"), Some("list"));
        assert_eq!(loop_status_to_repeat("Bogus"), None);
        assert_eq!(loop_status_to_repeat(""), None);
        for mode in ["none", "track", "list"] {
            let status = repeat_to_loop_status(mode);
            assert_eq!(loop_status_to_repeat(status), Some(mode));
        }
        assert_eq!(repeat_to_loop_status("bogus"), "None");
    }

    #[test]
    fn unknown_loop_status_hides_repeat() {
        let mut p = props();
        p.loop_status = Some("Weird".into());
        assert_eq!(snapshot(&p, 0, 0).repeat, None);
    }

    #[test]
    fn app_name_prefers_identity() {
        assert_eq!(
            app_name("Spotify", "org.mpris.MediaPlayer2.spotify"),
            "Spotify"
        );
        assert_eq!(
            app_name("  Spotify ", "org.mpris.MediaPlayer2.spotify"),
            "Spotify"
        );
    }

    #[test]
    fn app_name_falls_back_to_the_bus_suffix() {
        assert_eq!(app_name("", "org.mpris.MediaPlayer2.spotify"), "spotify");
        assert_eq!(
            app_name(" ", "org.mpris.MediaPlayer2.vlc.instance1234"),
            "vlc"
        );
        assert_eq!(
            app_name("", "org.mpris.MediaPlayer2.firefox.instance_1_42"),
            "firefox"
        );
        assert_eq!(
            app_name("", "org.mpris.MediaPlayer2.chromium.foo"),
            "chromium.foo"
        );
        assert_eq!(app_name("", "org.example.Other"), "org.example.Other");
        assert_eq!(
            app_name("", "org.mpris.MediaPlayer2."),
            "org.mpris.MediaPlayer2."
        );
        assert_eq!(app_name("", ""), "");
    }

    #[test]
    fn bus_names_are_recognized_by_prefix() {
        assert!(is_player_bus_name("org.mpris.MediaPlayer2.vlc"));
        assert!(!is_player_bus_name("org.freedesktop.DBus"));
        assert!(!is_player_bus_name("org.mpris.MediaPlayer2"));
    }

    #[test]
    fn choose_nothing_from_nothing() {
        let none: [(&str, bool, u64); 0] = [];
        assert_eq!(choose_player(&none, None), None);
        assert_eq!(choose_player(&none, Some("a")), None);
    }

    #[test]
    fn a_playing_player_wins() {
        let c = [("a", false, 100), ("b", true, 1), ("c", false, 50)];
        assert_eq!(choose_player(&c, None).as_deref(), Some("b"));
        assert_eq!(choose_player(&c, Some("a")).as_deref(), Some("b"));
    }

    #[test]
    fn the_current_player_stays_while_it_plays() {
        let c = [("a", true, 1), ("b", true, 99)];
        assert_eq!(choose_player(&c, Some("a")).as_deref(), Some("a"));
        assert_eq!(choose_player(&c, None).as_deref(), Some("b"));
    }

    #[test]
    fn the_current_player_stays_when_nothing_plays() {
        let c = [("a", false, 1), ("b", false, 99)];
        assert_eq!(choose_player(&c, Some("a")).as_deref(), Some("a"));
    }

    #[test]
    fn the_most_recently_changed_player_wins_when_nothing_plays() {
        let c = [("a", false, 1), ("b", false, 99), ("c", false, 5)];
        assert_eq!(choose_player(&c, None).as_deref(), Some("b"));
        assert_eq!(choose_player(&c, Some("gone")).as_deref(), Some("b"));
    }

    #[test]
    fn the_most_recently_changed_of_the_playing_players_wins() {
        let c = [("a", true, 1), ("b", true, 9), ("c", false, 99)];
        assert_eq!(choose_player(&c, Some("c")).as_deref(), Some("b"));
        assert_eq!(choose_player(&c, Some("gone")).as_deref(), Some("b"));
    }

    #[test]
    fn ties_go_to_the_first_listed() {
        let c = [("a", false, 5), ("b", false, 5)];
        assert_eq!(choose_player(&c, None).as_deref(), Some("a"));
        let c = [("a", true, 5), ("b", true, 5)];
        assert_eq!(choose_player(&c, None).as_deref(), Some("a"));
    }

    #[test]
    fn owned_names_work_too() {
        let c = vec![("a".to_string(), false, 1), ("b".to_string(), true, 0)];
        assert_eq!(choose_player(&c, Some("a")).as_deref(), Some("b"));
    }

    #[test]
    fn art_ids_are_stable_and_distinct() {
        assert_eq!(art_id_for(""), 0);
        let a = art_id_for("file:///tmp/a.png");
        assert_ne!(a, 0);
        assert_eq!(a, art_id_for("file:///tmp/a.png"));
        assert_ne!(a, art_id_for("file:///tmp/b.png"));
        // Pinned so the id never silently changes between builds.
        assert_eq!(art_id_for("a"), 0xaf63_dc4c_8601_ec8c);
    }

    fn snap(playing: bool, position_ms: u64, position_at: u64) -> MediaSnapshot {
        let mut s = snapshot(&props(), 0, position_at);
        s.playing = playing;
        s.position_ms = position_ms;
        s
    }

    #[test]
    fn position_keeps_the_previous_read_while_time_only_passes() {
        let prev = snap(true, 10_000, 1_000_000);
        let mut next = snap(true, 15_200, 1_005_000);
        settle_position(Some(&prev), &mut next);
        assert_eq!((next.position_ms, next.position_at), (10_000, 1_000_000));
        assert_eq!(next, prev);
    }

    #[test]
    fn position_takes_a_seek() {
        let prev = snap(true, 10_000, 1_000_000);
        let mut next = snap(true, 60_000, 1_005_000);
        settle_position(Some(&prev), &mut next);
        assert_eq!((next.position_ms, next.position_at), (60_000, 1_005_000));
    }

    #[test]
    fn a_paused_position_does_not_count_forward() {
        let prev = snap(false, 10_000, 1_000_000);
        let mut same = snap(false, 10_000, 1_060_000);
        settle_position(Some(&prev), &mut same);
        assert_eq!(same.position_at, 1_000_000);
        let mut moved = snap(false, 30_000, 1_060_000);
        settle_position(Some(&prev), &mut moved);
        assert_eq!((moved.position_ms, moved.position_at), (30_000, 1_060_000));
    }

    #[test]
    fn position_is_fresh_when_play_state_changes_or_nothing_came_before() {
        let prev = snap(true, 10_000, 1_000_000);
        let mut paused = snap(false, 10_000, 1_000_500);
        settle_position(Some(&prev), &mut paused);
        assert_eq!(paused.position_at, 1_000_500);
        let mut first = snap(true, 10_000, 1_000_500);
        settle_position(None, &mut first);
        assert_eq!(first.position_at, 1_000_500);
    }

    #[test]
    fn file_urls_decode_to_paths() {
        assert_eq!(
            file_url_path("file:///tmp/a%20b%C3%A9.png").unwrap(),
            "/tmp/a b\u{e9}.png".as_bytes()
        );
        assert_eq!(file_url_path("file://localhost/x.jpg").unwrap(), b"/x.jpg");
        assert_eq!(file_url_path("file:///plain").unwrap(), b"/plain");
    }

    #[test]
    fn other_urls_and_bad_escapes_are_not_paths() {
        assert_eq!(file_url_path("https://example.com/a.png"), None);
        assert_eq!(file_url_path("file://host/a.png"), None);
        assert_eq!(file_url_path("file:///a%2"), None);
        assert_eq!(file_url_path("file:///a%+f"), None);
        assert_eq!(file_url_path("file:///a%zz"), None);
        assert_eq!(file_url_path(""), None);
    }
}
