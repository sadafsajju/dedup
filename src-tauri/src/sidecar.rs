//! One-shot Node sidecar runner for the write-back bundle (FR-4.1/4.2).
//! Spawns `node node_modules/.dedup/dedup-writeback.mjs` with a JSON request
//! on stdin and reads a JSON response from stdout.

use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const WRITEBACK_BUNDLE: &str = include_str!("../assets/dedup-writeback.mjs");

/// One operation in an edit program. The shape is validated on the JS side
/// (it owns the AST); Rust passes it through untouched so a new op type needs
/// no change here. Serde keeps it opaque on purpose.
pub type EditOp = serde_json::Value;

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

/// Node report for the element at ordinal `index` in `rel_file`: className
/// editability, live line/col, and which structural edits it admits.
pub fn inspect(root: &str, rel_file: &str, index: u32) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "inspect", "file": file, "index": index }))
}

/// Full-file replacement (AI chat edits) — the sidecar re-parses `content`
/// strictly and refuses anything that doesn't parse (PRD §safety).
pub fn write_file(root: &str, rel_file: &str, content: &str) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "writeFile", "file": file, "content": content }))
}

/// The project's page routes, read straight off the filesystem — react-router
/// path literals and Next's `app/`/`pages/` trees. Needs no dev server, which
/// is the point: Vite projects get this over HTTP from the tagger's
/// middleware, and a Next project has no middleware dedup can add.
pub fn routes(root: &str) -> Result<serde_json::Value, String> {
    run(root, json!({ "cmd": "routes", "root": root }))
}

/// Apply one file's edit program (class / text / insert / remove / move).
/// All ops resolve against a single parse and land as one write, or none of
/// them do — partial application of a program is never observable.
pub fn apply(root: &str, rel_file: &str, ops: &[EditOp]) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "apply", "file": file, "ops": ops }))
}

fn run(root: &str, request: serde_json::Value) -> Result<serde_json::Value, String> {
    let script = ensure_bundle(root)?;
    let node = find_node()?;

    let mut child = crate::toolpath::apply(&mut Command::new(node))
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
    crate::toolpath::which("node")
        .ok_or_else(|| "node not found — dedup needs Node.js to edit source files".into())
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

        // Ordinal 0 is the first JSX element in the file — no position needed.
        let ins = inspect(root_str, "App.tsx", 0).unwrap();
        assert_eq!(ins["ok"], true);
        assert_eq!(ins["editable"], true);
        assert_eq!(ins["className"], "p-4");
        assert_eq!(ins["line"], 1, "inspect reports the live position");
        assert_eq!(ins["core"], "root");
        assert_eq!(ins["canRemove"], false, "a component root is not removable");

        let res = apply(
            root_str,
            "App.tsx",
            &[json!({ "op": "class", "index": 0, "className": "p-6 flex" })],
        )
        .unwrap();
        assert_eq!(res["ok"], true, "write failed: {res}");
        let after = std::fs::read_to_string(root.join("App.tsx")).unwrap();
        assert!(after.contains("className=\"p-6 flex\""), "got: {after}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A structural program lands as one write, and a program with any
    /// refused op writes nothing at all (PRD §6: no partial application).
    #[test]
    fn edit_program_is_all_or_nothing() {
        let root = std::env::temp_dir().join(format!("dedup-scprog-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let before = concat!(
            "export function App() {\n",
            "  return (\n",
            "    <div>\n",
            "      <a className=\"one\">A</a>\n",
            "      <b className=\"two\">B</b>\n",
            "    </div>\n",
            "  );\n",
            "}\n"
        );
        std::fs::write(root.join("App.tsx"), before).unwrap();
        let root_str = root.to_str().unwrap();

        // <a> (#1) moves inside <b> (#2), and gets a class edit in the same
        // program — the edit must travel with the moved subtree.
        let ok = apply(
            root_str,
            "App.tsx",
            &[
                json!({ "op": "move", "index": 1, "target": 2, "position": "inside" }),
                json!({ "op": "class", "index": 1, "className": "one moved" }),
            ],
        )
        .unwrap();
        assert_eq!(ok["ok"], true, "program failed: {ok}");
        let after = std::fs::read_to_string(root.join("App.tsx")).unwrap();
        assert!(after.contains("<b className=\"two\">"), "got: {after}");
        assert!(after.contains("<a className=\"one moved\">A</a>"), "got: {after}");
        assert!(
            after.find("<a").unwrap() > after.find("<b").unwrap(),
            "the <a> should now live inside the <b>: {after}"
        );

        // A program containing one refused op writes nothing.
        let snapshot = after.clone();
        let refused = apply(
            root_str,
            "App.tsx",
            &[
                json!({ "op": "class", "index": 1, "className": "harmless" }),
                json!({ "op": "remove", "index": 0 }), // component root
            ],
        )
        .unwrap();
        assert_eq!(refused["ok"], false, "root removal must be refused");
        assert_eq!(std::fs::read_to_string(root.join("App.tsx")).unwrap(), snapshot);
        std::fs::remove_dir_all(&root).ok();
    }

    /// Next's file-based routes have to be reachable *through the sidecar*.
    /// The Vite plugin serves them over HTTP from inside the dev server, and
    /// a Next project has no middleware dedup can add — so if this path
    /// breaks, a Next project silently shows no pages at all.
    #[test]
    fn discovers_next_routes_without_a_dev_server() {
        let root = std::env::temp_dir().join(format!("dedup-scroutes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        for dir in [
            "app/(marketing)/about",
            "app/blog/[slug]",
            "app/dashboard/settings",
        ] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            "app/page.tsx",
            "app/(marketing)/about/page.tsx",
            "app/blog/[slug]/page.tsx",
            "app/dashboard/settings/page.tsx",
        ] {
            std::fs::write(root.join(file), "export default function P() { return null; }").unwrap();
        }

        let out = routes(root.to_str().unwrap()).unwrap();
        assert_eq!(out["ok"], true, "{out}");
        let mut found: Vec<String> = out["routes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap().to_string())
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec!["/", "/about", "/dashboard/settings"],
            "route groups collapse, dynamic segments are skipped (no value to put in [slug])"
        );
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
