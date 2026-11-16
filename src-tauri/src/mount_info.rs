//! Which file system holds a path on Linux, from `/proc/self/mountinfo`. The parsing is pure so
//! it is tested on every OS; only Linux calls it.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::path::{Path, PathBuf};

/// One mountinfo line's mount point and file system type.
#[derive(Debug, PartialEq)]
struct Mount {
    point: PathBuf,
    fs_type: String,
}

/// Mountinfo octal-escapes space, tab, newline, and backslash in paths (`\040`).
fn unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let oct = bytes.get(i + 1..i + 4).filter(|d| bytes[i] == b'\\' && d.iter().all(|b| (b'0'..=b'7').contains(b)));
        match oct {
            Some(d) => {
                out.push(d.iter().fold(0u8, |n, b| n.wrapping_mul(8) + (b - b'0')));
                i += 4;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Field 5 is the mount point; the type is the first field after the lone `-` that ends the
/// optional fields.
fn parse_line(line: &str) -> Option<Mount> {
    let fields: Vec<&str> = line.split(' ').collect();
    let point = fields.get(4)?;
    let dash = fields.iter().skip(6).position(|f| *f == "-")? + 6;
    let fs_type = fields.get(dash + 1)?;
    Some(Mount { point: PathBuf::from(unescape(point)), fs_type: (*fs_type).to_string() })
}

/// The type of the mount holding `path` (absolute, symlinks resolved): the longest mount point
/// above it, and among equal ones the last listed, since a later mount covers an earlier one.
fn fs_type_at(mountinfo: &str, path: &Path) -> Option<String> {
    mountinfo
        .lines()
        .filter_map(parse_line)
        .filter(|m| path.starts_with(&m.point))
        .fold(None::<Mount>, |best, m| match best {
            Some(b) if b.point.as_os_str().len() > m.point.as_os_str().len() => Some(b),
            _ => Some(m),
        })
        .map(|m| m.fs_type)
}

/// The file system type (`ext4`, `vfat`, `fuseblk`, ...) of the volume holding `path`.
pub fn fs_type(path: &Path) -> Option<String> {
    let path = std::fs::canonicalize(path).ok()?;
    fs_type_at(&std::fs::read_to_string("/proc/self/mountinfo").ok()?, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INFO: &str = "\
22 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw
30 22 0:25 / /home rw,relatime shared:2 - btrfs /dev/sda3 rw,subvol=/home
41 30 8:17 / /home/me/USB\\040Stick rw,nosuid master:9 - vfat /dev/sdb1 rw,fmask=0022
42 22 0:40 / /mnt/win rw - fuseblk /dev/sdc1 rw,user_id=0
43 22 0:41 / /mnt/win rw - ntfs3 /dev/sdc1 rw
";

    #[test]
    fn the_deepest_mount_above_the_path_wins() {
        assert_eq!(fs_type_at(INFO, Path::new("/etc/passwd")).as_deref(), Some("ext4"));
        assert_eq!(fs_type_at(INFO, Path::new("/home/me/x")).as_deref(), Some("btrfs"));
        assert_eq!(fs_type_at(INFO, Path::new("/home/me/USB Stick/a.sh")).as_deref(), Some("vfat"));
        assert_eq!(fs_type_at(INFO, Path::new("/home/me/USB Sticker")).as_deref(), Some("btrfs"));
    }

    #[test]
    fn a_later_mount_on_the_same_point_covers_the_earlier() {
        assert_eq!(fs_type_at(INFO, Path::new("/mnt/win/setup.exe")).as_deref(), Some("ntfs3"));
    }

    #[test]
    fn unparseable_lines_are_skipped() {
        assert_eq!(fs_type_at("junk\n", Path::new("/x")), None);
        assert_eq!(unescape(r"a\040b\134c\9"), r"a b\c\9");
    }
}
