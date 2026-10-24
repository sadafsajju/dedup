//! Export an artboard as a PNG or a PDF.
//!
//! Not a crop of the canvas. `thumbs::snapshot_png` rasterises a region of
//! the app window, which is the right tool for comparing two captures but the
//! wrong one for a deliverable: it is at whatever zoom the canvas is at, it
//! stops at the window edge, and a floating panel over the artboard is in the
//! picture. An export renders the page itself, at its real size.
//!
//! So each export loads the artboard's own URL into a throwaway `WKWebView`
//! sized exactly like the artboard, in a borderless window that is on the
//! window list (WebKit does not paint a view that is ordered out) but placed
//! far off-screen at alpha 0, so it is never seen. Two details make it render
//! what the artboard renders:
//!
//! - It shares the canvas's `WKWebsiteDataStore`, so a real sign-in on the
//!   canvas applies here too — one session, the same rule as every artboard.
//! - The page is loaded *inside an iframe*, as the canvas loads it. The boot
//!   script (mock-session seed, offline, hold) only runs in a framed page, so
//!   loading the URL top-level would export something the artboard does not
//!   show.
//!
//! PNG comes from `takeSnapshot`; PDF from `createPDF`, which is vector — real,
//! selectable text, one page as tall as the artboard.

use serde::Deserialize;

/// Past this many pixels along either side WebKit's snapshot backing store is
/// not something to count on, and the file would be unmanageable anyway. PDF
/// has no such limit — it is vector — which is what the refusal suggests.
const MAX_PNG_SIDE_PX: f64 = 32_000.0;
/// An artboard larger than this is a measurement gone wrong (a page whose
/// height feeds back into itself), not a page.
const MAX_SIDE_PT: f64 = 60_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Pdf,
}

/// One export, as the editor asks for it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// The artboard's frame URL, exactly as the canvas built it (origin,
    /// route and `__dedup` flags).
    pub url: String,
    /// The artboard's size in CSS px — the viewport width and the page height.
    pub width: f64,
    pub height: f64,
    pub format: Format,
    /// PNG only: output pixels per CSS px (1 = the page's own size, 2 = retina).
    pub scale: Option<f64>,
    /// Where to write it — chosen by the user in a save dialog.
    pub path: String,
}

/// What was written, for the editor to report.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    pub path: String,
    pub bytes: u64,
    /// PNG: pixel size. PDF: page size in points.
    pub width: u64,
    pub height: u64,
}

/// Refuse what cannot work before a window is made for it.
fn validate(req: &Request) -> Result<f64, String> {
    if !(req.url.starts_with("http://") || req.url.starts_with("https://")) {
        return Err("an artboard export needs the page's http URL".into());
    }
    for (name, v) in [("width", req.width), ("height", req.height)] {
        if !v.is_finite() || v < 1.0 || v > MAX_SIDE_PT {
            return Err(format!("the artboard's {name} ({v}) isn't a size dedup can export"));
        }
    }
    let scale = req.scale.unwrap_or(1.0);
    if req.format == Format::Png {
        if !(scale.is_finite() && (0.25..=4.0).contains(&scale)) {
            return Err(format!("a scale of {scale} isn't supported — use 1x to 4x"));
        }
        let longest = req.width.max(req.height) * scale;
        if longest > MAX_PNG_SIDE_PX {
            return Err(format!(
                "at {scale}x this page is {longest:.0}px long — too large for a PNG. Export at 1x, or as a PDF (which has no size limit)."
            ));
        }
    }
    if req.path.trim().is_empty() {
        return Err("no file was chosen".into());
    }
    Ok(scale)
}

/// The page the throwaway view loads: the artboard's URL in an iframe of the
/// artboard's exact size, as the canvas frames it. `url` lands inside an
/// attribute, so it is escaped for one.
fn wrapper_html(url: &str, width: f64, height: f64) -> String {
    let src = url
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=\"utf-8\"><style>html,body{{margin:0;background:#fff}}\
         iframe{{border:0;display:block;width:{w}px;height:{h}px}}</style>\
         <iframe src=\"{src}\"></iframe>",
        w = width.round() as i64,
        h = height.round() as i64,
    )
}

/// `takeSnapshot`'s width is in points and comes back at the screen's backing
/// scale, so asking for `width` on a retina screen yields 2× already. This is
/// the width to ask for so the PNG comes out at `scale` × the CSS size.
fn snapshot_width_pt(width: f64, scale: f64, backing: f64) -> f64 {
    width * scale / if backing > 0.0 { backing } else { 1.0 }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSBackingStoreType, NSImage, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSData, NSError, NSNumber, NSPoint, NSRect, NSSize, NSString, NSURL};
    use objc2_web_kit::{
        WKPDFConfiguration, WKSnapshotConfiguration, WKWebView, WKWebViewConfiguration,
    };
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Manager};

    /// The view being exported from. Lives on the main thread only — AppKit
    /// and WebKit objects may not leave it — so it is a thread-local there,
    /// touched only from closures `with_webview` runs on that thread.
    struct Job {
        window: Retained<NSWindow>,
        web: Retained<WKWebView>,
    }
    thread_local! {
        static JOB: RefCell<Option<Job>> = const { RefCell::new(None) };
    }
    /// One export at a time: the thread-local holds one job, and two
    /// concurrent exports would each be waiting on the other's page.
    static BUSY: AtomicBool = AtomicBool::new(false);

    /// Loading a real app (fonts, data, a client-side render) can take a
    /// while; past this it is not going to finish.
    const LOAD_TIMEOUT: Duration = Duration::from_secs(45);
    /// After the load event: time for the app's own first render — a React
    /// app paints after `load`, and its web fonts swap in after that.
    const SETTLE: Duration = Duration::from_millis(1500);
    /// A full-page PDF of a long page, with large images, is real work.
    const CAPTURE_TIMEOUT: Duration = Duration::from_secs(90);

    /// Run `f` on the main thread (via the main window's webview hop, the
    /// same route `thumbs::snapshot_png` takes) and wait for its result.
    fn on_main<R: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce(&WKWebView, MainThreadMarker) -> R + Send + 'static,
    ) -> Result<R, String> {
        let window = app.get_webview_window("main").ok_or("main window is gone")?;
        let (tx, rx) = mpsc::channel();
        window
            .with_webview(move |platform| unsafe {
                let main: &WKWebView = &*platform.inner().cast();
                let _ = tx.send(f(main, MainThreadMarker::new_unchecked()));
            })
            .map_err(|e| format!("webview handle: {e}"))?;
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "the main thread didn't answer".to_string())
    }

    /// Take the throwaway window down. Safe to call whether or not one exists.
    fn teardown(app: &AppHandle) {
        let _ = on_main(app, |_, _| {
            JOB.with(|j| {
                if let Some(job) = j.borrow_mut().take() {
                    job.window.orderOut(None);
                    job.window.close();
                }
            });
        });
    }

    pub fn export(app: &AppHandle, req: &Request) -> Result<Exported, String> {
        let scale = validate(req)?;
        if BUSY.swap(true, Ordering::SeqCst) {
            return Err("another export is still running — wait for it to finish".into());
        }
        let result = run(app, req, scale);
        teardown(app);
        BUSY.store(false, Ordering::SeqCst);
        result
    }

    fn run(app: &AppHandle, req: &Request, scale: f64) -> Result<Exported, String> {
        let (w, h) = (req.width.round(), req.height.round());
        let html = wrapper_html(&req.url, w, h);

        // 1. The view: off-screen, invisible, artboard-sized, sharing the
        //    canvas's session.
        on_main(app, move |main, mtm| unsafe {
            let frame = NSRect::new(NSPoint::new(-40_000.0, -40_000.0), NSSize::new(w, h));
            let window = NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Borderless,
                NSBackingStoreType::Buffered,
                false,
            );
            // Retained owns it; AppKit releasing it on close as well would
            // free it twice.
            window.setReleasedWhenClosed(false);
            window.setIgnoresMouseEvents(true);
            window.setAlphaValue(0.0);

            let config = WKWebViewConfiguration::new(mtm);
            config.setWebsiteDataStore(&main.configuration().websiteDataStore());
            let web = WKWebView::initWithFrame_configuration(
                WKWebView::alloc(mtm),
                NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)),
                &config,
            );
            window.setContentView(Some(&web));
            // On the window list, or WebKit will not paint it — but at alpha
            // 0 and 40,000pt off-screen, so it is never seen.
            window.orderFrontRegardless();
            let base = NSURL::URLWithString(&NSString::from_str("http://localhost/"));
            let _ = web.loadHTMLString_baseURL(&NSString::from_str(&html), base.as_deref());
            JOB.with(|j| *j.borrow_mut() = Some(Job { window, web }));
        })?;

        // 2. Wait for the page — the wrapper's load waits for its iframe.
        let start = Instant::now();
        std::thread::sleep(Duration::from_millis(300));
        loop {
            let loading = on_main(app, |_, _| {
                JOB.with(|j| j.borrow().as_ref().map(|job| unsafe { job.web.isLoading() }))
            })?
            .ok_or("the export view went away")?;
            if !loading {
                break;
            }
            if start.elapsed() > LOAD_TIMEOUT {
                return Err(format!(
                    "the page didn't finish loading within {}s — is the dev server still running?",
                    LOAD_TIMEOUT.as_secs()
                ));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        std::thread::sleep(SETTLE);

        // 3. Capture.
        let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
        let format = req.format;
        on_main(app, move |_, mtm| {
            JOB.with(|j| {
                let guard = j.borrow();
                let Some(job) = guard.as_ref() else {
                    let _ = tx.send(Err("the export view went away".into()));
                    return;
                };
                unsafe {
                    match format {
                        Format::Png => {
                            let config = WKSnapshotConfiguration::new(mtm);
                            config.setRect(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(w, h)));
                            let pt = snapshot_width_pt(w, scale, job.window.backingScaleFactor());
                            config.setSnapshotWidth(Some(&NSNumber::new_f64(pt)));
                            let handler =
                                RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                                    let _ = tx.send(crate::thumbs::encode_png(image, error));
                                });
                            job.web
                                .takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
                        }
                        Format::Pdf => {
                            // No rect: the whole document, as one page.
                            let config = WKPDFConfiguration::new(mtm);
                            let handler = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                                let result = match (data.as_ref(), error.as_ref()) {
                                    (_, Some(err)) => Err(err.localizedDescription().to_string()),
                                    (Some(data), None) => Ok(data.to_vec()),
                                    (None, None) => Err("WebKit produced no PDF".into()),
                                };
                                let _ = tx.send(result);
                            });
                            job.web
                                .createPDFWithConfiguration_completionHandler(Some(&config), &handler);
                        }
                    }
                }
            });
        })?;
        let bytes = rx
            .recv_timeout(CAPTURE_TIMEOUT)
            .map_err(|_| "the capture took too long and was stopped".to_string())??;

        std::fs::write(&req.path, &bytes).map_err(|e| format!("couldn't write {}: {e}", req.path))?;
        let (width, height) = match req.format {
            Format::Png => ((w * scale).round() as u64, (h * scale).round() as u64),
            Format::Pdf => (w as u64, h as u64),
        };
        Ok(Exported {
            path: req.path.clone(),
            bytes: bytes.len() as u64,
            width,
            height,
        })
    }
}

#[cfg(target_os = "macos")]
pub use mac::export;

#[cfg(not(target_os = "macos"))]
pub fn export(_app: &tauri::AppHandle, _req: &Request) -> Result<Exported, String> {
    Err("artboard export is only implemented on macOS".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(format: Format, scale: Option<f64>, height: f64) -> Request {
        Request {
            url: "http://localhost:5173/pricing?__dedup_offline=1".into(),
            width: 1440.0,
            height,
            format,
            scale,
            path: "/tmp/x".into(),
        }
    }

    #[test]
    fn the_wrapper_frames_the_url_at_the_artboards_size_and_escapes_it() {
        let html = wrapper_html("http://localhost:5173/a?x=1&y=\"2\"<", 390.4, 844.6);
        assert!(html.contains("width:390px;height:845px"), "{html}");
        assert!(
            html.contains(r#"<iframe src="http://localhost:5173/a?x=1&amp;y=&quot;2&quot;&lt;"></iframe>"#),
            "the URL cannot break out of its attribute: {html}"
        );
    }

    #[test]
    fn the_snapshot_width_accounts_for_the_screens_own_scale() {
        // Retina: asking for the CSS width already gives 2x pixels.
        assert_eq!(snapshot_width_pt(1440.0, 2.0, 2.0), 1440.0);
        assert_eq!(snapshot_width_pt(1440.0, 1.0, 2.0), 720.0);
        assert_eq!(snapshot_width_pt(1440.0, 2.0, 1.0), 2880.0);
        assert_eq!(snapshot_width_pt(1440.0, 1.0, 0.0), 1440.0, "a missing scale is 1");
    }

    #[test]
    fn what_cannot_be_exported_is_refused_up_front() {
        assert_eq!(validate(&req(Format::Png, Some(2.0), 6400.0)).unwrap(), 2.0);
        assert_eq!(validate(&req(Format::Pdf, None, 6400.0)).unwrap(), 1.0);
        // Too tall for a PNG at 2x, and the message says what does work.
        let err = validate(&req(Format::Png, Some(2.0), 20_000.0)).unwrap_err();
        assert!(err.contains("1x") && err.contains("PDF"), "{err}");
        // …while the same page as a PDF is fine.
        assert!(validate(&req(Format::Pdf, None, 20_000.0)).is_ok());
        assert!(validate(&req(Format::Png, Some(8.0), 800.0)).is_err());
        assert!(validate(&req(Format::Png, None, f64::NAN)).is_err());
        let mut r = req(Format::Pdf, None, 800.0);
        r.url = "file:///etc/passwd".into();
        assert!(validate(&r).is_err(), "only the page's http URL");
        r.url = "http://localhost/".into();
        r.path = " ".into();
        assert!(validate(&r).is_err());
    }
}
