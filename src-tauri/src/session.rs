//! Mock-session seed (zero-login editing). Protected routes in a client-side
//! app redirect to /login when there's no session, so the canvas can never
//! reach them. Rather than script a real login (brittle, provider-specific,
//! and it would mean storing the user's credentials) or fake the render (a
//! lie the user might then edit against), dedup lets the user install a small
//! *session seed* script: browser-storage writes that make the app's own
//! client guard consider itself authenticated, so the real page renders and
//! its visuals become editable.
//!
//! The seed is honest by construction:
//! - it lives in dedup's support directory for the project (the sanctioned
//!   injection point — the user's source and config are never touched), like
//!   the tagger and overlay assets;
//! - the tagger serves it only into framed canvas pages, so the user's own
//!   browsing of the dev server is untouched (see the framed gate in
//!   `dedup-session.js`);
//! - it only writes to `localStorage`/`sessionStorage`/`cookie` — it never
//!   mutates source or mocks the network, so what renders is the app's real
//!   authenticated shell, not an invented one. Server-validated data may
//!   still 401 (documented limitation): the shell renders, which is what the
//!   user is there to edit.
//!
//! The user reviews and can edit the script; it is opt-in (`enabled`), and
//! the editor badges the canvas while it is on.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Persisted per project at `<support_dir>/session.json` — the tagger reads
/// the same file at serve time (see the `dedup-session.js` middleware), and the
/// static server is handed its path on the command line. `support_dir` is
/// `node_modules/.dedup` for a node project and the app cache directory for a
/// static site, which has no node_modules to hide anything in.
#[derive(Serialize, Deserialize, Default)]
pub struct SessionSeed {
    pub enabled: bool,
    /// The user-reviewable script body (bare JS statements — the tagger wraps
    /// it in the framed gate before serving).
    pub script: String,
}

fn seed_path(root: &str) -> PathBuf {
    crate::sidecar::support_dir(root).join("session.json")
}

pub fn load(root: &str) -> Option<SessionSeed> {
    let text = std::fs::read_to_string(seed_path(root)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(root: &str, enabled: bool, script: &str) -> Result<(), String> {
    let path = seed_path(root);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create .dedup dir: {e}"))?;
    }
    let seed = SessionSeed {
        enabled,
        script: script.to_string(),
    };
    std::fs::write(
        &path,
        serde_json::to_string(&seed).map_err(|e| format!("serialize seed: {e}"))?,
    )
    .map_err(|e| format!("write session seed: {e}"))
}

/// One source file whose contents hint at how the app stores its auth session
/// — fed to the AI so it can write a matching seed.
#[derive(Serialize)]
pub struct AuthContextFile {
    pub path: String,
    pub snippet: String,
}

/// A managed auth SDK found in the project's dependencies, and whether a
/// storage seed can reach the session it keeps.
#[derive(Serialize)]
pub struct AuthProvider {
    pub name: String,
    /// Where that SDK actually persists the session — shown to the user.
    pub storage: String,
    /// False when a seed structurally cannot reach it (IndexedDB, httpOnly
    /// cookies, in-memory), which means "sign in for real" is the only path.
    pub seedable: bool,
}

/// What the seed generator gets to work with.
#[derive(Serialize)]
pub struct AuthContext {
    pub provider: Option<AuthProvider>,
    pub files: Vec<AuthContextFile>,
}

/// Identify the app's auth SDK from its dependencies. This matters because
/// the file scan below looks for storage calls *in the user's own source* —
/// and an app using a managed SDK never writes the session itself, so that
/// scan comes back empty no matter how much auth code exists. Knowing the
/// SDK is what turns "we found nothing" into a useful answer.
pub fn detect_auth_provider(root: &str) -> Option<AuthProvider> {
    let text = std::fs::read_to_string(Path::new(root).join("package.json")).ok()?;
    let pkg: serde_json::Value = serde_json::from_str(&text).ok()?;
    let mut names: Vec<String> = Vec::new();
    for field in ["dependencies", "devDependencies"] {
        if let Some(map) = pkg.get(field).and_then(|v| v.as_object()) {
            names.extend(map.keys().cloned());
        }
    }
    let has = |needle: &str| names.iter().any(|n| n.starts_with(needle));

    // Ordered by specificity: a Next app using NextAuth also has `next`.
    if has("@clerk/") {
        return Some(AuthProvider {
            name: "Clerk".into(),
            storage: "its own cookies and short-lived tokens".into(),
            seedable: false,
        });
    }
    if has("next-auth") || has("@auth/") {
        return Some(AuthProvider {
            name: "NextAuth".into(),
            storage: "an httpOnly session cookie set by the server".into(),
            seedable: false,
        });
    }
    if has("firebase") || has("@firebase/") {
        return Some(AuthProvider {
            name: "Firebase Auth".into(),
            storage: "IndexedDB (firebaseLocalStorageDb), written by the SDK".into(),
            seedable: false,
        });
    }
    if has("@supabase/") {
        return Some(AuthProvider {
            name: "Supabase Auth".into(),
            storage: "localStorage (an sb-…-auth-token key)".into(),
            seedable: true,
        });
    }
    if has("aws-amplify") || has("@aws-amplify/") {
        return Some(AuthProvider {
            name: "AWS Amplify".into(),
            storage: "localStorage (CognitoIdentityServiceProvider keys)".into(),
            seedable: true,
        });
    }
    if has("@auth0/") {
        return Some(AuthProvider {
            name: "Auth0".into(),
            storage: "in-memory by default; localStorage only with cacheLocation set".into(),
            seedable: false,
        });
    }
    None
}

/// Signals that a file touches auth/session storage. Deliberately broad on
/// the storage side (that's what a seed has to reproduce) and narrowed by
/// requiring an auth-ish word too, so a component that merely remembers a
/// theme in localStorage doesn't flood the context.
fn looks_auth_related(text: &str) -> bool {
    let storage = text.contains("localStorage")
        || text.contains("sessionStorage")
        || text.contains("document.cookie")
        || text.contains("Cookies.set")
        || text.contains("setCookie");
    if !storage {
        return false;
    }
    let lower = text.to_lowercase();
    ["auth", "token", "session", "login", "jwt", "user", "credential"]
        .iter()
        .any(|w| lower.contains(w))
}

/// The SDK in use plus any of the app's own session-storage code.
pub fn collect_auth_context(root: &str) -> AuthContext {
    AuthContext {
        provider: detect_auth_provider(root),
        files: collect_auth_files(root),
    }
}

/// Scan the project's source for files that read/write an auth session, and
/// return capped snippets. Same conservative walk as route discovery:
/// src-first, skips vendored/build dirs, bounded file count and snippet size
/// so a huge repo can't blow up the prompt.
fn collect_auth_files(root: &str) -> Vec<AuthContextFile> {
    const MAX_FILES: usize = 8;
    const MAX_SNIPPET: usize = 4000;
    const MAX_SCANNED: usize = 1200;

    let root_path = Path::new(root);
    let src = root_path.join("src");
    let mut stack = vec![if src.exists() { src } else { root_path.to_path_buf() }];
    let mut out: Vec<AuthContextFile> = Vec::new();
    let mut scanned = 0usize;

    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules" | "dist" | "build" | "coverage" | "public"
                )
            {
                continue;
            }
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let is_source = matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
            );
            if !is_source || scanned >= MAX_SCANNED {
                continue;
            }
            scanned += 1;
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            if !looks_auth_related(&text) {
                continue;
            }
            let rel = path
                .strip_prefix(root_path)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let snippet = if text.len() > MAX_SNIPPET {
                text.chars().take(MAX_SNIPPET).collect()
            } else {
                text
            };
            out.push(AuthContextFile { path: rel, snippet });
            if out.len() >= MAX_FILES {
                return out;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project(tag: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("dedup-session-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        dir
    }

    #[test]
    fn seed_round_trips_and_defaults_to_none() {
        let dir = temp_project("seed");
        let root = dir.to_str().unwrap();
        assert!(load(root).is_none());
        save(root, true, "localStorage.setItem('token','x')").unwrap();
        let got = load(root).unwrap();
        assert!(got.enabled);
        assert_eq!(got.script, "localStorage.setItem('token','x')");
        // Toggling off is persisted without losing the script.
        save(root, false, &got.script).unwrap();
        assert!(!load(root).unwrap().enabled);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn auth_context_picks_auth_storage_and_ignores_the_rest() {
        let dir = temp_project("ctx");
        let src = dir.join("src");
        // Auth-related: storage + an auth word.
        std::fs::write(
            src.join("auth.ts"),
            "export const save = (t) => localStorage.setItem('authToken', t);",
        )
        .unwrap();
        // Storage but no auth word — a theme toggle, must be ignored.
        std::fs::write(
            src.join("theme.ts"),
            "localStorage.setItem('theme', 'dark');",
        )
        .unwrap();
        // Auth word but no storage — a pure API call, must be ignored.
        std::fs::write(
            src.join("api.ts"),
            "export const login = () => fetch('/login');",
        )
        .unwrap();
        let ctx = collect_auth_files(dir.to_str().unwrap());
        let paths: Vec<&str> = ctx.iter().map(|c| c.path.as_str()).collect();
        assert_eq!(paths, vec!["src/auth.ts"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn detects_the_auth_sdk_and_whether_a_seed_can_reach_it() {
        let dir = temp_project("provider");
        let write_pkg = |deps: &str| {
            std::fs::write(
                dir.join("package.json"),
                format!(r#"{{"dependencies":{{{deps}}}}}"#),
            )
            .unwrap();
        };

        // The case that motivated this: an app whose SDK owns the session, so
        // the file scan finds nothing and a seed could never work anyway.
        write_pkg(r#""firebase":"^10.0.0","react":"^19.0.0""#);
        let fb = detect_auth_provider(dir.to_str().unwrap()).unwrap();
        assert_eq!(fb.name, "Firebase Auth");
        assert!(!fb.seedable, "Firebase keeps auth in IndexedDB");

        // Supabase does use localStorage, so a seed is a real option there.
        write_pkg(r#""@supabase/supabase-js":"^2.0.0""#);
        assert!(detect_auth_provider(dir.to_str().unwrap()).unwrap().seedable);

        // A Next app with NextAuth must not be read as plain Next.
        write_pkg(r#""next":"^15.0.0","next-auth":"^4.0.0""#);
        assert_eq!(
            detect_auth_provider(dir.to_str().unwrap()).unwrap().name,
            "NextAuth",
        );

        // No auth SDK at all — the app rolls its own, so the file scan leads.
        write_pkg(r#""react":"^19.0.0""#);
        assert!(detect_auth_provider(dir.to_str().unwrap()).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
