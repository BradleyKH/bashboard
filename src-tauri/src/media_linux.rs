//! The Linux worker behind the dashboard's Media section (docs/design/dashboard.md section 3.29):
//! MPRIS players on the D-Bus session bus.
//!
//! One worker thread owns the session-bus connection. On every change it reads each player's
//! properties, follows one by `media_mpris::choose_player`, and emits the snapshot when it differs.
//! Two helper threads only wake it: one for `NameOwnerChanged` on MPRIS names (players coming and
//! going), one for every signal on the MPRIS object path (`PropertiesChanged` and `Seeked` from any
//! player, so a player that starts playing takes over). Remote album art loads on a short-lived
//! thread per URL that reports back as `Msg::ArtLoaded`. Without a session bus the worker still
//! answers, with no session.
//!
//! Volume and mute act on the default output device through `system_volume`, as on Windows,
//! since browsers ignore MPRIS volume writes. With that tool the worker also wakes each second
//! while a player shows, to follow a volume key or the system mixer. Without `wpctl` or `pactl`
//! they fall back to the player's own MPRIS `Volume`.

use crate::media::{ART_PX, MediaCommand, MediaSnapshot, Msg, next_repeat};
use crate::media_mpris::{self as mpris, ArtLoad, ArtState, PlayerProps, TrackMeta};
use crate::system_volume::Tool;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zbus::MatchRule;
use zbus::blocking::fdo;
use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type as MessageType;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

const OBJECT_PATH: &str = "/org/mpris/MediaPlayer2";
const ROOT_IFACE: &str = "org.mpris.MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";
const PROPS_IFACE: &str = "org.freedesktop.DBus.Properties";
/// The track id MPRIS reserves for "no track", which `SetPosition` cannot target.
const NO_TRACK: &str = "/org/mpris/MediaPlayer2/TrackList/NoTrack";
/// Every call waits at most this long, so a hung player cannot stall the section.
const CALL_TIMEOUT: Duration = Duration::from_secs(2);
const ART_TIMEOUT: Duration = Duration::from_secs(5);
const ART_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// How often the system volume is reread while a player shows.
const VOLUME_POLL: Duration = Duration::from_secs(1);

type Props = HashMap<String, OwnedValue>;

/// When a player last changed in a way that matters for choosing it.
struct Seen {
    fingerprint: (String, String, Option<String>),
    changed_ms: u64,
}

struct Worker<E> {
    conn: Option<Connection>,
    /// For art fetches to report back on. Held only with a bus, whose watcher threads keep the
    /// channel open anyway, so without one the worker still ends when every caller is gone.
    tx: Option<Sender<Msg>>,
    emit: E,
    followed: Option<PlayerProps>,
    snapshot: Option<MediaSnapshot>,
    seen: HashMap<String, Seen>,
    art: ArtState,
    /// The followed player's bus name and its volume before `ToggleMute` set it to zero; only
    /// without a system volume tool.
    unmuted: Option<(String, f64)>,
    /// What sets the system volume; None falls back to the player's MPRIS `Volume`.
    volume_tool: Option<Tool>,
}

/// Runs the worker until every sender is gone. `emit` receives each changed snapshot, and
/// `volume_tool` (`system_volume::find`) is what the volume controls act on.
pub(crate) fn run(
    emit: impl FnMut(&Option<MediaSnapshot>),
    tx: Sender<Msg>,
    rx: Receiver<Msg>,
    volume_tool: Option<Tool>,
) {
    let conn = match connect() {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("media: no session bus: {e}");
            None
        }
    };
    if let Some(c) = &conn {
        watch(c, &tx);
    }
    let tx = conn.is_some().then_some(tx);
    let mut w = Worker {
        conn,
        tx,
        emit,
        followed: None,
        snapshot: None,
        seen: HashMap::new(),
        art: ArtState::default(),
        unmuted: None,
        volume_tool,
    };
    w.refresh();
    loop {
        let polling = w.volume_tool.is_some() && w.snapshot.is_some();
        let first = if polling {
            match rx.recv_timeout(VOLUME_POLL) {
                Ok(m) => m,
                Err(RecvTimeoutError::Timeout) => {
                    w.refresh_volume();
                    continue;
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(m) => m,
                Err(_) => break,
            }
        };
        // A burst of signals (a track change sends several) costs one refresh.
        let mut changed = false;
        let mut requests = Vec::new();
        for msg in std::iter::once(first).chain(rx.try_iter()) {
            match msg {
                Msg::Changed => changed = true,
                Msg::ArtLoaded(url, bytes) => changed |= w.art.loaded(&url, bytes),
                other => requests.push(other),
            }
        }
        if changed {
            w.refresh();
        }
        for msg in requests {
            w.answer(msg);
        }
    }
}

fn connect() -> zbus::Result<Connection> {
    zbus::blocking::connection::Builder::session()?
        .method_timeout(CALL_TIMEOUT)
        .build()
}

/// Starts the helper threads that turn bus signals into `Msg::Changed`.
fn watch(conn: &Connection, tx: &Sender<Msg>) {
    let owners = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .sender("org.freedesktop.DBus")
        .and_then(|b| b.interface("org.freedesktop.DBus"))
        .and_then(|b| b.member("NameOwnerChanged"))
        .and_then(|b| b.arg0ns("org.mpris.MediaPlayer2"))
        .map(|b| b.build());
    let players = MatchRule::builder()
        .msg_type(MessageType::Signal)
        .path(OBJECT_PATH)
        .map(|b| b.build());
    for (name, rule) in [("media-owners", owners), ("media-players", players)] {
        let iter = rule.and_then(|r| MessageIterator::for_match_rule(r, conn, Some(64)));
        let iter = match iter {
            Ok(i) => i,
            Err(e) => {
                eprintln!("media: could not watch the bus ({name}): {e}");
                continue;
            }
        };
        let tx = tx.clone();
        let spawned = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                for msg in iter {
                    if msg.is_ok() && tx.send(Msg::Changed).is_err() {
                        return;
                    }
                }
            });
        if let Err(e) = spawned {
            eprintln!("media: could not start {name}: {e}");
        }
    }
}

impl<E: FnMut(&Option<MediaSnapshot>)> Worker<E> {
    fn answer(&mut self, msg: Msg) {
        match msg {
            Msg::Changed => self.refresh(),
            Msg::Get(reply) => {
                let _ = reply.send(self.snapshot.clone());
            }
            Msg::Art(reply) => {
                let _ = reply.send(self.art.bytes().to_vec());
            }
            Msg::Control(cmd, reply) => {
                let _ = reply.send(self.control(cmd));
            }
            Msg::ArtLoaded(url, bytes) => {
                if self.art.loaded(&url, bytes) {
                    self.refresh();
                }
            }
        }
    }

    /// Rereads the players, picks the one to follow, and emits its snapshot on a change.
    fn refresh(&mut self) {
        let now = now_ms();
        let players = self.read_players(now);
        let candidates: Vec<(&str, bool, u64)> = players
            .iter()
            .map(|p| {
                let changed = self.seen.get(&p.bus_name).map_or(0, |s| s.changed_ms);
                (p.bus_name.as_str(), p.playback_status == "Playing", changed)
            })
            .collect();
        let current = self.followed.as_ref().map(|p| p.bus_name.as_str());
        let chosen = mpris::choose_player(&candidates, current);
        self.followed = chosen.and_then(|name| players.into_iter().find(|p| p.bus_name == name));
        let art_url = self
            .followed
            .as_ref()
            .and_then(|p| p.metadata.art_url.clone());
        self.update_art(art_url.as_deref().unwrap_or(""));
        let art_id = self.art.id();
        let system = match (&self.volume_tool, &self.followed) {
            (Some(tool), Some(_)) => tool.read(),
            _ => None,
        };
        let next = self.followed.as_ref().map(|p| {
            let mut s = mpris::snapshot(p, art_id, now);
            mpris::settle_position(self.snapshot.as_ref(), &mut s);
            if let Some((volume, muted)) = system {
                s.volume = volume;
                s.muted = muted;
            }
            s
        });
        self.emit_if_changed(next);
    }

    /// Rereads the system volume alone, for a change no player signals.
    fn refresh_volume(&mut self) {
        let (Some(tool), Some(current)) = (&self.volume_tool, &self.snapshot) else {
            return;
        };
        let Some((volume, muted)) = tool.read() else {
            return;
        };
        let mut next = current.clone();
        next.volume = volume;
        next.muted = muted;
        self.emit_if_changed(Some(next));
    }

    fn emit_if_changed(&mut self, next: Option<MediaSnapshot>) {
        if next != self.snapshot {
            self.snapshot = next;
            (self.emit)(&self.snapshot);
        }
    }

    /// Every player on the bus that answers, noting when each last changed.
    fn read_players(&mut self, now: u64) -> Vec<PlayerProps> {
        let Some(conn) = &self.conn else {
            return Vec::new();
        };
        let names = fdo::DBusProxy::new(conn)
            .map_err(zbus::fdo::Error::from)
            .and_then(|p| p.list_names());
        let names = match names {
            Ok(n) => n,
            Err(e) => {
                eprintln!("media: could not list bus names: {e}");
                return Vec::new();
            }
        };
        let players: Vec<PlayerProps> = names
            .iter()
            .map(|n| n.as_str())
            .filter(|n| mpris::is_player_bus_name(n))
            .filter_map(|n| read_player(conn, n).ok())
            .collect();
        self.seen
            .retain(|name, _| players.iter().any(|p| &p.bus_name == name));
        for p in &players {
            let fingerprint = (
                p.playback_status.clone(),
                p.metadata.title.clone(),
                p.metadata.track_id.clone(),
            );
            let seen = self.seen.entry(p.bus_name.clone()).or_insert(Seen {
                fingerprint: fingerprint.clone(),
                changed_ms: now,
            });
            if seen.fingerprint != fingerprint {
                seen.fingerprint = fingerprint;
                seen.changed_ms = now;
            }
        }
        players
    }

    /// Loads the art when its URL changes; a URL that fails stays cached as no art.
    fn update_art(&mut self, url: &str) {
        match self.art.follow(url) {
            ArtLoad::Nothing => {}
            ArtLoad::Here => {
                let bytes = load_local_art(url).unwrap_or_else(|e| no_art(url, &e));
                self.art.loaded(url, bytes);
            }
            ArtLoad::Fetch => {
                if let Err(e) = self.spawn_fetch(url) {
                    let bytes = no_art(url, &e);
                    self.art.loaded(url, bytes);
                }
            }
        }
    }

    fn spawn_fetch(&self, url: &str) -> Result<(), String> {
        let tx = self.tx.clone().ok_or("no channel to report back on")?;
        let url = url.to_string();
        std::thread::Builder::new()
            .name("media-art".into())
            .spawn(move || {
                let bytes = fetch(&url)
                    .and_then(|b| scaled_jpeg(&b))
                    .unwrap_or_else(|e| no_art(&url, &e));
                let _ = tx.send(Msg::ArtLoaded(url, bytes));
            })
            .map(drop)
            .map_err(|e| e.to_string())
    }

    fn control(&mut self, cmd: MediaCommand) -> Result<(), String> {
        let (Some(conn), Some(p)) = (self.conn.clone(), self.followed.clone()) else {
            return Ok(());
        };
        if let Some(tool) = &self.volume_tool {
            let system = match cmd {
                MediaCommand::SetVolume { level } => Some(tool.set(level)),
                MediaCommand::ToggleMute => Some(tool.toggle_mute()),
                _ => None,
            };
            if let Some(result) = system {
                self.refresh();
                return result;
            }
        }
        let name = p.bus_name.as_str();
        let result = match cmd {
            MediaCommand::PlayPause => call(&conn, name, "PlayPause", &()),
            MediaCommand::Next => call(&conn, name, "Next", &()),
            MediaCommand::Previous => call(&conn, name, "Previous", &()),
            MediaCommand::ToggleShuffle => set(
                &conn,
                name,
                "Shuffle",
                Value::from(!p.shuffle.unwrap_or(false)),
            ),
            MediaCommand::CycleRepeat => {
                let now = p
                    .loop_status
                    .as_deref()
                    .and_then(mpris::loop_status_to_repeat);
                let next = mpris::repeat_to_loop_status(next_repeat(now.unwrap_or("none")));
                set(&conn, name, "LoopStatus", Value::from(next))
            }
            MediaCommand::Seek { position_ms } => seek(&conn, &p, position_ms),
            MediaCommand::SetVolume { level } => {
                let level = if level.is_finite() {
                    f64::from(level).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                set(&conn, name, "Volume", Value::from(level))
            }
            MediaCommand::ToggleMute => {
                let level = self.mute_target(&p);
                set(&conn, name, "Volume", Value::from(level))
            }
        };
        self.refresh();
        result.map_err(|e| e.to_string())
    }

    /// The volume `ToggleMute` sets: zero, remembering the level, or back to the remembered level
    /// (full when the player was already silent).
    fn mute_target(&mut self, p: &PlayerProps) -> f64 {
        let current = p.volume.unwrap_or(1.0);
        if current > 0.0 {
            self.unmuted = Some((p.bus_name.clone(), current));
            return 0.0;
        }
        match self.unmuted.take() {
            Some((name, level)) if name == p.bus_name && level > 0.0 => level,
            _ => 1.0,
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

fn get_all(conn: &Connection, name: &str, iface: &str) -> zbus::Result<Props> {
    conn.call_method(
        Some(name),
        OBJECT_PATH,
        Some(PROPS_IFACE),
        "GetAll",
        &(iface,),
    )?
    .body()
    .deserialize()
}

fn get(conn: &Connection, name: &str, iface: &str, prop: &str) -> zbus::Result<OwnedValue> {
    conn.call_method(
        Some(name),
        OBJECT_PATH,
        Some(PROPS_IFACE),
        "Get",
        &(iface, prop),
    )?
    .body()
    .deserialize()
}

fn call<B>(conn: &Connection, name: &str, method: &str, body: &B) -> zbus::Result<()>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    conn.call_method(Some(name), OBJECT_PATH, Some(PLAYER_IFACE), method, body)
        .map(drop)
}

fn set(conn: &Connection, name: &str, prop: &str, value: Value<'_>) -> zbus::Result<()> {
    conn.call_method(
        Some(name),
        OBJECT_PATH,
        Some(PROPS_IFACE),
        "Set",
        &(PLAYER_IFACE, prop, value),
    )
    .map(drop)
}

/// `SetPosition` on the current track, or a relative `Seek` from the position read now when the
/// player gives no usable track id.
fn seek(conn: &Connection, p: &PlayerProps, position_ms: u64) -> zbus::Result<()> {
    let target = i64::try_from(position_ms).unwrap_or(i64::MAX / 1000) * 1000;
    let track = p
        .metadata
        .track_id
        .as_deref()
        .filter(|t| *t != NO_TRACK)
        .and_then(|t| ObjectPath::try_from(t).ok());
    if let Some(track) = track {
        return call(conn, &p.bus_name, "SetPosition", &(track, target));
    }
    let now = get(conn, &p.bus_name, PLAYER_IFACE, "Position")
        .ok()
        .and_then(|v| int(&v))
        .unwrap_or(p.position_us);
    call(conn, &p.bus_name, "Seek", &(target - now,))
}

fn read_player(conn: &Connection, name: &str) -> zbus::Result<PlayerProps> {
    let props = get_all(conn, name, PLAYER_IFACE)?;
    let identity = get_all(conn, name, ROOT_IFACE)
        .ok()
        .and_then(|root| root.get("Identity").and_then(|v| string(v)))
        .unwrap_or_default();
    let flag = |key: &str| props.get(key).and_then(|v| boolean(v));
    Ok(PlayerProps {
        identity,
        bus_name: name.to_string(),
        playback_status: props
            .get("PlaybackStatus")
            .and_then(|v| string(v))
            .unwrap_or_default(),
        can_play: flag("CanPlay").unwrap_or(false),
        can_pause: flag("CanPause").unwrap_or(false),
        can_go_next: flag("CanGoNext").unwrap_or(false),
        can_go_previous: flag("CanGoPrevious").unwrap_or(false),
        can_seek: flag("CanSeek").unwrap_or(false),
        // The spec requires it, but a player that leaves it out has not said it refuses control.
        can_control: flag("CanControl").unwrap_or(true),
        shuffle: flag("Shuffle"),
        loop_status: props.get("LoopStatus").and_then(|v| string(v)),
        // Some players leave Position out of GetAll but answer a Get for it.
        position_us: props
            .get("Position")
            .and_then(|v| int(v))
            .or_else(|| {
                get(conn, name, PLAYER_IFACE, "Position")
                    .ok()
                    .and_then(|v| int(&v))
            })
            .unwrap_or(0),
        volume: props.get("Volume").and_then(|v| float(v)),
        metadata: props
            .get("Metadata")
            .map(|v| track_meta(v))
            .unwrap_or_default(),
    })
}

fn track_meta(value: &Value<'_>) -> TrackMeta {
    let mut meta = TrackMeta::default();
    let Value::Dict(dict) = inner(value) else {
        return meta;
    };
    for (key, v) in dict.iter() {
        let Some(key) = string(key) else { continue };
        match key.as_str() {
            "xesam:title" => meta.title = string(v).unwrap_or_default(),
            "xesam:artist" => meta.artists = strings(v),
            "xesam:album" => meta.album = string(v).unwrap_or_default(),
            "mpris:length" => meta.length_us = int(v),
            "mpris:artUrl" => meta.art_url = string(v).filter(|u| !u.is_empty()),
            "mpris:trackid" => meta.track_id = string(v),
            _ => {}
        }
    }
    meta
}

/// The value inside any variant wrapping; dict entries of `a{sv}` arrive wrapped.
fn inner<'a, 'v>(value: &'a Value<'v>) -> &'a Value<'v> {
    match value {
        Value::Value(boxed) => inner(boxed),
        other => other,
    }
}

fn string(value: &Value<'_>) -> Option<String> {
    match inner(value) {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(p) => Some(p.to_string()),
        _ => None,
    }
}

/// `xesam:artist` is a list of strings, though some players send a single string.
fn strings(value: &Value<'_>) -> Vec<String> {
    match inner(value) {
        Value::Array(items) => items.iter().filter_map(string).collect(),
        other => string(other).into_iter().collect(),
    }
}

fn boolean(value: &Value<'_>) -> Option<bool> {
    match inner(value) {
        Value::Bool(b) => Some(*b),
        _ => None,
    }
}

/// Integers in whatever width the player chose; `mpris:length` is meant to be `x` but players
/// send `t`, `i`, `u`, and even `d`.
fn int(value: &Value<'_>) -> Option<i64> {
    match inner(value) {
        Value::I64(n) => Some(*n),
        Value::U64(n) => i64::try_from(*n).ok(),
        Value::I32(n) => Some(i64::from(*n)),
        Value::U32(n) => Some(i64::from(*n)),
        Value::I16(n) => Some(i64::from(*n)),
        Value::U16(n) => Some(i64::from(*n)),
        Value::U8(n) => Some(i64::from(*n)),
        Value::F64(n) if n.is_finite() => Some(*n as i64),
        _ => None,
    }
}

fn float(value: &Value<'_>) -> Option<f64> {
    match inner(value) {
        Value::F64(n) => Some(*n),
        _ => int(value).map(|n| n as f64),
    }
}

/// The art at a `file://` URL as a JPEG at most `ART_PX` on its longer side.
fn load_local_art(url: &str) -> Result<Vec<u8>, String> {
    let path = mpris::file_url_path(url).ok_or("unsupported URL")?;
    scaled_jpeg(&read_file(path)?)
}

fn no_art(url: &str, error: &str) -> Vec<u8> {
    eprintln!("media: no album art from {url}: {error}");
    Vec::new()
}

fn read_file(path: Vec<u8>) -> Result<Vec<u8>, String> {
    use std::io::Read;
    use std::os::unix::ffi::OsStringExt;
    let file =
        std::fs::File::open(std::ffi::OsString::from_vec(path)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(ART_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > ART_MAX_BYTES {
        return Err("the file is too large".into());
    }
    Ok(bytes)
}

fn fetch(url: &str) -> Result<Vec<u8>, String> {
    use ureq::tls::{RootCerts, TlsConfig};
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(ART_TIMEOUT))
        .proxy(ureq::Proxy::try_from_env())
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .build()
        .into();
    let mut reply = agent.get(url).call().map_err(|e| e.to_string())?;
    reply
        .body_mut()
        .with_config()
        .limit(ART_MAX_BYTES)
        .read_to_vec()
        .map_err(|e| e.to_string())
}

/// `(w, h)` scaled to `ART_PX` on the longer side, keeping the aspect; `None` when it already fits.
fn fit(w: i32, h: i32) -> Option<(i32, i32)> {
    let longer = w.max(h).max(1);
    if longer <= ART_PX as i32 {
        return None;
    }
    let scale = f64::from(ART_PX) / f64::from(longer);
    let side = |n: i32| ((f64::from(n) * scale).round() as i32).max(1);
    Some((side(w), side(h)))
}

fn scaled_jpeg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use gdk_pixbuf::prelude::*;
    let loader = gdk_pixbuf::PixbufLoader::new();
    // Decode straight to the target size, so a huge image never allocates at full size.
    loader.connect_size_prepared(|loader, w, h| {
        if let Some((sw, sh)) = fit(w, h) {
            loader.set_size(sw, sh);
        }
    });
    if let Err(e) = loader.write(bytes) {
        let _ = loader.close();
        return Err(e.to_string());
    }
    loader.close().map_err(|e| e.to_string())?;
    let pixbuf = loader.pixbuf().ok_or("not an image")?;
    // A loader that ignores `set_size` still hands back a full-size image.
    let pixbuf = match fit(pixbuf.width(), pixbuf.height()) {
        Some((sw, sh)) => pixbuf
            .scale_simple(sw, sh, gdk_pixbuf::InterpType::Hyper)
            .ok_or("could not scale the image")?,
        None => pixbuf,
    };
    // JPEG has no alpha. Older gdk-pixbuf dropped it when saving; the glycin-backed one (Ubuntu
    // 26.04) refuses an RGBA image, so flatten onto black first, which matches the old result
    // for opaque art.
    let pixbuf = if pixbuf.has_alpha() {
        let (w, h) = (pixbuf.width(), pixbuf.height());
        let opaque = gdk_pixbuf::Pixbuf::new(gdk_pixbuf::Colorspace::Rgb, false, 8, w, h)
            .ok_or("could not allocate the image")?;
        opaque.fill(0x0000_00ff);
        pixbuf.composite(&opaque, 0, 0, w, h, 0.0, 0.0, 1.0, 1.0, gdk_pixbuf::InterpType::Nearest, 255);
        opaque
    } else {
        pixbuf
    };
    pixbuf
        .save_to_bufferv("jpeg", &[("quality", "90")])
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex, mpsc};
    use std::time::Instant;

    fn ask<T>(tx: &Sender<Msg>, make: impl FnOnce(Sender<T>) -> Msg) -> T {
        let (reply, answer) = mpsc::channel();
        tx.send(make(reply)).unwrap();
        answer.recv_timeout(Duration::from_secs(10)).unwrap()
    }

    fn wait_for<T>(what: &str, mut poll: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(v) = poll() {
                return v;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    fn snapshot_where(tx: &Sender<Msg>, test: impl Fn(&MediaSnapshot) -> bool) -> MediaSnapshot {
        wait_for("a matching snapshot", || ask(tx, Msg::Get).filter(&test))
    }

    fn control(tx: &Sender<Msg>, cmd: MediaCommand) {
        ask(tx, |reply| Msg::Control(cmd, reply)).unwrap();
    }

    #[test]
    fn metadata_reads_wrapped_values_of_any_width() {
        let mut dict = zbus::zvariant::Dict::new(
            &zbus::zvariant::Signature::Str,
            &zbus::zvariant::Signature::Variant,
        );
        let mut add = |k: &str, v: Value<'static>| {
            dict.append(Value::from(k.to_string()), Value::Value(Box::new(v)))
                .unwrap()
        };
        add("xesam:title", Value::from("Song"));
        add("xesam:artist", Value::from(vec!["A", "B"]));
        add("xesam:album", Value::from("Album"));
        add("mpris:length", Value::from(180_000_000u64));
        add("mpris:artUrl", Value::from("file:///tmp/a.png"));
        add(
            "mpris:trackid",
            Value::from(ObjectPath::try_from("/t/1").unwrap()),
        );
        let meta = track_meta(&Value::Dict(dict));
        assert_eq!(meta.title, "Song");
        assert_eq!(meta.artists, ["A", "B"]);
        assert_eq!(meta.album, "Album");
        assert_eq!(meta.length_us, Some(180_000_000));
        assert_eq!(meta.art_url.as_deref(), Some("file:///tmp/a.png"));
        assert_eq!(meta.track_id.as_deref(), Some("/t/1"));
    }

    #[test]
    fn numbers_convert_across_widths() {
        assert_eq!(int(&Value::from(5i32)), Some(5));
        assert_eq!(int(&Value::from(u64::MAX)), None);
        assert_eq!(int(&Value::from(2.9f64)), Some(2));
        assert_eq!(float(&Value::from(3u32)), Some(3.0));
        assert_eq!(int(&Value::from("5")), None);
        assert_eq!(strings(&Value::from("Solo")), ["Solo"]);
    }

    #[test]
    fn art_is_scaled_down_and_encoded_as_jpeg() {
        let big = gdk_pixbuf::Pixbuf::new(gdk_pixbuf::Colorspace::Rgb, true, 8, 600, 300).unwrap();
        big.fill(0x3366_99ff);
        let png = big.save_to_bufferv("png", &[]).unwrap();
        let jpeg = scaled_jpeg(&png).unwrap();
        assert_eq!(&jpeg[..2], [0xff, 0xd8]);
        let back = gdk_pixbuf::Pixbuf::from_read(std::io::Cursor::new(jpeg)).unwrap();
        assert_eq!(
            (back.width(), back.height()),
            (ART_PX as i32, ART_PX as i32 / 2)
        );
        assert!(scaled_jpeg(b"not an image").is_err());
    }

    /// Run under `dbus-run-session` with python3-dbus and python3-gi installed.
    #[test]
    #[ignore = "needs a session bus and the fake MPRIS player's Python packages"]
    fn follows_and_controls_the_fake_player() {
        let script = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/linux/fake-mpris-player.py"
        );
        let log = std::env::temp_dir().join("fake-mpris-player.log");
        let mut player = std::process::Command::new("python3")
            .arg(script)
            .stdout(std::fs::File::create(&log).unwrap())
            .spawn()
            .expect("python3 runs");
        let read_log = || std::fs::read_to_string(&log).unwrap_or_default();
        wait_for("the fake player", || {
            read_log().contains("ready").then_some(())
        });

        let (tx, rx) = mpsc::channel();
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let sink = emitted.clone();
        let worker_tx = tx.clone();
        std::thread::spawn(move || {
            run(
                move |s: &Option<MediaSnapshot>| sink.lock().unwrap().push(s.clone()),
                worker_tx,
                rx,
                None,
            )
        });

        let first = snapshot_where(&tx, |s| s.title == "Fake Track 1");
        println!("snapshot: {first:#?}");
        assert_eq!(first.app, "Fake Player");
        assert_eq!(first.artist, "Fake Artist");
        assert!(first.playing);
        assert_eq!(first.duration_ms, 180_000);
        assert_ne!(first.art_id, 0);
        let art = ask(&tx, Msg::Art);
        println!("art: {} bytes", art.len());
        assert_eq!(&art[..2], [0xff, 0xd8]);

        control(&tx, MediaCommand::PlayPause);
        snapshot_where(&tx, |s| !s.playing);
        control(&tx, MediaCommand::Next);
        let second = snapshot_where(&tx, |s| s.title == "Fake Track 2");
        assert_ne!(second.art_id, first.art_id);
        control(
            &tx,
            MediaCommand::Seek {
                position_ms: 12_000,
            },
        );
        snapshot_where(&tx, |s| s.position_ms == 12_000);
        control(&tx, MediaCommand::SetVolume { level: 0.5 });
        snapshot_where(&tx, |s| s.volume == 0.5);
        control(&tx, MediaCommand::ToggleMute);
        snapshot_where(&tx, |s| s.volume == 0.0);
        control(&tx, MediaCommand::ToggleMute);
        snapshot_where(&tx, |s| s.volume == 0.5);
        control(&tx, MediaCommand::ToggleShuffle);
        snapshot_where(&tx, |s| s.shuffle == Some(true));
        control(&tx, MediaCommand::CycleRepeat);
        snapshot_where(&tx, |s| s.repeat == Some("list"));
        control(&tx, MediaCommand::Previous);
        snapshot_where(&tx, |s| s.title == "Fake Track 1");

        player.kill().unwrap();
        let _ = player.wait();
        wait_for("no session", || ask(&tx, Msg::Get).is_none().then_some(()));
        assert_eq!(emitted.lock().unwrap().last(), Some(&None));

        let calls = read_log();
        println!("fake player log:\n{calls}");
        for line in [
            "call PlayPause",
            "call Next",
            "call SetPosition /org/fakeplayer/track/2 12000000",
            "set Volume 0.5",
            "set Volume 0.0",
            "set Shuffle true",
            "set LoopStatus Playlist",
            "call Previous",
        ] {
            assert!(calls.contains(line), "the fake player did not log `{line}`");
        }
    }
}
