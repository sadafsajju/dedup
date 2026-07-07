//! One-shot Node sidecar runner for the write-back bundle (FR-4.1/4.2).
//! Spawns `node node_modules/.dedup/dedup-writeback.mjs` with a JSON request
//! on stdin and reads a JSON response from stdout.

use serde::Deserialize;
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const WRITEBACK_BUNDLE: &str = include_str!("../assets/dedup-writeback.mjs");

#[derive(Debug, Clone, Deserialize)]
pub struct ClassEdit {
    pub line: u32,
    pub col: u32,
    #[serde(rename = "className")]
    pub class_name: String,
}

/// Resolve a dedupId's relative file path against the project root, refusing
/// anything that escapes it.
pub fn resolve_in_root(root: &str, rel_file: &str) -> Result<PathBuf, String> {
    let root = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("bad project root: {e}"))?;
    let joined = root.join(rel_file);
    let canonical = joined
        .canonicalize()
        .map_err(|e| format!("cannot resolve {rel_file}: {e}"))?;
    if !canonical.starts_with(&root) {
        return Err(format!("{rel_file} is outside the project"));
    }
    Ok(canonical)
}

pub fn inspect(root: &str, rel_file: &str, line: u32, col: u32) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(
        root,
        json!({ "cmd": "inspect", "file": file, "line": line, "col": col }),
    )
}

/// Full-file replacement (AI chat edits) — the sidecar re-parses `content`
/// strictly and refuses anything that doesn't parse (PRD §safety).
pub fn write_file(root: &str, rel_file: &str, content: &str) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "writeFile", "file": file, "content": content }))
}

pub fn write(root: &str, rel_file: &str, edits: &[ClassEdit]) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    let edits: Vec<_> = edits
        .iter()
        .map(|e| json!({ "line": e.line, "col": e.col, "className": e.class_name }))
        .collect();
    run(root, json!({ "cmd": "write", "file": file, "edits": edits }))
}

fn run(root: &str, request: serde_json::Value) -> Result<serde_json::Value, String> {
    let script = ensure_bundle(root)?;
    let node = find_node()?;

    let mut child = Command::new(node)
        .arg(&script)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start node sidecar: {e}"))?;

    child
        .stdin
        .take()
        .ok_or("sidecar stdin unavailable")?
        .write_all(request.to_string().as_bytes())
        .map_err(|e| format!("sidecar stdin write: {e}"))?;

    let out = child
        .wait_with_output()
        .map_err(|e| format!("sidecar wait: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "sidecar exited with {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("bad sidecar response: {e}: {}", String::from_utf8_lossy(&out.stdout)))
}

fn ensure_bundle(root: &str) -> Result<PathBuf, String> {
    ensure_named_bundle(root, "dedup-writeback.mjs", WRITEBACK_BUNDLE)
}

/// Bundles live in node_modules/.dedup like the tagger; write one if the
/// project doesn't have this build yet.
pub fn ensure_named_bundle(root: &str, name: &str, content: &str) -> Result<PathBuf, String> {
    let dir = Path::new(root).join("node_modules/.dedup");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create .dedup dir: {e}"))?;
    let path = dir.join(name);
    let stale = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != content,
        Err(_) => true,
    };
    if stale {
        std::fs::write(&path, content).map_err(|e| format!("write sidecar: {e}"))?;
    }
    Ok(path)
}

/// `node` from PATH, with the usual macOS install locations as fallbacks
/// (GUI-launched apps get a minimal PATH).
pub fn find_node() -> Result<PathBuf, String> {
    if let Ok(out) = Command::new("node").arg("--version").output() {
        if out.status.success() {
            return Ok(PathBuf::from("node"));
        }
    }
    for candidate in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if Path::new(candidate).exists() {
            return Ok(PathBuf::from(candidate));
        }
    }
    Err("node not found — dedup needs Node.js to edit source files".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_escaping_the_project() {
        let root = std::env::temp_dir().join(format!("dedup-sc-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("inside.tsx"), "x").unwrap();
        let root_str = root.to_str().unwrap();

        assert!(resolve_in_root(root_str, "inside.tsx").is_ok());
        assert!(resolve_in_root(root_str, "../outside.tsx").is_err());
        assert!(resolve_in_root(root_str, "/etc/hosts").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn end_to_end_inspect_and_write_via_node() {
        // Requires node on PATH — true on any machine that can run dedup.
        let root = std::env::temp_dir().join(format!("dedup-sce2e-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("App.tsx"),
            "export const App = () => <div className=\"p-4\">x</div>;\n",
        )
        .unwrap();
        let root_str = root.to_str().unwrap();

        let ins = inspect(root_str, "App.tsx", 1, 25).unwrap();
        assert_eq!(ins["ok"], true);
        assert_eq!(ins["editable"], true);
        assert_eq!(ins["className"], "p-4");

        let res = write(
            root_str,
            "App.tsx",
            &[ClassEdit {
                line: 1,
                col: 25,
                class_name: "p-6 flex".into(),
            }],
        )
        .unwrap();
        assert_eq!(res["ok"], true, "write failed: {res}");
        let after = std::fs::read_to_string(root.join("App.tsx")).unwrap();
        assert!(after.contains("className=\"p-6 flex\""), "got: {after}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_file_gates_on_parse() {
        let root = std::env::temp_dir().join(format!("dedup-scwf-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let before = "export const App = () => <div>x</div>;\n";
        std::fs::write(root.join("App.tsx"), before).unwrap();
        let root_str = root.to_str().unwrap();

        let bad = write_file(root_str, "App.tsx", "export const App = () => <div>x</div;\n");
        let bad = bad.unwrap();
        assert_eq!(bad["ok"], false, "broken JSX must be refused: {bad}");
        assert_eq!(std::fs::read_to_string(root.join("App.tsx")).unwrap(), before);

        let good = "export const App = () => <div className=\"p-2\">y</div>;\n";
        let ok = write_file(root_str, "App.tsx", good).unwrap();
        assert_eq!(ok["ok"], true, "valid content must land: {ok}");
        assert_eq!(ok["changed"], true);
        assert_eq!(std::fs::read_to_string(root.join("App.tsx")).unwrap(), good);
        std::fs::remove_dir_all(&root).ok();
    }
}
