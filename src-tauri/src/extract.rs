//! Inline-drift runner (FR-5.10). Spawns the extract sidecar, relays its
//! progress lines to the frontend as `drift://progress` events, and returns
//! the final JSON result line.
//!
//! Deliberately a near-copy of `scan.rs` rather than a generalisation of it:
//! the two sidecars answer different questions, and the one thing they share
//! — "run a node bundle, relay progress, keep the last line" — is three lines
//! of plumbing. Merging them would couple two features that will drift apart
//! (this one grows a proposal command next; the scan will not).

use crate::sidecar;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

const EXTRACT_BUNDLE: &str = include_str!("../assets/dedup-extract.mjs");

pub fn run(
    app: &AppHandle,
    root: &str,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let script = sidecar::ensure_named_bundle(root, "dedup-extract.mjs", EXTRACT_BUNDLE)?;
    let node = sidecar::find_node()?;

    let mut child = crate::toolpath::apply(&mut Command::new(node))
        .arg(&script)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start extract sidecar: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("extract sidecar stdin unavailable")?
        .write_all(
            serde_json::json!({ "cmd": "extract", "root": root, "files": files })
                .to_string()
                .as_bytes(),
        )
        .map_err(|e| format!("extract sidecar stdin write: {e}"))?;
    // stdin drops here — the sidecar sees EOF and starts reading the project.

    let stdout = child
        .stdout
        .take()
        .ok_or("extract sidecar stdout unavailable")?;
    let mut last: Option<serde_json::Value> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| format!("extract sidecar read: {e}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue; // stray non-JSON output (e.g. a dependency warning)
        };
        if value.get("event").and_then(|e| e.as_str()) == Some("progress") {
            let _ = app.emit("drift://progress", &value);
        } else {
            last = Some(value);
        }
    }

    let status = child
        .wait()
        .map_err(|e| format!("extract sidecar wait: {e}"))?;
    if !status.success() {
        return Err(format!(
            "extract sidecar exited with {:?}",
            status.code()
        ));
    }
    let result = last.ok_or_else(|| String::from("extract sidecar produced no result"))?;

    if result.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        if let Some(path) = saved_path(root) {
            let _ = std::fs::create_dir_all(sidecar::support_dir(root));
            let _ = std::fs::write(path, result.to_string());
        }
    }
    Ok(result)
}

/// `support_dir` is the single answer to "where do dedup's files for this
/// project go" — `node_modules/.dedup` when there's a package.json, the app
/// cache dir otherwise. Never spell either out here.
fn saved_path(root: &str) -> Option<PathBuf> {
    Some(sidecar::support_dir(root).join("drift-result.json"))
}

/// The last persisted drift run for this project, if any.
pub fn load_saved(root: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(saved_path(root)?).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    (value.get("ok").and_then(|v| v.as_bool()) == Some(true)).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_saved_roundtrip_and_rejects_garbage() {
        let root = std::env::temp_dir().join(format!("dedup-drift-{}", std::process::id()));
        std::fs::create_dir_all(root.join("node_modules/.dedup")).unwrap();
        // A package.json is what puts support_dir inside the project.
        std::fs::write(root.join("package.json"), "{}").unwrap();
        let root_str = root.to_str().unwrap();

        assert!(load_saved(root_str).is_none()); // nothing saved yet

        let path = saved_path(root_str).unwrap();
        std::fs::write(&path, r#"{"ok":true,"candidates":[]}"#).unwrap();
        assert_eq!(load_saved(root_str).unwrap()["ok"], true);

        // A half-written or older-format file must read as "nothing saved",
        // never as a result the UI then tries to render.
        std::fs::write(&path, "not json").unwrap();
        assert!(load_saved(root_str).is_none());

        std::fs::write(&path, r#"{"ok":false,"error":"boom"}"#).unwrap();
        assert!(load_saved(root_str).is_none());

        std::fs::remove_dir_all(&root).ok();
    }
}
