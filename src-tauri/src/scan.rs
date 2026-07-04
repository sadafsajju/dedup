//! Duplicate scan runner (FR-5.1/5.2). Spawns the scan sidecar, relays its
//! progress lines to the frontend as `scan://progress` events, and returns
//! the final JSON result line.

use crate::sidecar;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

const SCAN_BUNDLE: &str = include_str!("../assets/dedup-scan.mjs");

pub fn run(
    app: &AppHandle,
    root: &str,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let script = sidecar::ensure_named_bundle(root, "dedup-scan.mjs", SCAN_BUNDLE)?;
    let node = sidecar::find_node()?;

    let mut child = Command::new(node)
        .arg(&script)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start scan sidecar: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("scan sidecar stdin unavailable")?
        .write_all(
            serde_json::json!({ "cmd": "scan", "root": root, "files": files })
                .to_string()
                .as_bytes(),
        )
        .map_err(|e| format!("scan sidecar stdin write: {e}"))?;
    // stdin drops here — the sidecar sees EOF and starts scanning.

    let stdout = child.stdout.take().ok_or("scan sidecar stdout unavailable")?;
    let mut last: Option<serde_json::Value> = None;
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|e| format!("scan sidecar read: {e}"))?;
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue; // stray non-JSON output (e.g. a dependency warning)
        };
        if value.get("event").and_then(|e| e.as_str()) == Some("progress") {
            let _ = app.emit("scan://progress", &value);
        } else {
            last = Some(value);
        }
    }

    let status = child.wait().map_err(|e| format!("scan sidecar wait: {e}"))?;
    if !status.success() {
        return Err(format!("scan sidecar exited with {:?}", status.code()));
    }
    let result = last.ok_or_else(|| String::from("scan sidecar produced no result"))?;

    // Persist successful scans so reopening the project restores the last
    // gallery/clusters instead of demanding a rescan. Lives in
    // node_modules/.dedup (git-invisible, wiped only by a reinstall).
    if result.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        let _ = std::fs::write(saved_path(root), result.to_string());
    }
    Ok(result)
}

fn saved_path(root: &str) -> std::path::PathBuf {
    std::path::Path::new(root).join("node_modules/.dedup/scan-result.json")
}

/// The last persisted scan for this project, if any.
pub fn load_saved(root: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(saved_path(root)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    (value.get("ok").and_then(|v| v.as_bool()) == Some(true)).then_some(value)
}

fn categories_path(root: &str) -> std::path::PathBuf {
    std::path::Path::new(root).join("node_modules/.dedup/categories.json")
}

/// AI category assignments, cached per project so unchanged components are
/// never re-sent to the API.
pub fn load_categories(root: &str) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(categories_path(root)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_categories(root: &str, value: &serde_json::Value) -> Result<(), String> {
    let dir = std::path::Path::new(root).join("node_modules/.dedup");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .dedup dir: {e}"))?;
    std::fs::write(categories_path(root), value.to_string())
        .map_err(|e| format!("write categories: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_saved_roundtrip_and_rejects_garbage() {
        let root = std::env::temp_dir().join(format!("dedup-scan-{}", std::process::id()));
        std::fs::create_dir_all(root.join("node_modules/.dedup")).unwrap();
        let root_str = root.to_str().unwrap();

        assert!(load_saved(root_str).is_none()); // nothing saved yet

        std::fs::write(saved_path(root_str), r#"{"ok":true,"clusters":[]}"#).unwrap();
        assert_eq!(load_saved(root_str).unwrap()["ok"], true);

        std::fs::write(saved_path(root_str), "not json").unwrap();
        assert!(load_saved(root_str).is_none());

        std::fs::write(saved_path(root_str), r#"{"ok":false}"#).unwrap();
        assert!(load_saved(root_str).is_none());

        std::fs::remove_dir_all(&root).ok();
    }
}
