//! The Linux side of `credential_store`: the Secret Service (GNOME Keyring, KWallet, KeePassXC)
//! first, and a `0600` JSON file only where the user allowed it. Included by
//! `credential_store.rs` with a path attribute, so it too depends on nothing in the crate.

use std::collections::{BTreeMap, HashMap};
use std::fs::{self, DirBuilder, File, OpenOptions, Permissions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

use secret_service::EncryptionType;
use secret_service::blocking::{Collection, Item, SecretService};

use super::{Location, NEEDS_FILE_PERMISSION, wipe};

/// Every item carries this `application` attribute, so a search by it finds only ours.
const APPLICATION: &str = "bashboard";
const FILE_NAME: &str = "credentials.json";
/// Held with `flock` around every read-modify-write of the file, by the app and `bb` alike.
const LOCK_NAME: &str = "credentials.lock";
/// The aliases a new item may go into, in order. `login` is GNOME Keyring's persistent
/// collection, which a service may expose without pointing `default` at it.
const COLLECTION_ALIASES: [&str; 2] = ["default", "login"];

/// The session, or `None` when no session bus or no Secret Service answers, or when the service
/// has no collection a new item could go into (KeePassXC with no database exposed, for one). The
/// last counts as no keyring, so a save falls back to the file instead of failing every time.
fn connect() -> Option<SecretService<'static>> {
    let ss = SecretService::connect(EncryptionType::Dh).ok()?;
    let usable = keyring::collection(&ss).is_some();
    usable.then_some(ss)
}

/// The keyring, through one connected session.
pub(super) mod keyring {
    use super::*;

    fn attributes(target: &str) -> HashMap<&str, &str> {
        HashMap::from([("application", APPLICATION), ("target", target)])
    }

    fn items<'a>(ss: &'a SecretService<'a>, target: &str) -> Result<Vec<Item<'a>>, String> {
        let found = ss.search_items(attributes(target)).map_err(err)?;
        Ok(found.unlocked.into_iter().chain(found.locked).collect())
    }

    fn err(e: secret_service::Error) -> String {
        format!("the keyring refused: {e}")
    }

    /// The collection new items go into; looking it up never unlocks it.
    pub fn collection<'a>(ss: &'a SecretService<'a>) -> Option<Collection<'a>> {
        COLLECTION_ALIASES
            .iter()
            .find_map(|alias| ss.get_collection_by_alias(alias).ok())
    }

    /// The secret's text; unlocking a locked item may show the keyring's prompt.
    pub fn read(ss: &SecretService<'_>, target: &str) -> Result<Option<String>, String> {
        for item in items(ss, target)? {
            item.ensure_unlocked().map_err(err)?;
            let bytes = item.get_secret().map_err(err)?;
            let text = std::str::from_utf8(&bytes)
                .ok()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty());
            wipe_bytes(bytes);
            if text.is_some() {
                return Ok(text);
            }
        }
        Ok(None)
    }

    /// Searches attributes only, so a locked keyring stays locked.
    pub fn exists(ss: &SecretService<'_>, target: &str) -> bool {
        items(ss, target).is_ok_and(|i| !i.is_empty())
    }

    /// The targets starting with `prefix` (compared case-insensitively), from attributes only.
    pub fn targets(ss: &SecretService<'_>, prefix: &str) -> Vec<String> {
        let Ok(found) = ss.search_items(HashMap::from([("application", APPLICATION)])) else {
            return Vec::new();
        };
        found
            .unlocked
            .iter()
            .chain(&found.locked)
            .filter_map(|i| i.get_attributes().ok()?.remove("target"))
            .filter(|t| has_prefix(t, prefix))
            .collect()
    }

    /// Replaces any item with the same attributes. A locked collection is unlocked first, which
    /// may show the keyring's prompt.
    pub fn write(ss: &SecretService<'_>, target: &str, blob: &[u8]) -> Result<(), String> {
        let collection = collection(ss).ok_or("the keyring has no collection to store into")?;
        collection.ensure_unlocked().map_err(err)?;
        collection
            .create_item(
                &format!("Bashboard {target}"),
                attributes(target),
                blob,
                true,
                "text/plain",
            )
            .map_err(err)?;
        Ok(())
    }

    /// False when nothing matched.
    pub fn delete(ss: &SecretService<'_>, target: &str) -> Result<bool, String> {
        let found = items(ss, target)?;
        for item in &found {
            item.ensure_unlocked().map_err(err)?;
            item.delete().map_err(err)?;
        }
        Ok(!found.is_empty())
    }
}

fn has_prefix(target: &str, prefix: &str) -> bool {
    target
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// One stored token. Dropping it wipes the token.
#[derive(serde::Serialize, serde::Deserialize)]
struct Entry {
    user: String,
    token: String,
}

impl Drop for Entry {
    fn drop(&mut self) {
        wipe(std::mem::take(&mut self.token));
    }
}

type Entries = BTreeMap<String, Entry>;

/// `wipe` for bytes that need not be UTF-8.
fn wipe_bytes(mut bytes: Vec<u8>) {
    for b in bytes.iter_mut() {
        // SAFETY: as in `wipe`.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// The fallback file, `credentials.json` in a folder only the user can enter. The folder is a
/// field so tests use a temporary one.
pub struct FileStore {
    dir: PathBuf,
}

impl FileStore {
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    /// `$XDG_DATA_HOME/bashboard`, else `~/.local/share/bashboard`; `None` without a home.
    pub fn default_location() -> Option<Self> {
        let data = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| {
                let home = PathBuf::from(std::env::var_os("HOME")?);
                home.is_absolute().then(|| home.join(".local/share"))
            })?;
        Some(Self::at(data.join("bashboard")))
    }

    pub fn path(&self) -> PathBuf {
        self.dir.join(FILE_NAME)
    }

    pub fn exists(&self) -> bool {
        self.path().is_file()
    }

    /// The entries; a missing file is empty. A file that does not parse is an error, and the
    /// message never quotes it, since parse errors can echo values.
    fn load(&self) -> Result<Entries, String> {
        let path = self.path();
        let bytes = match read_exactly(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Entries::new()),
            Err(e) => return Err(format!("could not read {}: {e}", path.display())),
        };
        let parsed = serde_json::from_slice::<Entries>(&bytes);
        wipe_bytes(bytes);
        parsed.map_err(|_| {
            format!(
                "{} is not a valid credentials file, so Bashboard leaves it alone; fix or remove it",
                path.display()
            )
        })
    }

    /// Reads tolerate a corrupt file as empty; only writes refuse it.
    fn load_or_empty(&self) -> Entries {
        self.load().unwrap_or_default()
    }

    pub fn read(&self, target: &str) -> Option<String> {
        let entries = self.load_or_empty();
        let token = entries.get(target)?.token.trim();
        (!token.is_empty()).then(|| token.to_string())
    }

    pub fn has(&self, target: &str) -> bool {
        self.load_or_empty().contains_key(target)
    }

    pub fn targets(&self, prefix: &str) -> Vec<String> {
        self.load_or_empty()
            .keys()
            .filter(|t| has_prefix(t, prefix))
            .cloned()
            .collect()
    }

    pub fn write(&self, target: &str, user: &str, token: &str) -> Result<(), String> {
        let _lock = self.lock()?;
        let mut entries = self.load()?;
        entries.insert(
            target.to_string(),
            Entry {
                user: user.to_string(),
                token: token.to_string(),
            },
        );
        self.save(&entries)
    }

    /// Removes the targets, keeping the file (an empty one too: its presence is what lets `bb`
    /// write to it). False when none was stored.
    pub fn remove(&self, targets: &[&str]) -> Result<bool, String> {
        if !self.exists() {
            return Ok(false);
        }
        let _lock = self.lock()?;
        self.remove_locked(targets)
    }

    /// `remove` for a caller already holding the lock.
    fn remove_locked(&self, targets: &[&str]) -> Result<bool, String> {
        let mut entries = self.load()?;
        let before = entries.len();
        for t in targets {
            entries.remove(*t);
        }
        if entries.len() == before {
            return Ok(false);
        }
        self.save(&entries)?;
        Ok(true)
    }

    /// An exclusive lock on `credentials.lock`, released when the returned file drops. Every
    /// read-modify-write takes it, so the app and `bb` saving at once both land. `flock` locks
    /// per open file, so threads of one process exclude each other too, and a holder must not
    /// take it again.
    fn lock(&self) -> Result<File, String> {
        let path = self.dir.join(LOCK_NAME);
        let fail = |e: io::Error| format!("could not lock {}: {e}", path.display());
        self.ensure_dir().map_err(fail)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(&path)
            .map_err(fail)?;
        loop {
            // SAFETY: the descriptor stays open for the call, and `flock` touches no memory.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                return Ok(file);
            }
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(fail(e));
            }
        }
    }

    fn ensure_dir(&self) -> io::Result<()> {
        if let Some(parent) = self.dir.parent() {
            fs::create_dir_all(parent)?;
        }
        match DirBuilder::new().mode(0o700).create(&self.dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
        let meta = fs::metadata(&self.dir)?;
        if !meta.is_dir() {
            return Err(io::Error::other("it is not a folder"));
        }
        if meta.permissions().mode() & 0o777 != 0o700 {
            fs::set_permissions(&self.dir, Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Writes a temporary file beside the real one and renames it over, so a crash leaves the old
    /// file or the new one. The temporary file is created `0600`, never wider, before any byte
    /// goes in.
    fn save(&self, entries: &Entries) -> Result<(), String> {
        let path = self.path();
        let fail = |e: io::Error| format!("could not write {}: {e}", path.display());
        self.ensure_dir().map_err(fail)?;
        let json = serialize(entries).map_err(|_| format!("could not write {}", path.display()))?;
        let (tmp, mut file) = self.create_temp().map_err(fail)?;
        let written = (|| {
            file.set_permissions(Permissions::from_mode(0o600))?;
            file.write_all(&json)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&tmp, &path)
        })();
        wipe_bytes(json);
        if let Err(e) = written {
            let _ = fs::remove_file(&tmp);
            return Err(fail(e));
        }
        // Makes the rename itself durable; the data is safe either way.
        if let Ok(dir) = File::open(&self.dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    fn create_temp(&self) -> io::Result<(PathBuf, File)> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        for attempt in 0..16u32 {
            let tmp = self.dir.join(format!(
                ".{FILE_NAME}.{}.{nanos}.{attempt}.tmp",
                std::process::id()
            ));
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&tmp)
            {
                Ok(f) => return Ok((tmp, f)),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::other("no free temporary file name"))
    }
}

/// The whole file, read into a buffer sized from its length up front: a buffer grown while
/// reading would leave unwiped copies of the tokens in the memory it gave up. Writers rename a new
/// file over this one rather than changing it, so the open file's length holds.
fn read_exactly(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let len = usize::try_from(file.metadata()?.len()).map_err(io::Error::other)?;
    let mut bytes = vec![0u8; len];
    if let Err(e) = file.read_exact(&mut bytes) {
        wipe_bytes(bytes);
        return Err(e);
    }
    Ok(bytes)
}

/// Counts the bytes written to it, so the file's buffer is allocated once at its final size.
struct Counter(usize);

impl Write for Counter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The file's text and its final newline, in a buffer that never reallocates, since a
/// reallocation would leave a token copy behind in freed memory. The caller wipes it.
fn serialize(entries: &Entries) -> serde_json::Result<Vec<u8>> {
    let mut counter = Counter(0);
    serde_json::to_writer_pretty(&mut counter, entries)?;
    let size = counter.0 + 1;
    let mut json = Vec::with_capacity(size);
    let written = serde_json::to_writer_pretty(&mut json, entries);
    json.push(b'\n');
    debug_assert_eq!(json.capacity(), size);
    match written {
        Ok(()) => Ok(json),
        Err(e) => {
            wipe_bytes(json);
            Err(e)
        }
    }
}

/// Both stores, either of which may be absent; the public functions connect and pass them in, and
/// the tests pass a temporary file and no keyring.
pub(super) struct Stores<'s, 'a> {
    pub keyring: Option<&'s SecretService<'a>>,
    pub file: Option<&'s FileStore>,
}

/// A target in both stores is the file's: a keyring save always removes the file copy, so a file
/// copy that exists was saved later, while the keyring was unreachable. Its location is then the
/// file, which offers Move to keyring, and the move replaces the older keyring item.
impl Stores<'_, '_> {
    fn read(&self, target: &str) -> Option<String> {
        self.file
            .and_then(|f| f.read(target))
            .or_else(|| keyring::read(self.keyring?, target).ok().flatten())
    }

    fn location(&self, target: &str) -> Option<Location> {
        if self.file.is_some_and(|f| f.has(target)) {
            Some(Location::File)
        } else if self.keyring.is_some_and(|ss| keyring::exists(ss, target)) {
            Some(Location::Keyring)
        } else {
            None
        }
    }

    fn list(&self, prefix: &str) -> Vec<(String, Location)> {
        let mut found: Vec<(String, Location)> = self
            .file
            .map(|f| f.targets(prefix))
            .unwrap_or_default()
            .into_iter()
            .map(|t| (t, Location::File))
            .collect();
        let in_keyring = self.keyring.map(|ss| keyring::targets(ss, prefix));
        for t in in_keyring.unwrap_or_default() {
            if !found.iter().any(|(k, _)| *k == t) {
                found.push((t, Location::Keyring));
            }
        }
        found
    }

    fn write(
        &self,
        target: &str,
        user: &str,
        blob: &[u8],
        allow_file: bool,
    ) -> Result<Location, String> {
        if let Some(ss) = self.keyring {
            keyring::write(ss, target, blob)?;
            // A file copy would shadow the new keyring item.
            if let Some(f) = self.file {
                let _ = f.remove(&[target]);
            }
            return Ok(Location::Keyring);
        }
        if !allow_file {
            return Err(NEEDS_FILE_PERMISSION.into());
        }
        let file = self
            .file
            .ok_or("there is no home folder to keep the credentials file in")?;
        let token = std::str::from_utf8(blob).map_err(|_| "the token is not UTF-8".to_string())?;
        file.write(target, user, token)?;
        Ok(Location::File)
    }

    fn delete(&self, target: &str) -> Result<bool, String> {
        let in_keyring = match self.keyring {
            Some(ss) => keyring::delete(ss, target)?,
            None => false,
        };
        let in_file = match self.file {
            Some(f) => f.remove(&[target])?,
            None => false,
        };
        Ok(in_keyring || in_file)
    }

    /// Writes every file token to the keyring, then removes the moved ones from the file.
    fn move_to_keyring(&self) -> Result<usize, String> {
        let ss = self.keyring.ok_or("no keyring is running")?;
        let Some(file) = self.file.filter(|f| f.exists()) else {
            return Ok(0);
        };
        // Held throughout, so a token `bb` saves meanwhile is not removed unmoved.
        let _lock = file.lock()?;
        let entries = file.load()?;
        let mut moved: Vec<&str> = Vec::new();
        let mut failure = None;
        for (target, entry) in &entries {
            match keyring::write(ss, target, entry.token.as_bytes()) {
                Ok(()) => moved.push(target),
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        file.remove_locked(&moved)?;
        match failure {
            Some(e) => Err(e),
            None => Ok(moved.len()),
        }
    }
}

fn with_stores<T>(run: impl FnOnce(&Stores) -> T) -> T {
    let ss = connect();
    let file = FileStore::default_location();
    run(&Stores {
        keyring: ss.as_ref(),
        file: file.as_ref(),
    })
}

/// The stored token's text, from the file, else the keyring (see `Stores`).
pub fn read(target: &str) -> Option<String> {
    with_stores(|s| s.read(target))
}

#[allow(dead_code)]
pub fn exists(target: &str) -> bool {
    location(target).is_some()
}

pub fn location(target: &str) -> Option<Location> {
    with_stores(|s| s.location(target))
}

pub fn list_located(prefix: &str) -> Vec<(String, Location)> {
    with_stores(|s| s.list(prefix))
}

#[allow(dead_code)]
pub fn list_targets(prefix: &str) -> Vec<String> {
    list_located(prefix).into_iter().map(|(t, _)| t).collect()
}

/// To the keyring when one answers; otherwise to the file when `allow_file`, else
/// `NEEDS_FILE_PERMISSION`.
pub fn write_with(
    target: &str,
    user: &str,
    blob: &[u8],
    allow_file: bool,
) -> Result<Location, String> {
    with_stores(|s| s.write(target, user, blob, allow_file))
}

/// Removes the token from both stores; false when neither held it.
pub fn delete(target: &str) -> Result<bool, String> {
    with_stores(|s| s.delete(target))
}

pub fn move_file_tokens_to_keyring() -> Result<usize, String> {
    with_stores(|s| s.move_to_keyring())
}

pub fn keyring_available() -> bool {
    connect().is_some()
}

/// Only `bb` asks: to it, an existing file is the user's permission to write there.
#[allow(dead_code)]
pub fn file_store_exists() -> bool {
    FileStore::default_location().is_some_and(|f| f.exists())
}

pub fn file_store_path() -> Option<PathBuf> {
    FileStore::default_location().map(|f| f.path())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("bashboard-cred-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn file_store_round_trip_and_modes() {
        let tmp = TempDir::new("round-trip");
        let store = FileStore::at(tmp.0.join("bashboard"));
        assert!(!store.exists());
        assert_eq!(store.read("bashboard:bitbucket.org"), None);
        store
            .write("bashboard:bitbucket.org", "u", "tok-1")
            .unwrap();
        assert_eq!(mode(&tmp.0.join("bashboard")), 0o700);
        assert_eq!(mode(&store.path()), 0o600);
        assert_eq!(
            store.read("bashboard:bitbucket.org").as_deref(),
            Some("tok-1")
        );
        assert!(store.has("bashboard:bitbucket.org"));

        // Replacing keeps the mode, even over a file someone loosened.
        fs::set_permissions(store.path(), Permissions::from_mode(0o644)).unwrap();
        store
            .write("bashboard:bitbucket.org", "u", "tok-2")
            .unwrap();
        assert_eq!(mode(&store.path()), 0o600);
        assert_eq!(
            store.read("bashboard:bitbucket.org").as_deref(),
            Some("tok-2")
        );

        store
            .write("bashboard:dev.azure.com/contoso", "u", "pat")
            .unwrap();
        assert_eq!(
            store.targets("Bashboard:Dev.Azure.com/"),
            vec!["bashboard:dev.azure.com/contoso".to_string()]
        );
        assert!(store.remove(&["bashboard:bitbucket.org"]).unwrap());
        assert!(!store.remove(&["bashboard:bitbucket.org"]).unwrap());
        assert!(!store.has("bashboard:bitbucket.org"));
        assert!(store.remove(&["bashboard:dev.azure.com/contoso"]).unwrap());
        // An emptied file stays, since its presence is `bb`'s permission.
        assert!(store.exists());
        assert!(store.targets("").is_empty());
        // No temporary files are left behind; the lock file is private too.
        let mut names: Vec<String> = fs::read_dir(tmp.0.join("bashboard"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, [FILE_NAME, LOCK_NAME]);
        assert_eq!(mode(&tmp.0.join("bashboard").join(LOCK_NAME)), 0o600);
    }

    #[test]
    fn concurrent_writers_both_land() {
        let tmp = TempDir::new("concurrent");
        let dir = tmp.0.join("bashboard");
        std::thread::scope(|s| {
            for writer in ["a", "b"] {
                let dir = &dir;
                s.spawn(move || {
                    let store = FileStore::at(dir);
                    for i in 0..40 {
                        store.write(&format!("{writer}{i}"), "u", "tok").unwrap();
                    }
                });
            }
        });
        let targets = FileStore::at(&dir).targets("");
        assert_eq!(targets.len(), 80, "{targets:?}");
    }

    #[test]
    fn serializing_allocates_once() {
        let mut entries = Entries::new();
        for i in 0..20 {
            entries.insert(
                format!("target-{i}"),
                Entry {
                    user: "u".into(),
                    token: "t".repeat(100),
                },
            );
        }
        let json = serialize(&entries).unwrap();
        assert_eq!(json.len(), json.capacity());
        assert_eq!(json.last(), Some(&b'\n'));
        let back: Entries = serde_json::from_slice(&json).unwrap();
        assert_eq!(back.len(), 20);
    }

    #[test]
    fn a_loose_folder_is_tightened() {
        let tmp = TempDir::new("loose-folder");
        let dir = tmp.0.join("bashboard");
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, Permissions::from_mode(0o755)).unwrap();
        FileStore::at(&dir).write("t", "u", "x").unwrap();
        assert_eq!(mode(&dir), 0o700);
    }

    #[test]
    fn a_corrupt_file_reads_empty_and_is_never_clobbered() {
        let tmp = TempDir::new("corrupt");
        let store = FileStore::at(tmp.0.join("bashboard"));
        store.write("t", "u", "x").unwrap();
        let garbage = "{\"t\": {\"user\": \"u\", \"token\": \"secret-value\"";
        fs::write(store.path(), garbage).unwrap();
        assert_eq!(store.read("t"), None);
        assert!(store.targets("").is_empty());
        let err = store.write("t2", "u", "y").unwrap_err();
        assert!(!err.contains("secret-value"), "{err}");
        assert!(store.remove(&["t"]).is_err());
        assert_eq!(fs::read_to_string(store.path()).unwrap(), garbage);
    }

    #[test]
    fn writing_without_a_keyring_needs_permission() {
        let tmp = TempDir::new("permission");
        let file = FileStore::at(tmp.0.join("bashboard"));
        let stores = Stores {
            keyring: None,
            file: Some(&file),
        };
        assert_eq!(
            stores.write("t", "u", b"x", false),
            Err(NEEDS_FILE_PERMISSION.to_string())
        );
        assert!(!file.exists());
        assert_eq!(stores.write("t", "u", b"x", true), Ok(Location::File));
        assert_eq!(mode(&file.path()), 0o600);
        assert_eq!(stores.read("t").as_deref(), Some("x"));
        assert_eq!(stores.location("t"), Some(Location::File));
        assert_eq!(stores.list(""), vec![("t".to_string(), Location::File)]);
        assert!(stores.delete("t").unwrap());
        assert!(!stores.delete("t").unwrap());
        assert!(stores.move_to_keyring().is_err());
    }

    /// Needs a running, unlocked Secret Service; run with `--ignored secret_service`.
    #[test]
    #[ignore]
    fn secret_service_round_trip() {
        let ss = connect().expect("a Secret Service on the session bus");
        let target = format!("bashboard:test-secret-service/{}", std::process::id());
        keyring::write(&ss, &target, b"round-trip-token").unwrap();
        assert!(keyring::exists(&ss, &target));
        assert!(keyring::targets(&ss, "BASHBOARD:test-secret-service/").contains(&target));
        assert_eq!(
            keyring::read(&ss, &target).unwrap().as_deref(),
            Some("round-trip-token")
        );
        // Replace on write keeps one item.
        keyring::write(&ss, &target, b"second").unwrap();
        assert_eq!(
            keyring::read(&ss, &target).unwrap().as_deref(),
            Some("second")
        );
        assert!(keyring::delete(&ss, &target).unwrap());
        assert!(!keyring::exists(&ss, &target));
        assert!(!keyring::delete(&ss, &target).unwrap());

        // A file token moves into the keyring and leaves the file.
        let tmp = TempDir::new("move");
        let file = FileStore::at(tmp.0.join("bashboard"));
        file.write(&target, "u", "moved-token").unwrap();
        let stores = Stores {
            keyring: Some(&ss),
            file: Some(&file),
        };
        assert_eq!(stores.location(&target), Some(Location::File));
        assert_eq!(stores.move_to_keyring(), Ok(1));
        assert!(!file.has(&target));
        assert_eq!(stores.location(&target), Some(Location::Keyring));
        assert_eq!(stores.read(&target).as_deref(), Some("moved-token"));
        assert!(stores.delete(&target).unwrap());
        assert_eq!(stores.location(&target), None);

        // A file copy saved while the keyring was away shadows the older keyring item until
        // moved, and the move replaces that item.
        keyring::write(&ss, &target, b"old-keyring-token").unwrap();
        file.write(&target, "u", "newer-file-token").unwrap();
        assert_eq!(stores.read(&target).as_deref(), Some("newer-file-token"));
        assert_eq!(stores.location(&target), Some(Location::File));
        let listed = stores.list("bashboard:test-secret-service/");
        assert_eq!(
            listed.iter().filter(|(t, _)| *t == target).collect::<Vec<_>>(),
            [&(target.clone(), Location::File)]
        );
        assert_eq!(stores.move_to_keyring(), Ok(1));
        assert_eq!(stores.location(&target), Some(Location::Keyring));
        assert_eq!(
            keyring::read(&ss, &target).unwrap().as_deref(),
            Some("newer-file-token")
        );
        assert!(stores.delete(&target).unwrap());
        assert!(!keyring::exists(&ss, &target));
    }
}
