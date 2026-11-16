//! Filters shared by the `notify` file watchers.

/// Whether an event only reports a file being opened, read, or closed. inotify reports these on
/// Linux, and each watcher reads what it watches when it reacts, so passing them on would make
/// every reaction trigger the next one. A `Close(Write)` is dropped too: the `Modify` events
/// before it already reported the change.
pub fn is_access(ev: &notify::Result<notify::Event>) -> bool {
    matches!(ev, Ok(e) if matches!(e.kind, notify::EventKind::Access(_)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind};
    use notify::{Event, EventKind};

    #[test]
    fn only_access_events_are_access() {
        for kind in [
            AccessKind::Open(AccessMode::Any),
            AccessKind::Read,
            AccessKind::Close(AccessMode::Write),
            AccessKind::Any,
        ] {
            assert!(is_access(&Ok(Event::new(EventKind::Access(kind)))), "{kind:?}");
        }
        assert!(!is_access(&Ok(Event::new(EventKind::Modify(ModifyKind::Any)))));
        assert!(!is_access(&Ok(Event::new(EventKind::Create(CreateKind::File)))));
        assert!(!is_access(&Err(notify::Error::generic("overflow"))));
    }
}
