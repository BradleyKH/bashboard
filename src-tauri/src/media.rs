//! Now playing and transport controls for the dashboard's Media section (docs/design/dashboard.md
//! section 3.29).
//!
//! On Windows one worker thread owns the system media session manager, the session it follows, and
//! the audio endpoint, and the commands reach it over a channel, so no WinRT or COM object crosses
//! threads. Other platforms report no session.

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, mpsc::Sender};
use tauri::{AppHandle, State};

/// Album art is scaled down to this many pixels on its longer side before it reaches the page.
#[cfg_attr(not(windows), allow(dead_code))]
const ART_PX: u32 = 144;

/// What the section shows; `None` on the wire while no app has a media session.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSnapshot {
    pub app: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Changes whenever the album art does; 0 while there is none. `media_art` returns the bytes.
    pub art_id: u64,
    pub playing: bool,
    pub can_play_pause: bool,
    pub can_next: bool,
    pub can_previous: bool,
    pub can_seek: bool,
    /// `None` when the app does not offer shuffle.
    pub shuffle: Option<bool>,
    /// `none`, `track`, or `list`; `None` when the app does not offer repeat.
    pub repeat: Option<&'static str>,
    pub position_ms: u64,
    pub duration_ms: u64,
    /// Unix ms when the app last reported the position. Apps report it only on a change, so the
    /// front end counts forward from here while playing.
    pub position_at: u64,
    /// The default output device's master volume, 0 to 1.
    pub volume: f32,
    pub muted: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum MediaCommand {
    PlayPause,
    Next,
    Previous,
    ToggleShuffle,
    CycleRepeat,
    #[serde(rename_all = "camelCase")]
    Seek {
        position_ms: u64,
    },
    SetVolume {
        level: f32,
    },
    ToggleMute,
}

#[cfg_attr(not(windows), allow(dead_code))]
enum Msg {
    Changed,
    Get(Sender<Option<MediaSnapshot>>),
    Art(Sender<Vec<u8>>),
    Control(MediaCommand, Sender<Result<(), String>>),
}

#[derive(Default)]
pub struct Media(Mutex<Option<Sender<Msg>>>);

impl Media {
    /// Sends a request to the worker and waits for its answer; `None` without a worker.
    fn ask<T>(&self, make: impl FnOnce(Sender<T>) -> Msg) -> Option<T> {
        let tx = self.0.lock().ok()?.clone()?;
        let (reply, answer) = std::sync::mpsc::channel();
        tx.send(make(reply)).ok()?;
        answer.recv_timeout(std::time::Duration::from_secs(5)).ok()
    }
}

/// A readable name for an app id: the part after `!` of a packaged app's id, or the file name of
/// a desktop app's path without `.exe`.
#[cfg_attr(not(windows), allow(dead_code))]
fn fallback_app_name(id: &str) -> String {
    let tail = id.rsplit('!').next().unwrap_or(id);
    let file = tail.rsplit(['\\', '/']).next().unwrap_or(tail);
    let name = file
        .strip_suffix(".exe")
        .or_else(|| file.strip_suffix(".EXE"))
        .unwrap_or(file);
    if name.is_empty() {
        id.to_string()
    } else {
        name.to_string()
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn next_repeat(mode: &str) -> &'static str {
    match mode {
        "none" => "list",
        "list" => "track",
        _ => "none",
    }
}

/// 100 ns ticks since 1601 (a WinRT `DateTime`) to Unix ms; 0 for a time before 1970.
#[cfg_attr(not(windows), allow(dead_code))]
fn file_time_to_unix_ms(ticks: i64) -> u64 {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    u64::try_from((ticks - UNIX_EPOCH_TICKS) / 10_000).unwrap_or(0)
}

pub fn init(app: &AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut slot) = app.state::<Media>().0.lock() {
            *slot = Some(tx.clone());
        }
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("media".into())
            .spawn(move || win::run(app, tx, rx));
        if let Err(e) = spawned {
            eprintln!("media: could not start the worker: {e}");
        }
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command(async)]
pub fn media_state(state: State<'_, Media>) -> Option<MediaSnapshot> {
    state.ask(Msg::Get).flatten()
}

/// The current album art as encoded image bytes, empty when there is none.
#[tauri::command(async)]
pub fn media_art(state: State<'_, Media>) -> tauri::ipc::Response {
    tauri::ipc::Response::new(state.ask(Msg::Art).unwrap_or_default())
}

#[tauri::command(async)]
pub fn media_control(state: State<'_, Media>, command: MediaCommand) -> Result<(), String> {
    state
        .ask(|reply| Msg::Control(command, reply))
        .unwrap_or_else(|| Err("media controls are not available".into()))
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::time::Duration;
    use tauri::Emitter;
    use windows::ApplicationModel::AppInfo;
    use windows::Foundation::TypedEventHandler;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapEncoder, BitmapInterpolationMode, BitmapPixelFormat,
    };
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
    use windows::Storage::Streams::{
        DataReader, IRandomAccessStreamReference, InMemoryRandomAccessStream,
    };
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, eMultimedia, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
    };
    use windows::core::{HSTRING, Result};

    /// How often the volume is reread while a session shows, since a volume key or the system
    /// mixer changes it without telling us.
    const VOLUME_POLL: Duration = Duration::from_secs(1);

    struct Followed {
        id: String,
        session: Session,
        tokens: [i64; 3],
    }

    impl Drop for Followed {
        fn drop(&mut self) {
            let _ = self.session.RemoveMediaPropertiesChanged(self.tokens[0]);
            let _ = self.session.RemovePlaybackInfoChanged(self.tokens[1]);
            let _ = self.session.RemoveTimelinePropertiesChanged(self.tokens[2]);
        }
    }

    struct Worker {
        app: AppHandle,
        tx: Sender<Msg>,
        manager: Option<Manager>,
        devices: Option<IMMDeviceEnumerator>,
        followed: Option<Followed>,
        snapshot: Option<MediaSnapshot>,
        names: std::collections::HashMap<String, String>,
        /// The track the art belongs to, its id, and its bytes.
        art_key: String,
        art_id: u64,
        art: Vec<u8>,
    }

    pub(super) fn run(app: AppHandle, tx: Sender<Msg>, rx: Receiver<Msg>) {
        // Fails only when already initialized, which leaves COM usable.
        let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let mut w = Worker {
            app,
            tx,
            manager: None,
            devices: unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok(),
            followed: None,
            snapshot: None,
            names: Default::default(),
            art_key: String::new(),
            art_id: 0,
            art: Vec::new(),
        };
        match w.connect() {
            Ok(m) => w.manager = Some(m),
            Err(e) => eprintln!("media: no session manager: {e}"),
        }
        w.refresh();
        loop {
            let msg = if w.snapshot.is_some() {
                match rx.recv_timeout(VOLUME_POLL) {
                    Ok(m) => Some(m),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            } else {
                match rx.recv() {
                    Ok(m) => Some(m),
                    Err(_) => return,
                }
            };
            match msg {
                None => w.refresh_volume(),
                Some(Msg::Changed) => w.refresh(),
                Some(Msg::Get(reply)) => {
                    let _ = reply.send(w.snapshot.clone());
                }
                Some(Msg::Art(reply)) => {
                    let _ = reply.send(w.art.clone());
                }
                Some(Msg::Control(cmd, reply)) => {
                    let result = w.control(cmd).map_err(|e| e.message().to_string());
                    let _ = reply.send(result);
                }
            }
        }
    }

    impl Worker {
        fn connect(&self) -> Result<Manager> {
            let manager = Manager::RequestAsync()?.join()?;
            let tx = self.tx.clone();
            manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Msg::Changed);
                Ok(())
            }))?;
            let tx = self.tx.clone();
            manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
                let _ = tx.send(Msg::Changed);
                Ok(())
            }))?;
            Ok(manager)
        }

        fn current(&self) -> Option<Session> {
            self.manager.as_ref()?.GetCurrentSession().ok()
        }

        /// Follows the current session's events and rebuilds the snapshot, emitting it on a change.
        fn refresh(&mut self) {
            let session = self.current();
            let id = session
                .as_ref()
                .and_then(|s| s.SourceAppUserModelId().ok())
                .map(|h| h.to_string());
            if self.followed.as_ref().map(|f| &f.id) != id.as_ref() {
                self.followed = None;
                if let (Some(session), Some(id)) = (session.clone(), id) {
                    match self.follow(session, id) {
                        Ok(f) => self.followed = Some(f),
                        Err(e) => eprintln!("media: could not follow the session: {e}"),
                    }
                }
            }
            let next = session.and_then(|s| self.read(&s).ok());
            self.publish(next);
        }

        fn follow(&self, session: Session, id: String) -> Result<Followed> {
            let tokens = [
                session.MediaPropertiesChanged(&changed(self.tx.clone()))?,
                session.PlaybackInfoChanged(&changed(self.tx.clone()))?,
                session.TimelinePropertiesChanged(&changed(self.tx.clone()))?,
            ];
            Ok(Followed {
                id,
                session,
                tokens,
            })
        }

        fn read(&mut self, s: &Session) -> Result<MediaSnapshot> {
            let id = s.SourceAppUserModelId()?.to_string();
            let props = s.TryGetMediaPropertiesAsync()?.join()?;
            let title = props.Title()?.to_string();
            let artist = props.Artist()?.to_string();
            let album = props.AlbumTitle()?.to_string();
            let key = format!("{id}\n{title}\n{artist}\n{album}");
            if key != self.art_key {
                let art = props.Thumbnail().ok().and_then(|t| scaled_art(&t).ok());
                // The art can trail the title by an event, so only a track with art is settled.
                if art.is_some() {
                    self.art_key = key;
                }
                let art = art.unwrap_or_default();
                if art != self.art {
                    self.art = art;
                    self.art_id += 1;
                }
            }
            let info = s.GetPlaybackInfo()?;
            let controls = info.Controls()?;
            let timeline = s.GetTimelineProperties()?;
            let shuffle = if controls.IsShuffleEnabled()? {
                info.IsShuffleActive().ok().and_then(|v| v.Value().ok())
            } else {
                None
            };
            let repeat = if controls.IsRepeatEnabled()? {
                info.AutoRepeatMode()
                    .ok()
                    .and_then(|v| v.Value().ok())
                    .map(|m| match m {
                        Repeat::Track => "track",
                        Repeat::List => "list",
                        _ => "none",
                    })
            } else {
                None
            };
            let ms = |ticks: i64| u64::try_from(ticks / 10_000).unwrap_or(0);
            let start = timeline.StartTime()?.Duration;
            let (volume, muted) = self.volume().unwrap_or((0.0, false));
            Ok(MediaSnapshot {
                app: self.app_name(&id),
                title,
                artist,
                album,
                art_id: if self.art.is_empty() { 0 } else { self.art_id },
                playing: info.PlaybackStatus()? == Status::Playing,
                can_play_pause: controls.IsPlayPauseToggleEnabled()?
                    || controls.IsPlayEnabled()?
                    || controls.IsPauseEnabled()?,
                can_next: controls.IsNextEnabled()?,
                can_previous: controls.IsPreviousEnabled()?,
                can_seek: controls.IsPlaybackPositionEnabled()?,
                shuffle,
                repeat,
                position_ms: ms(timeline.Position()?.Duration - start),
                duration_ms: ms(timeline.EndTime()?.Duration - start),
                position_at: file_time_to_unix_ms(timeline.LastUpdatedTime()?.UniversalTime),
                volume,
                muted,
            })
        }

        fn app_name(&mut self, id: &str) -> String {
            self.names
                .entry(id.to_string())
                .or_insert_with(|| {
                    AppInfo::GetFromAppUserModelId(&HSTRING::from(id))
                        .and_then(|a| a.DisplayInfo())
                        .and_then(|d| d.DisplayName())
                        .map(|n| n.to_string())
                        .ok()
                        .filter(|n| !n.is_empty())
                        .unwrap_or_else(|| fallback_app_name(id))
                })
                .clone()
        }

        fn endpoint(&self) -> Result<IAudioEndpointVolume> {
            let devices = self
                .devices
                .as_ref()
                .ok_or_else(windows::core::Error::empty)?;
            // Read each time, so a new default device (headphones plugged in) is picked up.
            unsafe {
                devices
                    .GetDefaultAudioEndpoint(eRender, eMultimedia)?
                    .Activate(CLSCTX_ALL, None)
            }
        }

        fn volume(&self) -> Result<(f32, bool)> {
            let ep = self.endpoint()?;
            unsafe { Ok((ep.GetMasterVolumeLevelScalar()?, ep.GetMute()?.as_bool())) }
        }

        fn refresh_volume(&mut self) {
            let Some(mut next) = self.snapshot.clone() else {
                return;
            };
            let Ok((volume, muted)) = self.volume() else {
                return;
            };
            next.volume = volume;
            next.muted = muted;
            self.publish(Some(next));
        }

        fn publish(&mut self, next: Option<MediaSnapshot>) {
            if next == self.snapshot {
                return;
            }
            self.snapshot = next;
            let _ = self.app.emit("media://changed", &self.snapshot);
        }

        fn control(&mut self, cmd: MediaCommand) -> Result<()> {
            match cmd {
                MediaCommand::SetVolume { level } => {
                    let level = if level.is_finite() {
                        level.clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    unsafe {
                        self.endpoint()?
                            .SetMasterVolumeLevelScalar(level, std::ptr::null())?
                    };
                    self.refresh_volume();
                    return Ok(());
                }
                MediaCommand::ToggleMute => {
                    let ep = self.endpoint()?;
                    unsafe { ep.SetMute(!ep.GetMute()?.as_bool(), std::ptr::null())? };
                    self.refresh_volume();
                    return Ok(());
                }
                _ => {}
            }
            let Some(s) = self.current() else {
                return Ok(());
            };
            match cmd {
                MediaCommand::PlayPause => {
                    s.TryTogglePlayPauseAsync()?.join()?;
                }
                MediaCommand::Next => {
                    s.TrySkipNextAsync()?.join()?;
                }
                MediaCommand::Previous => {
                    s.TrySkipPreviousAsync()?.join()?;
                }
                MediaCommand::ToggleShuffle => {
                    let on = s
                        .GetPlaybackInfo()?
                        .IsShuffleActive()
                        .and_then(|v| v.Value())
                        .unwrap_or(false);
                    s.TryChangeShuffleActiveAsync(!on)?.join()?;
                }
                MediaCommand::CycleRepeat => {
                    let now = match s
                        .GetPlaybackInfo()?
                        .AutoRepeatMode()
                        .and_then(|v| v.Value())
                    {
                        Ok(Repeat::Track) => "track",
                        Ok(Repeat::List) => "list",
                        _ => "none",
                    };
                    let next = match next_repeat(now) {
                        "list" => Repeat::List,
                        "track" => Repeat::Track,
                        _ => Repeat::None,
                    };
                    s.TryChangeAutoRepeatModeAsync(next)?.join()?;
                }
                MediaCommand::Seek { position_ms } => {
                    let start = s.GetTimelineProperties()?.StartTime()?.Duration;
                    let ticks = i64::try_from(position_ms).unwrap_or(i64::MAX / 10_000) * 10_000;
                    s.TryChangePlaybackPositionAsync(start + ticks)?.join()?;
                }
                MediaCommand::SetVolume { .. } | MediaCommand::ToggleMute => {}
            }
            Ok(())
        }
    }

    /// A handler that only wakes the worker, which rereads everything.
    fn changed<S, A>(tx: Sender<Msg>) -> TypedEventHandler<S, A>
    where
        S: windows::core::RuntimeType + 'static,
        A: windows::core::RuntimeType + 'static,
    {
        TypedEventHandler::new(move |_, _| {
            let _ = tx.send(Msg::Changed);
            Ok(())
        })
    }

    /// The thumbnail re-encoded as a JPEG at most `ART_PX` on its longer side.
    fn scaled_art(thumb: &IRandomAccessStreamReference) -> Result<Vec<u8>> {
        let input = thumb.OpenReadAsync()?.join()?;
        let decoder = BitmapDecoder::CreateAsync(&input)?.join()?;
        let (w, h) = (decoder.PixelWidth()?.max(1), decoder.PixelHeight()?.max(1));
        let scale = (f64::from(ART_PX) / f64::from(w.max(h))).min(1.0);
        let bitmap = decoder
            .GetSoftwareBitmapConvertedAsync(BitmapPixelFormat::Bgra8, BitmapAlphaMode::Ignore)?
            .join()?;
        let out = InMemoryRandomAccessStream::new()?;
        let encoder = BitmapEncoder::CreateAsync(BitmapEncoder::JpegEncoderId()?, &out)?.join()?;
        encoder.SetSoftwareBitmap(&bitmap)?;
        let transform = encoder.BitmapTransform()?;
        transform.SetScaledWidth(((f64::from(w) * scale).round() as u32).max(1))?;
        transform.SetScaledHeight(((f64::from(h) * scale).round() as u32).max(1))?;
        transform.SetInterpolationMode(BitmapInterpolationMode::Fant)?;
        encoder.FlushAsync()?.join()?;
        let size = u32::try_from(out.Size()?).unwrap_or(0);
        let reader = DataReader::CreateDataReader(&out.GetInputStreamAt(0)?)?;
        reader.LoadAsync(size)?.join()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes)?;
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_fall_back_to_the_readable_part_of_the_id() {
        assert_eq!(
            fallback_app_name("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"),
            "Spotify"
        );
        assert_eq!(fallback_app_name("Chrome"), "Chrome");
        assert_eq!(
            fallback_app_name(r"C:\Program Files\VideoLAN\VLC\vlc.exe"),
            "vlc"
        );
        assert_eq!(fallback_app_name("firefox.EXE"), "firefox");
        assert_eq!(fallback_app_name(""), "");
    }

    #[test]
    fn repeat_cycles_off_list_track() {
        assert_eq!(next_repeat("none"), "list");
        assert_eq!(next_repeat("list"), "track");
        assert_eq!(next_repeat("track"), "none");
    }

    #[test]
    fn file_times_convert_to_unix_ms() {
        assert_eq!(file_time_to_unix_ms(116_444_736_000_000_000), 0);
        assert_eq!(file_time_to_unix_ms(116_444_736_000_000_000 + 15_000), 1);
        assert_eq!(file_time_to_unix_ms(0), 0);
    }

    #[test]
    fn commands_parse_from_the_front_ends_shape() {
        let c: MediaCommand =
            serde_json::from_str(r#"{ "kind": "seek", "positionMs": 1500 }"#).unwrap();
        assert!(matches!(c, MediaCommand::Seek { position_ms: 1500 }));
        let c: MediaCommand = serde_json::from_str(r#"{ "kind": "playPause" }"#).unwrap();
        assert!(matches!(c, MediaCommand::PlayPause));
    }
}
