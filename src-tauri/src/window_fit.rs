//! Fits the main window's starting size to the screen (docs/design/app.md section 3.34).
//!
//! `tauri.conf.json` asks for 1200 by 800 logical pixels. An X11 window manager or Windows
//! shrinks a window that would not fit, but a Wayland compositor maps it at the size the app
//! asks for, so on a 1366 by 768 laptop the title bar sits on screen and the bottom edge below
//! it, out of reach of a resize. The size is clamped before the window is built, so nothing
//! draws at the wrong size first.

/// The share of the monitor's work area the window's content may take. GDK on Wayland reports
/// the whole monitor as its work area, since the compositor keeps panel geometry to itself, and
/// the size set is the content's, without the title bar, so the margin leaves room for both.
const FILL: f64 = 0.85;

/// How the window opens on a screen with `area` (the monitor's work area in logical pixels).
#[derive(Debug, PartialEq)]
pub enum Fit {
    /// At this logical content size: `wanted`, shrunk on each axis to fit `FILL` of the area.
    Size(f64, f64),
    /// Maximized: the screen leaves less than `floor`, the smallest size the window is still
    /// usable at, inside the margin (1366 by 768 at 200 percent is 683 by 384), and a window
    /// sized to the whole screen would put its title bar out of reach.
    Maximized,
}

pub fn fit(wanted: (f64, f64), area: (f64, f64), floor: (f64, f64)) -> Fit {
    let room = ((area.0 * FILL).floor(), (area.1 * FILL).floor());
    if room.0 < floor.0.min(wanted.0) || room.1 < floor.1.min(wanted.1) {
        return Fit::Maximized;
    }
    Fit::Size(wanted.0.min(room.0), wanted.1.min(room.1))
}

/// The work area of the monitor the window will open on, in logical pixels: the primary one,
/// or the first one when the platform names no primary (GDK on Wayland).
pub fn work_area(app: &tauri::AppHandle) -> Option<(f64, f64)> {
    let monitor = match app.primary_monitor() {
        Ok(Some(m)) => m,
        _ => app.available_monitors().ok()?.into_iter().next()?,
    };
    let size = monitor.work_area().size.to_logical::<f64>(monitor.scale_factor());
    (size.width > 0.0 && size.height > 0.0).then_some((size.width, size.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOOR: (f64, f64) = (640.0, 400.0);

    #[test]
    fn a_window_that_fits_keeps_its_size() {
        assert_eq!(fit((1200.0, 800.0), (1920.0, 1080.0), FLOOR), Fit::Size(1200.0, 800.0));
    }

    #[test]
    fn a_laptop_screen_shrinks_both_sides() {
        assert_eq!(fit((1200.0, 800.0), (1366.0, 768.0), FLOOR), Fit::Size(1161.0, 652.0));
    }

    #[test]
    fn a_scaled_screen_shrinks_further() {
        // 1366 by 768 at 125 percent is 1092.8 by 614.4 logical pixels.
        assert_eq!(fit((1200.0, 800.0), (1092.8, 614.4), FLOOR), Fit::Size(928.0, 522.0));
    }

    #[test]
    fn a_screen_smaller_than_the_floor_maximizes() {
        // 1366 by 768 at 200 percent.
        assert_eq!(fit((1200.0, 800.0), (683.0, 384.0), FLOOR), Fit::Maximized);
    }

    #[test]
    fn a_small_request_that_fits_is_left_alone() {
        assert_eq!(fit((500.0, 300.0), (683.0, 384.0), FLOOR), Fit::Size(500.0, 300.0));
    }
}
