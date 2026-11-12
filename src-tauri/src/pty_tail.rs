//! The recent output of one pty, kept so a page that replaces a crashed or reloaded one can
//! reattach to a running shell and redraw it (docs/design/terminal.md section 3.1).

/// How much output a replay carries. A shell's visible screen is redrawn by ConPTY on the
/// resize that follows an attach, so this only has to cover useful scrollback.
pub const TAIL_BYTES: usize = 1024 * 1024;

pub struct OutputTail {
    buf: Vec<u8>,
    cap: usize,
    /// True once output older than `buf` has been dropped.
    dropped: bool,
}

impl OutputTail {
    pub fn new(cap: usize) -> Self {
        Self { buf: Vec::new(), cap, dropped: false }
    }

    /// Appends output. The buffer runs to twice the cap before the oldest half goes, so the
    /// drain's copy is paid once per `cap` bytes rather than on every chunk.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() > self.cap * 2 {
            let cut = self.buf.len() - self.cap;
            self.buf.drain(..cut);
            self.dropped = true;
        }
    }

    /// At most `cap` of the newest bytes. When older output exists, the replay starts after the
    /// first line break, so it does not open partway through a character or escape sequence.
    pub fn replay(&self) -> &[u8] {
        let start = self.buf.len().saturating_sub(self.cap);
        let window = &self.buf[start..];
        if start == 0 && !self.dropped {
            return window;
        }
        match window.iter().position(|&b| b == b'\n') {
            Some(i) => &window[i + 1..],
            None => window,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_output_replays_whole() {
        let mut t = OutputTail::new(16);
        t.push(b"ab\ncd");
        t.push(b"ef");
        assert_eq!(t.replay(), b"ab\ncdef");
    }

    #[test]
    fn long_output_keeps_the_newest_from_a_line_start() {
        let mut t = OutputTail::new(8);
        t.push(b"0123456\n89abcdef\nXYZ");
        // Only the newest 8 bytes, "cdef\nXYZ", are kept; the replay starts after their first break.
        assert_eq!(t.replay(), b"XYZ");
    }

    #[test]
    fn trimmed_buffer_still_starts_at_a_line() {
        let mut t = OutputTail::new(4);
        for _ in 0..10 {
            t.push(b"ab\n");
        }
        assert!(t.buf.len() <= 8);
        assert_eq!(t.replay(), b"ab\n");
    }

    #[test]
    fn a_line_longer_than_the_cap_replays_its_tail() {
        let mut t = OutputTail::new(4);
        t.push(b"abcdefghij");
        assert_eq!(t.replay(), b"ghij");
    }
}
