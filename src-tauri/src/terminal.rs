//! Interactive shells for the console drawer.
//!
//! The dev-server stream is dedup talking; a terminal is the user talking to
//! their own machine. So nothing here mediates: each terminal is the user's
//! login shell on a pseudo-terminal, started in the project root, and every
//! byte the user types goes to it unchanged. That is also why no AI path can
//! reach one — a shell is the most unaudited write path to the source there
//! is, and the chat agent's whole design is that it never gets one.
//!
//! A PTY rather than pipes because the programs people run in a terminal
//! (`git log`, `vim`, a test watcher, `npm init`'s prompts) ask `isatty` and
//! behave differently — or refuse — without one.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::toolpath;

pub const EVT_EXIT: &str = "terminal://exit";

/// How long a closed shell gets to act on SIGHUP before the group is killed.
const HANGUP_GRACE: Duration = Duration::from_millis(800);

#[derive(Serialize, Clone)]
pub struct ExitEvent {
    pub id: u32,
    pub code: Option<i32>,
}

#[derive(Serialize)]
pub struct Opened {
    pub id: u32,
    /// The shell's name (`zsh`), for the tab label.
    pub shell: String,
}

struct Session {
    writer: File,
    child: Child,
}

#[derive(Default)]
pub struct TerminalState {
    next: AtomicU32,
    open: Arc<Mutex<HashMap<u32, Session>>>,
}

/// A spawned shell on a fresh PTY. Kept separate from the Tauri plumbing so
/// the tests can drive a real one.
struct Spawned {
    master: File,
    child: Child,
}

fn spawn(program: &str, args: &[&str], cwd: &str, cols: u16, rows: u16) -> Result<Spawned, String> {
    let mut master_fd: libc::c_int = -1;
    let mut slave_fd: libc::c_int = -1;
    let mut size = winsize(cols, rows);
    // SAFETY: openpty writes two fds into the out-params; name and termios
    // are optional and passed as null.
    let rc = unsafe {
        libc::openpty(
            &mut master_fd,
            &mut slave_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if rc != 0 {
        return Err(format!("openpty: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: openpty succeeded, so both fds are open and ours alone.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master_fd), OwnedFd::from_raw_fd(slave_fd)) };
    // Neither end may leak into anything else dedup spawns: a dev server that
    // inherited a master would keep a closed terminal's tty alive, and the
    // shell would never see its hangup.
    cloexec(&master)?;
    cloexec(&slave)?;

    let slave = File::from(slave);
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
        .stdout(Stdio::from(slave.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(slave))
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("TERM_PROGRAM", "dedup");
    toolpath::apply(&mut cmd);
    // A Finder-launched app has no locale, and a shell without one draws
    // every non-ASCII character in a prompt as `?`.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    // SAFETY: only async-signal-safe calls between fork and exec. setsid makes
    // the shell a session leader (its pid is its pgid, so close can signal the
    // whole job), and TIOCSCTTY makes the PTY its controlling terminal — job
    // control and ^C both depend on it.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| format!("{program}: {e}"))?;
    // `cmd` (and with it the parent's copies of the slave) drops here, so the
    // child holds the only ones — the master reads EOF the moment it exits.
    Ok(Spawned { master: File::from(master), child })
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(1), ws_col: cols.max(1), ws_xpixel: 0, ws_ypixel: 0 }
}

fn cloexec(fd: &OwnedFd) -> Result<(), String> {
    // SAFETY: fcntl on an fd we own.
    let rc = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    if rc < 0 {
        return Err(format!("fcntl: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

/// The user's shell, as their terminal app would start it: a login shell, so
/// `.zprofile`/`.zshrc` run and nvm & co. are where they expect them.
fn user_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty() && toolpath::which(s).is_some())
        .unwrap_or_else(|| "/bin/zsh".into())
}

pub fn open(
    app: &AppHandle,
    state: &TerminalState,
    cwd: &str,
    cols: u16,
    rows: u16,
    output: Channel<InvokeResponseBody>,
) -> Result<Opened, String> {
    let shell = user_shell();
    let Spawned { master, child } = spawn(&shell, &["-l"], cwd, cols, rows)?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let mut reader = master.try_clone().map_err(|e| e.to_string())?;
    state
        .open
        .lock()
        .unwrap()
        .insert(id, Session { writer: master, child });

    let open = state.open.clone();
    let app = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                // macOS reports a hung-up PTY as EIO rather than EOF.
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if output.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                        break;
                    }
                }
            }
        }
        // Still registered means the shell ended on its own (`exit`, ^D);
        // otherwise `close` took it and does the reaping.
        let session = open.lock().unwrap().remove(&id);
        if let Some(mut s) = session {
            let code = s.child.wait().ok().and_then(|st| st.code());
            let _ = app.emit(EVT_EXIT, ExitEvent { id, code });
        }
    });

    let name = std::path::Path::new(&shell)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or(shell);
    Ok(Opened { id, shell: name })
}

pub fn write(state: &TerminalState, id: u32, data: &[u8]) -> Result<(), String> {
    let mut open = state.open.lock().unwrap();
    let s = open.get_mut(&id).ok_or("terminal is closed")?;
    s.writer.write_all(data).map_err(|e| e.to_string())
}

pub fn resize(state: &TerminalState, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let open = state.open.lock().unwrap();
    let s = open.get(&id).ok_or("terminal is closed")?;
    let size = winsize(cols, rows);
    // SAFETY: TIOCSWINSZ on the master we own; the kernel sends the
    // foreground job SIGWINCH.
    let rc = unsafe { libc::ioctl(s.writer.as_raw_fd(), libc::TIOCSWINSZ, &size) };
    if rc < 0 {
        return Err(format!("resize: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

pub fn close(state: &TerminalState, id: u32) {
    let session = state.open.lock().unwrap().remove(&id);
    if let Some(s) = session {
        hang_up(s);
    }
}

/// Every terminal, on leaving the project or quitting: a shell must never
/// outlive the window it was typed into.
pub fn close_all(state: &TerminalState) {
    let all: Vec<Session> = state.open.lock().unwrap().drain().map(|(_, s)| s).collect();
    for s in all {
        hang_up(s);
    }
}

/// What a terminal window does when it closes: SIGHUP to the shell's group,
/// then, if anything ignored it, SIGKILL. Reaped here so no zombie is left.
fn hang_up(s: Session) {
    let Session { writer, mut child } = s;
    let pgid = child.id() as i32;
    // SAFETY: signalling a process group we created.
    unsafe { libc::killpg(pgid, libc::SIGHUP) };
    drop(writer);
    thread::spawn(move || {
        let deadline = Instant::now() + HANGUP_GRACE;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            thread::sleep(Duration::from_millis(40));
        }
        // Not yet reaped, so the pgid cannot have been reused.
        unsafe { libc::killpg(pgid, libc::SIGKILL) };
        let _ = child.wait();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_until(master: &mut File, needle: &str) -> String {
        let mut out = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = master.read(&mut buf) {
            if n == 0 {
                break;
            }
            out.extend_from_slice(&buf[..n]);
            if String::from_utf8_lossy(&out).contains(needle) {
                break;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn the_child_sees_a_tty_of_the_requested_size() {
        let mut p = spawn("/bin/sh", &["-c", "test -t 0 && test -t 1 && echo TTY; stty size"], "/", 97, 31)
            .unwrap();
        let out = read_until(&mut p.master, "31 97");
        assert!(out.contains("TTY"), "{out}");
        assert!(out.contains("31 97"), "{out}");
        p.child.wait().unwrap();
    }

    #[test]
    fn starts_in_the_directory_it_was_given() {
        let dir = std::env::temp_dir().canonicalize().unwrap();
        let mut p = spawn("/bin/sh", &["-c", "pwd -P"], dir.to_str().unwrap(), 80, 24).unwrap();
        let out = read_until(&mut p.master, dir.to_str().unwrap());
        assert!(out.contains(dir.to_str().unwrap()), "{out}");
        p.child.wait().unwrap();
    }

    #[test]
    fn input_reaches_the_child_and_output_comes_back() {
        let mut p = spawn("/bin/sh", &["-c", "read line; echo got:$line"], "/", 80, 24).unwrap();
        p.master.write_all(b"hello\r").unwrap();
        let out = read_until(&mut p.master, "got:hello");
        assert!(out.contains("got:hello"), "{out}");
        p.child.wait().unwrap();
    }

    #[test]
    fn the_master_never_leaks_into_other_children() {
        let p = spawn("/bin/sh", &["-c", "sleep 5"], "/", 80, 24).unwrap();
        let flags = unsafe { libc::fcntl(p.master.as_raw_fd(), libc::F_GETFD) };
        assert!(flags & libc::FD_CLOEXEC != 0);
        let mut child = p.child;
        unsafe { libc::killpg(child.id() as i32, libc::SIGKILL) };
        child.wait().unwrap();
    }

    #[test]
    fn hanging_up_ends_the_whole_job() {
        // A shell that ignores SIGHUP, with a child of its own: the grace
        // period runs out and the group is killed, grandchild included.
        let mut p = spawn("/bin/sh", &["-c", "trap '' HUP; sleep 30 & echo PID:$!; wait"], "/", 80, 24)
            .unwrap();
        let out = read_until(&mut p.master, "\n");
        let pid: i32 = out
            .split("PID:")
            .nth(1)
            .and_then(|s| s.trim().parse().ok())
            .expect("pid line");
        let shell_pid = p.child.id() as i32;
        let (tx, rx) = std::sync::mpsc::channel();
        hang_up(Session { writer: p.master, child: p.child });
        thread::spawn(move || {
            // The shell is reaped by hang_up; its grandchild must be gone too.
            for _ in 0..100 {
                let alive = unsafe { libc::kill(pid, 0) } == 0;
                let shell_alive = unsafe { libc::kill(shell_pid, 0) } == 0;
                if !alive && !shell_alive {
                    let _ = tx.send(());
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
        });
        rx.recv_timeout(Duration::from_secs(6)).expect("job outlived its terminal");
    }
}
