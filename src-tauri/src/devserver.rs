//! Managed dev-server child process (FR-1.3, FR-1.6).
//!
//! We spawn the user's dev script in its own process group so we can reliably
//! tear down the whole tree (pnpm -> node -> esbuild ...) without orphaning a
//! server that keeps holding the port. stdout/stderr are streamed to the
//! frontend line-by-line as events; the first `http://localhost:PORT` we see
//! resolves the canvas URL.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

use crate::project::PackageManager;

/// Events emitted to the webview. Kept as string constants so the TS side can
/// import matching literals.
pub const EVT_LOG: &str = "devserver://log";
pub const EVT_READY: &str = "devserver://ready";
pub const EVT_EXIT: &str = "devserver://exit";
pub const EVT_STATUS: &str = "devserver://status";

#[derive(Default)]
pub struct DevServerState(pub Mutex<Option<RunningServer>>);

pub struct RunningServer {
    /// Process-group id == child pid (we spawn with `process_group(0)`).
    pgid: i32,
    /// Set once we've parsed the ready URL, so we only emit `ready` once.
    url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    stream: &'static str,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadyEvent {
    url: String,
    port: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitEvent {
    code: Option<i32>,
    /// True when we asked it to stop, so the UI can distinguish crash vs. stop.
    requested: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    status: &'static str,
}

/// Spawn the dev server. `custom_command`, when present, is run through a shell
/// (the escape hatch from FR-1.3); otherwise we run `<pm> run dev` in `root`.
pub fn start(
    app: &AppHandle,
    state: &DevServerState,
    root: &str,
    package_manager: PackageManager,
    custom_command: Option<String>,
) -> Result<(), String> {
    {
        let guard = state.0.lock().map_err(|_| "state lock poisoned")?;
        if guard.is_some() {
            return Err("A dev server is already running.".into());
        }
    }

    let mut cmd = build_command(root, package_manager, custom_command.as_deref());
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        // Keep colour out of the stream so URL parsing and the log drawer stay clean.
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("BROWSER", "none"); // stop CRA/Next from opening a system browser

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group rooted at the child, so killpg() reaches descendants.
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start dev server: {e}"))?;

    let pid = child.id() as i32;

    {
        let mut guard = state.0.lock().map_err(|_| "state lock poisoned")?;
        *guard = Some(RunningServer {
            pgid: pid,
            url: None,
        });
    }
    let _ = app.emit(EVT_STATUS, StatusEvent { status: "starting" });

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Some(out) = stdout {
        spawn_reader(app.clone(), out, "stdout");
    }
    if let Some(err) = stderr {
        spawn_reader(app.clone(), err, "stderr");
    }

    // Waiter thread: reap the child and report exit. Killing is done by signal
    // to the process group, so this thread owning `child` doesn't block stop().
    let app_wait = app.clone();
    thread::spawn(move || {
        let status = child.wait();
        let code = status.ok().and_then(|s| s.code());
        // stop() clears the state slot *before* killing, so if the slot is
        // still populated here the exit was unexpected (a crash).
        let mut requested = false;
        if let Some(st) = app_wait.try_state::<DevServerState>() {
            if let Ok(mut guard) = st.0.lock() {
                if guard.is_some() {
                    *guard = None; // crash — release the slot
                } else {
                    requested = true; // stop() already released it
                }
            }
        }
        let _ = app_wait.emit(EVT_EXIT, ExitEvent { code, requested });
        let _ = app_wait.emit(EVT_STATUS, StatusEvent { status: "stopped" });
    });

    Ok(())
}

/// Stop the running dev server (SIGTERM to the group, then SIGKILL as a
/// backstop). Idempotent — a no-op if nothing is running.
pub fn stop(app: &AppHandle, state: &DevServerState) -> Result<(), String> {
    let pgid = {
        let mut guard = state.0.lock().map_err(|_| "state lock poisoned")?;
        match guard.take() {
            Some(s) => s.pgid,
            None => return Ok(()),
        }
    };
    let _ = app.emit(EVT_STATUS, StatusEvent { status: "stopping" });

    #[cfg(unix)]
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
        // Give it a moment, then make sure it's gone.
        thread::sleep(std::time::Duration::from_millis(1500));
        libc::killpg(pgid, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = pgid;
    }
    Ok(())
}

pub fn is_running(state: &DevServerState) -> bool {
    state
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

fn build_command(root: &str, pm: PackageManager, custom: Option<&str>) -> Command {
    if let Some(cmd_str) = custom {
        let mut c = Command::new("/bin/sh");
        c.arg("-lc").arg(cmd_str).current_dir(root);
        return c;
    }
    let bin = match pm {
        PackageManager::Pnpm => "pnpm",
        PackageManager::Yarn => "yarn",
        PackageManager::Bun => "bun",
        PackageManager::Npm | PackageManager::Unknown => "npm",
    };
    // `run dev` works uniformly across pnpm/npm/bun; yarn allows `yarn dev`.
    let mut c = Command::new(bin);
    match pm {
        PackageManager::Yarn => {
            c.arg("dev");
        }
        _ => {
            c.arg("run").arg("dev");
        }
    }
    c.current_dir(root);
    c
}

fn spawn_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    reader: R,
    stream: &'static str,
) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            let raw = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let clean = strip_ansi(&raw);

            // Detect the ready URL once.
            if let Some((url, port)) = extract_local_url(&clean) {
                if let Some(st) = app.try_state::<DevServerState>() {
                    if let Ok(mut guard) = st.0.lock() {
                        if let Some(server) = guard.as_mut() {
                            if server.url.is_none() {
                                server.url = Some(url.clone());
                                let _ = app.emit(EVT_READY, ReadyEvent { url, port });
                            }
                        }
                    }
                }
            }

            let _ = app.emit(
                EVT_LOG,
                LogEvent {
                    stream,
                    line: clean,
                },
            );
        }
    });
}

/// Remove ANSI CSI escape sequences so logs and URL parsing see plain text.
fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == 0x1b {
            // ESC — skip until the sequence terminator.
            i += 1;
            if i < bytes.len() && bytes[i] == b'[' {
                i += 1;
                while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                    i += 1;
                }
                if i < bytes.len() {
                    i += 1; // consume the final byte
                }
            } else {
                // Non-CSI escape (e.g. ESC ] ...); skip the next byte.
                if i < bytes.len() {
                    i += 1;
                }
            }
        } else {
            out.push(bytes[i] as char);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_color_codes() {
        let input = "\u{1b}[32m  Local:\u{1b}[0m   \u{1b}[36mhttp://localhost:5173/\u{1b}[0m";
        let out = strip_ansi(input);
        assert!(out.contains("http://localhost:5173/"));
        assert!(!out.contains('\u{1b}'));
    }

    #[test]
    fn extracts_vite_local_url() {
        let line = strip_ansi("  ➜  Local:   http://localhost:5173/");
        assert_eq!(
            extract_local_url(&line),
            Some(("http://localhost:5173".to_string(), 5173))
        );
    }

    #[test]
    fn extracts_next_url_and_normalizes_host() {
        assert_eq!(
            extract_local_url("   - Local:        http://127.0.0.1:3000"),
            Some(("http://localhost:3000".to_string(), 3000))
        );
    }

    #[test]
    fn preserves_base_path() {
        assert_eq!(
            extract_local_url("Local: http://localhost:5173/my-app/ ready"),
            Some(("http://localhost:5173/my-app".to_string(), 5173))
        );
    }

    #[test]
    fn ignores_lines_without_a_url() {
        assert_eq!(extract_local_url("VITE v7.3.6  ready in 240 ms"), None);
        assert_eq!(extract_local_url("http://localhost:/oops"), None);
    }
}

/// Pull the first `http://<localhost|127.0.0.1|0.0.0.0>:PORT` out of a log line.
/// Returns a normalized (localhost) URL plus the port.
fn extract_local_url(line: &str) -> Option<(String, u16)> {
    const HOSTS: [&str; 3] = [
        "http://localhost:",
        "http://127.0.0.1:",
        "http://0.0.0.0:",
    ];
    for host in HOSTS {
        if let Some(idx) = line.find(host) {
            let rest = &line[idx + host.len()..];
            let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if port_str.is_empty() {
                continue;
            }
            let port: u16 = port_str.parse().ok()?;
            // Grab any trailing path up to whitespace, normalize host to localhost.
            let after_port = &rest[port_str.len()..];
            let path: String = after_port
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            let path = path.trim_end_matches('/');
            let url = format!("http://localhost:{port}{path}");
            return Some((url, port));
        }
    }
    None
}
