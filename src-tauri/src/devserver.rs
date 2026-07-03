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
    /// HTTP→HTTPS canvas tunnel, kept alive for self-signed https servers.
    /// Dropped (and thereby shut down) together with the server slot.
    tunnel: Option<crate::proxy::Tunnel>,
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
    /// What the canvas should load (the tunnel URL when proxied).
    url: String,
    /// The dev server's own port.
    port: u16,
    /// True when `url` is a local tunnel in front of a self-signed https server.
    proxied: bool,
    /// The dev server's original URL when proxied.
    upstream_url: Option<String>,
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

/// How to launch the dev server.
pub enum ExecSpec {
    /// `<pm> run dev` in the project root.
    Script(PackageManager),
    /// User-supplied command through a shell (FR-1.3 escape hatch).
    Shell(String),
    /// Direct binary invocation — used for the instrumented Vite launch
    /// (`node_modules/.bin/vite … --config node_modules/.dedup/vite.config.mjs`).
    Direct {
        program: std::path::PathBuf,
        args: Vec<String>,
    },
}

/// Spawn the dev server according to `exec`.
pub fn start(
    app: &AppHandle,
    state: &DevServerState,
    root: &str,
    exec: ExecSpec,
) -> Result<(), String> {
    {
        let guard = state.0.lock().map_err(|_| "state lock poisoned")?;
        if guard.is_some() {
            return Err("A dev server is already running.".into());
        }
    }

    if matches!(exec, ExecSpec::Direct { .. }) {
        let _ = app.emit(
            EVT_LOG,
            LogEvent {
                stream: "stdout",
                line: "dedup: element tagging enabled (vite + dedup plugin)".into(),
            },
        );
    }

    let mut cmd = build_command(root, &exec);
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
            tunnel: None,
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
    kill_group(pgid, 1500);
    Ok(())
}

/// Last-resort teardown for app exit (⌘Q etc.), where no events are needed
/// and no window remains. Never leaves the user's dev server orphaned.
pub fn shutdown(state: &DevServerState) {
    let pgid = match state.0.lock() {
        Ok(mut guard) => match guard.take() {
            Some(s) => s.pgid,
            None => return,
        },
        Err(_) => return,
    };
    kill_group(pgid, 500);
}

fn kill_group(pgid: i32, grace_ms: u64) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(pgid, libc::SIGTERM);
        thread::sleep(std::time::Duration::from_millis(grace_ms));
        libc::killpg(pgid, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    {
        let _ = (pgid, grace_ms);
    }
}

pub fn is_running(state: &DevServerState) -> bool {
    state
        .0
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

fn build_command(root: &str, exec: &ExecSpec) -> Command {
    match exec {
        ExecSpec::Shell(cmd_str) => {
            let mut c = Command::new("/bin/sh");
            c.arg("-lc").arg(cmd_str).current_dir(root);
            c
        }
        ExecSpec::Direct { program, args } => {
            let mut c = Command::new(program);
            c.args(args).current_dir(root);
            c
        }
        ExecSpec::Script(pm) => {
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
    }
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

                                // Self-signed https can't render in the embedded
                                // canvas — front it with a plain-HTTP tunnel.
                                let mut canvas_url = url.clone();
                                let mut proxied = false;
                                let mut upstream_url = None;
                                if url.starts_with("https://") {
                                    match crate::proxy::start(port) {
                                        Ok(tunnel) => {
                                            let path = url
                                                .split_once(&format!("localhost:{port}"))
                                                .map(|(_, p)| p)
                                                .unwrap_or("");
                                            canvas_url = format!(
                                                "http://localhost:{}{}",
                                                tunnel.port, path
                                            );
                                            upstream_url = Some(url.clone());
                                            proxied = true;
                                            let _ = app.emit(
                                                EVT_LOG,
                                                LogEvent {
                                                    stream: "stdout",
                                                    line: format!(
                                                        "dedup: canvas tunnel {canvas_url} → {url} (self-signed https)"
                                                    ),
                                                },
                                            );
                                            server.tunnel = Some(tunnel);
                                        }
                                        Err(e) => {
                                            let _ = app.emit(
                                                EVT_LOG,
                                                LogEvent {
                                                    stream: "stderr",
                                                    line: format!(
                                                        "dedup: https tunnel failed ({e}) — canvas may not load"
                                                    ),
                                                },
                                            );
                                        }
                                    }
                                }

                                let _ = app.emit(
                                    EVT_READY,
                                    ReadyEvent {
                                        url: canvas_url,
                                        port,
                                        proxied,
                                        upstream_url,
                                    },
                                );
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

/// Remove ANSI escape sequences (CSI and OSC) so logs and URL parsing see
/// plain text. Operates on chars so multi-byte UTF-8 (Vite's `➜` arrows)
/// survives intact.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... final byte in @..~
            Some('[') => {
                chars.next();
                for c2 in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c2) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... terminated by BEL or ST (ESC \)
            Some(']') => {
                chars.next();
                while let Some(c2) = chars.next() {
                    if c2 == '\u{07}' {
                        break;
                    }
                    if c2 == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-char escape (ESC X): drop the next char.
            _ => {
                chars.next();
            }
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
    fn strip_ansi_preserves_utf8() {
        assert_eq!(strip_ansi("  ➜  Local:"), "  ➜  Local:");
    }

    #[test]
    fn extracts_https_url_from_basic_ssl_vite() {
        // Vite + @vitejs/plugin-basic-ssl serves over https (mintWash setup).
        assert_eq!(
            extract_local_url("  ➜  Local:   https://localhost:5174/"),
            Some(("https://localhost:5174".to_string(), 5174))
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

/// Pull the first `http(s)://<local host>:PORT` out of a log line — plain HTTP
/// and HTTPS (e.g. Vite with @vitejs/plugin-basic-ssl serves `https://`).
/// Returns a normalized (localhost, scheme-preserving) URL plus the port.
fn extract_local_url(line: &str) -> Option<(String, u16)> {
    const SCHEMES: [&str; 2] = ["http", "https"];
    const HOSTS: [&str; 4] = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"];
    for scheme in SCHEMES {
        for host in HOSTS {
            let prefix = format!("{scheme}://{host}:");
            let Some(idx) = line.find(&prefix) else {
                continue;
            };
            let rest = &line[idx + prefix.len()..];
            let port_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
            if port_str.is_empty() {
                continue;
            }
            let Ok(port) = port_str.parse::<u16>() else {
                continue;
            };
            // Grab any trailing path up to whitespace, normalize host to localhost.
            let after_port = &rest[port_str.len()..];
            let path: String = after_port
                .chars()
                .take_while(|c| !c.is_whitespace())
                .collect();
            let path = path.trim_end_matches('/');
            let url = format!("{scheme}://localhost:{port}{path}");
            return Some((url, port));
        }
    }
    None
}
