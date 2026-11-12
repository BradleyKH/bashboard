//! Poison-tolerant locking (docs/design/app.md section 3.22). A thread that panics while holding
//! a lock poisons it, and a plain `lock().unwrap()` then panics every later caller too, so one
//! failed git watcher or transcript parse would spread to the pty and hook state it shares.
//! Every guarded value here is a cache, a registry, or a queue that stays usable after a
//! half-finished update, so taking the guard back is safer than propagating the panic.

use std::sync::{Mutex, MutexGuard};

pub trait LockExt<T: ?Sized> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T>;
}

impl<T: ?Sized> LockExt<T> for Mutex<T> {
    fn lock_or_recover(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|e| e.into_inner())
    }
}
