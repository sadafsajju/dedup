//! PATH resolution for GUI-launched builds.
//!
//! A macOS app bundle started from Finder/Dock inherits launchd's minimal
//! PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) — no homebrew, no nvm, no volta.
//! Everything dedup spawns needs more than that: the sidecars run `node`,
//! the dev server runs `pnpm`/`npm`, and every `node_modules/.bin/*` shim is
//! a `#!/usr/bin/env node` shebang that dies with exit 127 ("env: node: No
//! such file or directory") when node isn't on the child's PATH.
//!
//! So we build the PATH the user's own terminal would have — asked from
//! their login shell, then unioned with the inherited PATH and the usual
//! install locations — and hand it to every child we spawn.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

/// Never let a slow/misbehaving rc file stall the first project open.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// The enriched PATH, computed once per app run.
pub fn path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(build)
}

/// Give a child process the enriched PATH.
pub fn apply(cmd: &mut Command) -> &mut Command {
    cmd.env("PATH", path())
}

/// Resolve an executable against the enriched PATH, returning an absolute
/// path. `Command`'s own program lookup uses the *parent's* PATH on Unix, so
/// setting `PATH` on the child is not enough — the binary we name has to be
/// resolved by us.
pub fn which(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') {
        let p = PathBuf::from(bin);
        return is_exec(&p).then_some(p);
    }
    path()
        .split(':')
        .map(|dir| Path::new(dir).join(bin))
        .find(|p| is_exec(p))
}

#[cfg(unix)]
fn is_exec(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_exec(p: &Path) -> bool {
    p.is_file()
}

fn build() -> String {
    let mut dirs: Vec<String> = Vec::new();

    // The login shell's PATH first: it is what the user's terminal would use,
    // so version managers (nvm/fnm/asdf) pick the same node they'd get there.
    if let Some(p) = login_shell_path() {
        push_all(&mut dirs, &p);
    }
    // Whatever we inherited (correct already under `pnpm tauri dev`).
    if let Ok(p) = std::env::var("PATH") {
        push_all(&mut dirs, &p);
    }
    for d in fallback_dirs() {
        push(&mut dirs, &d);
    }

    dirs.join(":")
}

fn push_all(dirs: &mut Vec<String>, path_var: &str) {
    for d in path_var.split(':') {
        push(dirs, d);
    }
}

fn push(dirs: &mut Vec<String>, dir: &str) {
    let dir = dir.trim();
    if dir.is_empty() || dir.starts_with('~') || !Path::new(dir).is_dir() {
        return; // unexpanded tildes and dead entries only slow lookups down
    }
    if !dirs.iter().any(|d| d == dir) {
        dirs.push(dir.to_string());
    }
}

/// Ask the user's login shell what its PATH is. Interactive (`-i`) because
/// nvm and friends are sourced from `.zshrc`/`.bashrc`, which a
/// non-interactive shell never reads.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", "printf %s \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Bound the wait: an rc file that blocks must not block dedup.
    let (tx, rx) = mpsc::channel();
    let mut stdout = child.stdout.take()?;
    thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = match rx.recv_timeout(SHELL_PROBE_TIMEOUT) {
        Ok(buf) => buf,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();

    // `printf` emits no trailing newline, so the PATH is the last line —
    // anything an rc file printed before it stays on earlier lines.
    out.lines()
        .filter(|l| l.contains('/'))
        .next_back()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// Install locations to try even when the shell probe fails.
fn fallback_dirs() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut out = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    for rel in [
        ".volta/bin",
        ".bun/bin",
        "Library/pnpm",
        ".yarn/bin",
        ".npm-global/bin",
        ".local/bin",
        ".asdf/shims",
        ".local/share/fnm/aliases/default/bin",
    ] {
        if !home.is_empty() {
            out.push(format!("{home}/{rel}"));
        }
    }
    // nvm keeps one bin dir per installed version; offer them newest-first.
    if !home.is_empty() {
        if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
            let mut versions: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.join("bin/node").exists())
                .collect();
            versions.sort();
            for v in versions.into_iter().rev() {
                out.push(v.join("bin").to_string_lossy().into_owned());
            }
        }
    }
    out.extend(
        ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .into_iter()
            .map(String::from),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_contains_the_system_dirs_and_no_dead_entries() {
        let p = path();
        assert!(p.split(':').any(|d| d == "/usr/bin"), "got: {p}");
        for dir in p.split(':') {
            assert!(Path::new(dir).is_dir(), "dead PATH entry: {dir}");
            assert!(!dir.starts_with('~'), "unexpanded tilde: {dir}");
        }
    }

    #[test]
    fn which_finds_a_system_binary_and_rejects_nonsense() {
        assert_eq!(which("sh"), Some(PathBuf::from("/bin/sh")));
        assert!(which("dedup-definitely-not-a-binary").is_none());
    }

    #[test]
    fn which_resolves_node_for_child_processes() {
        // The whole point: a GUI-launched bundle must still find node.
        let node = which("node").expect("node should be resolvable");
        assert!(node.is_absolute(), "got: {}", node.display());
    }
}
