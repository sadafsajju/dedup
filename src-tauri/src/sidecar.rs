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

/// Where a file dedup is about to *create* would go.
///
/// `resolve_in_root` canonicalizes the file itself, so it can only ever name
/// something that already exists — right for every edit path, wrong for the
/// one place dedup writes a file that isn't there yet (the chat agent
/// extracting a component into its own module). This walks up to the nearest
/// existing ancestor, canonicalizes *that*, and checks the containment rule
/// against it, so a path escaping the project is refused for exactly the same
/// reason and by the same test.
pub fn resolve_new_in_root(root: &str, rel_file: &str) -> Result<PathBuf, String> {
    let root = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("bad project root: {e}"))?;
    let rel = Path::new(rel_file);
    if rel.is_absolute() {
        return Err(format!("{rel_file} must be a project-relative path"));
    }
    if rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(format!("{rel_file} is outside the project"));
    }
    let joined = root.join(rel);
    // Nearest existing ancestor: that is the deepest thing a symlink could
    // have redirected, so it is the thing worth canonicalizing.
    let mut existing = joined.as_path();
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let name = existing
            .file_name()
            .ok_or_else(|| format!("cannot resolve {rel_file}"))?;
        tail.push(name);
        existing = existing
            .parent()
            .ok_or_else(|| format!("cannot resolve {rel_file}"))?;
    }
    let mut out = existing
        .canonicalize()
        .map_err(|e| format!("cannot resolve {rel_file}: {e}"))?;
    if !out.starts_with(&root) {
        return Err(format!("{rel_file} is outside the project"));
    }
    for name in tail.iter().rev() {
        out.push(name);
    }
    Ok(out)
}

/// Node report for the element at ordinal `index` in `rel_file`: className
/// editability, live line/col, and which structural edits it admits.
pub fn inspect(root: &str, rel_file: &str, index: u32) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "inspect", "file": file, "index": index }))
}

/// The element at ordinal `index` in `rel_file`, verbatim, as a snippet the
/// insert op can take back — the read half of cut/copy/paste. Read-only.
pub fn copy(root: &str, rel_file: &str, index: u32) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "copy", "file": file, "index": index }))
}

/// Full-file replacement (AI chat edits) — the sidecar re-parses `content`
/// strictly and refuses anything that doesn't parse (PRD §safety).
pub fn write_file(root: &str, rel_file: &str, content: &str) -> Result<serde_json::Value, String> {
    let file = resolve_in_root(root, rel_file)?;
    run(root, json!({ "cmd": "writeFile", "file": file, "content": content }))
}

/// Replace several files at once — the chat agent's write path. Every file is
/// validated before any of them is written, so a multi-file edit that would
/// leave the project half-changed writes nothing. Paths that don't exist yet
/// are allowed here (and only here): the agent may create a file.
pub fn write_files(root: &str, files: &[(String, String)]) -> Result<serde_json::Value, String> {
    let mut payload = Vec::with_capacity(files.len());
    for (rel, content) in files {
        let abs = resolve_new_in_root(root, rel)?;
        payload.push(json!({ "file": abs, "rel": rel, "content": content }));
    }
    run(root, json!({ "cmd": "writeFiles", "files": payload }))
}

/// Put files back exactly as dedup found them — discarding a previewed chat
/// edit. `None` content means the file did not exist before and is removed.
/// Unlike every other write path this one is not content-gated, on purpose:
/// see `revertFiles` in the sidecar for why.
pub fn revert_files(
    root: &str,
    files: &[(String, Option<String>)],
) -> Result<serde_json::Value, String> {
    let mut payload = Vec::with_capacity(files.len());
    for (rel, content) in files {
        let abs = resolve_new_in_root(root, rel)?;
        payload.push(json!({ "file": abs, "rel": rel, "content": content }));
    }
    run(root, json!({ "cmd": "revertFiles", "files": payload }))
}

/// Every file the chat agent may look at, project-relative.
pub fn list_files(root: &str) -> Result<serde_json::Value, String> {
    run(root, json!({ "cmd": "listFiles", "root": root }))
}

/// Line matches for `pattern` across those same files.
pub fn grep(root: &str, pattern: &str) -> Result<serde_json::Value, String> {
    run(root, json!({ "cmd": "grep", "root": root, "pattern": pattern }))
}

/// The project's page routes, read straight off the filesystem — react-router
/// path literals and Next's `app/`/`pages/` trees. Needs no dev server, which
/// is the point: Vite projects get this over HTTP from the tagger's
/// middleware, and a Next project has no middleware dedup can add.
pub fn routes(root: &str, framework: &str) -> Result<serde_json::Value, String> {
    run(
        root,
        json!({ "cmd": "routes", "root": root, "framework": framework }),
    )
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

/// Where dedup keeps the bundles and generated files a project needs.
///
/// A node project gets `node_modules/.dedup`, chosen because it is
/// git-invisible by construction — that is the entire reason the convention
/// exists. A static site has no node_modules, and creating one purely to hide
/// files inside it would drop an untracked folder into the user's repo and
/// make dedup visible in their `git status`. So those projects keep their
/// support files outside the project altogether, under the app's cache
/// directory, keyed by the project path. Same guarantee, different address.
pub fn support_dir(root: &str) -> PathBuf {
    let root_path = Path::new(root);
    if root_path.join("package.json").exists() {
        return root_path.join("node_modules/.dedup");
    }
    // FNV-1a of the canonical path: short, stable, and collision-free enough
    // for "which folder is this" — it never has to be reversed.
    let key = root_path
        .canonicalize()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root.to_string());
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    let base = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join("Library/Caches/dedup"))
        .unwrap_or_else(|_| std::env::temp_dir().join("dedup"));
    base.join("projects").join(format!("{hash:016x}"))
}

/// Write one bundle into the project's support directory if it isn't already
/// there at this build.
pub fn ensure_named_bundle(root: &str, name: &str, content: &str) -> Result<PathBuf, String> {
    let dir = support_dir(root);
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
    fn new_file_paths_resolve_only_inside_the_project() {
        let root = std::env::temp_dir().join(format!("dedup-new-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        let root_str = root.to_str().unwrap();

        // A file that does not exist yet, in a directory that does.
        let ok = resolve_new_in_root(root_str, "src/Card.tsx").unwrap();
        assert!(ok.ends_with("src/Card.tsx"));
        // A directory that does not exist yet either.
        assert!(resolve_new_in_root(root_str, "src/ui/Card.tsx").is_ok());
        // The containment rule still holds for paths that never existed.
        assert!(resolve_new_in_root(root_str, "../escape.tsx").is_err());
        assert!(resolve_new_in_root(root_str, "src/../../escape.tsx").is_err());
        assert!(resolve_new_in_root(root_str, "/etc/newfile.tsx").is_err());
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

    /// Copy reads a section out of one file and paste writes it into another
    /// — the whole point of the gesture, and the path that has to survive the
    /// Rust boundary intact (the snippet is source text, newlines and all).
    #[test]
    fn copy_from_one_file_pastes_into_another() {
        let root = std::env::temp_dir().join(format!("dedup-sccopy-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("From.tsx"),
            "export const From = () => (\n  <div>\n    <section className=\"card\">\n      <h2>Title</h2>\n    </section>\n  </div>\n);\n",
        )
        .unwrap();
        std::fs::write(
            root.join("To.tsx"),
            "export const To = () => (\n  <main>\n    <p>here</p>\n  </main>\n);\n",
        )
        .unwrap();
        let root_str = root.to_str().unwrap();

        let copied = copy(root_str, "From.tsx", 1).unwrap();
        assert_eq!(copied["ok"], true, "{copied}");
        assert_eq!(copied["lang"], "jsx");
        assert_eq!(copied["tag"], "section");
        let snippet = copied["snippet"].as_str().unwrap().to_string();
        assert!(snippet.contains("<h2>Title</h2>"), "got: {snippet}");

        let res = apply(
            root_str,
            "To.tsx",
            &[json!({ "op": "insert", "target": 1, "position": "after", "snippet": snippet })],
        )
        .unwrap();
        assert_eq!(res["ok"], true, "paste failed: {res}");
        let after = std::fs::read_to_string(root.join("To.tsx")).unwrap();
        assert!(after.contains("<section className=\"card\">"), "got: {after}");
        // Re-indented for where it landed, not pasted at the depth it came from.
        assert!(after.contains("\n    <section"), "got: {after}");
        assert!(after.contains("\n      <h2>Title</h2>"), "got: {after}");

        // Nothing outside the project is copyable, same rule as every other path.
        assert!(copy(root_str, "../escape.tsx", 0).is_err());
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

        let out = routes(root.to_str().unwrap(), "next").unwrap();
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

    /// A static site's routes are its files. The framework comes from the
    /// caller, never from a guess inside the sidecar — a Next project's `app/`
    /// tree and a static site's `.html` files must not be able to answer for
    /// each other.
    #[test]
    fn discovers_static_routes_when_told_the_project_is_static() {
        let root = std::env::temp_dir().join(format!("dedup-staticroutes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("docs")).unwrap();
        for file in ["index.html", "about.html", "docs/index.html"] {
            std::fs::write(root.join(file), "<h1>x</h1>").unwrap();
        }

        let out = routes(root.to_str().unwrap(), "static").unwrap();
        let mut found: Vec<String> = out["routes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_str().unwrap().to_string())
            .collect();
        found.sort();
        assert_eq!(found, vec!["/", "/about.html", "/docs/"]);

        // The same folder read as an app project finds no pages to speak of.
        let app = routes(root.to_str().unwrap(), "app").unwrap();
        assert_eq!(app["routes"].as_array().unwrap().len(), 1, "{app}");
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

    /// The chat agent's write path. One bad file in the set must stop the
    /// whole set — a multi-file edit that half-lands (the new component
    /// written, its call site not) is a broken build the user didn't ask for.
    #[test]
    fn a_multi_file_write_lands_whole_or_not_at_all() {
        let root = std::env::temp_dir().join(format!("dedup-scmf-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        let before = "export const App = () => <div>x</div>;\n";
        std::fs::write(root.join("src/App.tsx"), before).unwrap();
        let root_str = root.to_str().unwrap();

        // App.tsx is fine, the new file is not. Nothing may be written.
        let bad = write_files(
            root_str,
            &[
                (
                    "src/App.tsx".into(),
                    "export const App = () => <Card />;\n".into(),
                ),
                ("src/Card.tsx".into(), "export const Card = () => <div;\n".into()),
            ],
        )
        .unwrap();
        assert_eq!(bad["ok"], false, "a broken file must stop the set: {bad}");
        assert_eq!(
            std::fs::read_to_string(root.join("src/App.tsx")).unwrap(),
            before,
            "the valid file in a refused set must be untouched",
        );
        assert!(!root.join("src/Card.tsx").exists());

        // Both good: both land, including the file that did not exist.
        let ok = write_files(
            root_str,
            &[
                (
                    "src/App.tsx".into(),
                    "export const App = () => <Card />;\n".into(),
                ),
                (
                    "src/Card.tsx".into(),
                    "export const Card = () => <div>c</div>;\n".into(),
                ),
            ],
        )
        .unwrap();
        assert_eq!(ok["ok"], true, "{ok}");
        assert!(root.join("src/Card.tsx").exists(), "a new file is created");
        assert_eq!(ok["changed"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    /// Preview-then-discard must leave the tree byte-identical, *including*
    /// a file that did not parse to begin with — the case where the user asked
    /// the agent for help in the first place.
    #[test]
    fn discarding_a_preview_restores_what_was_there() {
        let root = std::env::temp_dir().join(format!("dedup-scrv-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        let broken = "export const App = () => <div;\n";
        std::fs::write(root.join("src/App.tsx"), broken).unwrap();
        let root_str = root.to_str().unwrap();

        // Preview: fix the broken file and add a new one.
        let ok = write_files(
            root_str,
            &[
                (
                    "src/App.tsx".into(),
                    "export const App = () => <Card />;\n".into(),
                ),
                (
                    "src/Card.tsx".into(),
                    "export const Card = () => <div>c</div>;\n".into(),
                ),
            ],
        )
        .unwrap();
        assert_eq!(ok["ok"], true, "{ok}");

        // Discard: the broken original comes back and the new file goes away.
        let back = revert_files(
            root_str,
            &[
                ("src/App.tsx".into(), Some(broken.to_string())),
                ("src/Card.tsx".into(), None),
            ],
        )
        .unwrap();
        assert_eq!(back["ok"], true, "{back}");
        assert_eq!(
            std::fs::read_to_string(root.join("src/App.tsx")).unwrap(),
            broken,
            "content that never parsed must still be restorable",
        );
        assert!(!root.join("src/Card.tsx").exists());
        std::fs::remove_dir_all(&root).ok();
    }

    /// The agent's read-only tools. They are the only way it reaches the
    /// project, so "finds the file" and "finds the line" are the contract.
    #[test]
    fn the_agent_can_list_and_grep_the_project() {
        let root = std::env::temp_dir().join(format!("dedup-sctools-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/junk")).unwrap();
        std::fs::write(
            root.join("src/Login.tsx"),
            "export const Login = () => <form>useAuth</form>;\n",
        )
        .unwrap();
        std::fs::write(root.join("styles.css"), "body { color: red }\n").unwrap();
        std::fs::write(root.join("node_modules/junk/index.js"), "useAuth\n").unwrap();
        let root_str = root.to_str().unwrap();

        let listed = list_files(root_str).unwrap();
        let files: Vec<String> = listed["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect();
        assert!(files.contains(&"src/Login.tsx".to_string()), "{files:?}");
        assert!(files.contains(&"styles.css".to_string()), "stylesheets too");
        assert!(
            !files.iter().any(|f| f.contains("node_modules")),
            "the user's dependencies are not their project: {files:?}",
        );

        let hits = grep(root_str, "useAuth").unwrap();
        let matches = hits["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1, "{hits}");
        assert_eq!(matches[0]["file"], "src/Login.tsx");
        assert_eq!(matches[0]["line"], 1);
        std::fs::remove_dir_all(&root).ok();
    }
}
