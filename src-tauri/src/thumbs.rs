//! Project thumbnails for the launch-screen grid.
//!
//! Capture is a WKWebView *self*-snapshot (`takeSnapshotWithConfiguration:`):
//! the webview rasterises its own layer tree, so it sees through the
//! cross-origin canvas iframe that a DOM rasteriser can't read, and it needs
//! no Screen Recording permission the way `screencapture`/CGWindowList would.
//! PNGs live in the app config dir next to `recents.json` — never in the
//! user's project.

use serde::Deserialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DIR_NAME: &str = "thumbs";
/// Cards render ~240pt wide; 640 is plenty at 2×, and keeps PNGs ~100 KB.
const SNAPSHOT_WIDTH: f64 = 640.0;

/// Region of the webview to capture, in CSS px (= AppKit points at zoom 1).
/// `None` captures the whole webview.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Stable file name per project root (FNV-1a — paths are arbitrary, file
/// names can't be).
fn key(root: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in root.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?
        .join(DIR_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir thumbs dir: {e}"))?;
    Ok(dir)
}

fn file(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
    Ok(dir(app)?.join(format!("{}.png", key(root))))
}

/// The stored thumbnail as a `data:` URL, or `None` when the project has
/// never been captured (the grid falls back to a generated card).
pub fn load(app: &AppHandle, root: &str) -> Option<String> {
    let bytes = std::fs::read(file(app, root).ok()?).ok()?;
    if bytes.is_empty() {
        return None;
    }
    use base64::Engine as _;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// Drop a project's thumbnail (recents removal — nothing should outlive the
/// entry that references it).
pub fn forget(app: &AppHandle, root: &str) {
    if let Ok(path) = file(app, root) {
        let _ = std::fs::remove_file(path);
    }
}

pub fn capture(app: &AppHandle, root: &str, rect: Option<Rect>) -> Result<(), String> {
    let out = file(app, root)?;
    let png = snapshot_png(app, rect)?;
    std::fs::write(&out, png).map_err(|e| format!("write thumbnail: {e}"))
}

#[cfg(target_os = "macos")]
pub fn snapshot_png(app: &AppHandle, rect: Option<Rect>) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSNumber, NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::mpsc;
    use std::time::Duration;

    /// Runs on the main thread inside the completion block.
    unsafe fn encode(image: *mut NSImage, error: *mut NSError) -> Result<Vec<u8>, String> {
        if let Some(err) = error.as_ref() {
            return Err(err.localizedDescription().to_string());
        }
        let image = image.as_ref().ok_or("snapshot returned no image")?;
        let tiff = image
            .TIFFRepresentation()
            .ok_or("snapshot has no bitmap representation")?;
        let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("snapshot bitmap unreadable")?;
        let png = rep
            .representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
            .ok_or("PNG encoding failed")?;
        Ok(png.to_vec())
    }

    let window = app
        .get_webview_window("main")
        .ok_or("main window is gone")?;
    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    // `with_webview` hops to the main thread for us; the snapshot itself is
    // asynchronous, hence the channel. Must not be called *from* the main
    // thread — the command is async/blocking-spawned so it never is.
    window
        .with_webview(move |platform| unsafe {
            let webview: &WKWebView = &*platform.inner().cast();
            let mtm = MainThreadMarker::new_unchecked();
            let config = WKSnapshotConfiguration::new(mtm);
            if let Some(r) = rect {
                config.setRect(NSRect::new(
                    NSPoint::new(r.x, r.y),
                    NSSize::new(r.width, r.height),
                ));
            }
            // Scales the snapshot down for us — no image resampling on our side.
            config.setSnapshotWidth(Some(&NSNumber::new_f64(SNAPSHOT_WIDTH)));
            // The canvas is already on screen; waiting for updates can hang
            // behind an in-flight HMR paint.
            config.setAfterScreenUpdates(false);
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let _ = tx.send(encode(image, error));
            });
            webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        })
        .map_err(|e| format!("webview handle: {e}"))?;

    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "snapshot timed out".to_string())?
}

#[cfg(not(target_os = "macos"))]
pub fn snapshot_png(_app: &AppHandle, _rect: Option<Rect>) -> Result<Vec<u8>, String> {
    Err("thumbnail capture is only implemented on macOS".to_string())
}

#[cfg(test)]
mod tests {
    use super::key;

    #[test]
    fn key_is_stable_and_path_safe() {
        let a = key("/Users/x/projects/shop");
        assert_eq!(a, key("/Users/x/projects/shop"));
        assert_ne!(a, key("/Users/x/projects/shop2"));
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
