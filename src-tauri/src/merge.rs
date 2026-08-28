//! Guarded merge (FR-5.4 → FR-5.7): the Node codemod runner, the safety
//! gates a merge must clear, and the session history it commits into.
//!
//! The split is deliberate. The codemod (`assets/dedup-merge.mjs`) owns every
//! AST decision and refuses anything it can't do safely; this module owns the
//! things only the host can do — running the project's own typecheck and
//! build, and turning a failure into a rollback rather than a bug report.
//!
//! PRD §6 names the metric this file exists to protect: *zero* instances of a
//! merge landing that breaks the build. So a gate that cannot run is never
//! silently a pass — it reports `Skipped` with the reason, and the UI shows
//! that as the honest, weaker result it is.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MERGE_BUNDLE: &str = include_str!("../assets/dedup-merge.mjs");

/// A typecheck or build on a real codebase is minutes, not seconds — but it
/// must still end, or a hung script would freeze the merge forever.
const CHECK_TIMEOUT: Duration = Duration::from_secs(600);
/// Enough of the failing output to act on; the rest is noise in a panel.
const MAX_OUTPUT_BYTES: usize = 24_000;

// --- codemod sidecar ---------------------------------------------------------

fn run_sidecar(root: &str, request: serde_json::Value) -> Result<serde_json::Value, String> {
    let script = crate::sidecar::ensure_named_bundle(root, "dedup-merge.mjs", MERGE_BUNDLE)?;
    let node = crate::sidecar::find_node()?;

    let mut child = crate::toolpath::apply(&mut Command::new(node))
        .arg(&script)
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to start the merge sidecar: {e}"))?;

    // The plan request carries whole component sources and the apply request
    // carries a whole file — both can exceed the pipe buffer, so stdin gets
    // its own thread rather than deadlocking against a child already writing.
    let mut stdin = child.stdin.take().ok_or("merge sidecar stdin unavailable")?;
    let payload = request.to_string();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(payload.as_bytes());
    });

    let out = child
        .wait_with_output()
        .map_err(|e| format!("merge sidecar wait: {e}"))?;
    writer.join().ok();
    if !out.status.success() {
        return Err(format!(
            "merge sidecar exited with {:?}: {}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let last = text.trim().lines().last().unwrap_or("");
    serde_json::from_str(last)
        .map_err(|e| format!("bad merge sidecar response: {e}: {}", truncate(&text, 400)))
}

/// Read-only: everything a merge proposal is built from (FR-5.4).
pub fn plan(root: &str, members: Vec<MergeMember>) -> Result<serde_json::Value, String> {
    run_sidecar(root, json!({ "cmd": "plan", "root": root, "members": members }))
}

/// Compute (and, unless `dry_run`, write) the whole merge (FR-5.4, FR-5.5).
pub fn apply(
    root: &str,
    canonical: Canonical,
    mapping: Vec<MergeMapping>,
    dry_run: bool,
) -> Result<serde_json::Value, String> {
    if !dry_run {
        // The staging dir would otherwise appear in the user's `git status` as
        // untracked noise for as long as files sit in it.
        ignore_trash_dir(root);
    }
    run_sidecar(
        root,
        json!({
            "cmd": "apply",
            "root": root,
            "canonical": canonical,
            "mapping": mapping,
            "dryRun": dry_run,
        }),
    )
}

/// Hide `.dedup-trash/` from git via `.git/info/exclude` — repo-local
/// metadata, not the user's `.gitignore`. The standing convention is that
/// dedup does not edit the user's files for its own convenience, and an
/// ignore rule they would have to review, commit and later remove is exactly
/// that; `info/exclude` is neither committed nor shared, so it is the right
/// place for a rule about dedup's own scratch directory.
///
/// Best-effort by design: failing to write it is untidy, never incorrect.
fn ignore_trash_dir(root: &str) {
    let exclude = Path::new(root).join(".git/info/exclude");
    let Some(dir) = exclude.parent() else { return };
    if !dir.exists() && std::fs::create_dir_all(dir).is_err() {
        return; // not a git repo, or not writable — the merge itself is fine
    }
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == ".dedup-trash/") {
        return;
    }
    let mut next = current;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str("# dedup: files staged for deletion by a merge, pending confirmation\n.dedup-trash/\n");
    let _ = std::fs::write(&exclude, next);
}

pub fn trash(root: &str, action: &str, files: Option<Vec<String>>) -> Result<serde_json::Value, String> {
    let cmd = match action {
        "list" => "listTrash",
        "restore" => "restoreTrash",
        "empty" => "emptyTrash",
        other => return Err(format!("unknown trash action: {other}")),
    };
    run_sidecar(root, json!({ "cmd": cmd, "root": root, "files": files }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeMember {
    pub file: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Canonical {
    pub name: String,
    pub file: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeMapping {
    pub file: String,
    pub name: String,
    /// Props the canonical component needs to reproduce this member — the
    /// value shape is validated in the codemod, which owns what may be written.
    #[serde(default)]
    pub props: serde_json::Value,
}

// --- safety gates (FR-5.6) ---------------------------------------------------

/// A gate has three outcomes, and "couldn't run" is emphatically not "passed".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// "typecheck" | "build"
    pub kind: String,
    pub status: CheckStatus,
    /// The command actually run, so the user can reproduce it in a terminal.
    pub command: String,
    pub output: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Passed,
    Failed,
    /// Nothing in the project can answer this question — say so out loud.
    Skipped,
}

#[derive(Debug, Deserialize, Default)]
struct PackageScripts {
    #[serde(default)]
    scripts: std::collections::HashMap<String, String>,
}

fn scripts_of(root: &str) -> PackageScripts {
    std::fs::read_to_string(Path::new(root).join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn package_manager_bin(root: &str) -> &'static str {
    let root = Path::new(root);
    if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        "bun"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else {
        "npm"
    }
}

/// The project's own typecheck, in the order a developer would reach for it:
/// a script they already wrote, else the TypeScript they already installed.
/// A JS project has no typecheck to run, and that is reported, not faked.
fn typecheck_command(root: &str) -> Option<(String, Vec<String>, String)> {
    let scripts = scripts_of(root);
    let pm = package_manager_bin(root);
    for name in ["typecheck", "type-check", "tsc", "check-types", "lint:types"] {
        if scripts.scripts.contains_key(name) {
            return Some((
                pm.to_string(),
                vec!["run".into(), name.into()],
                format!("{pm} run {name}"),
            ));
        }
    }
    let tsc = Path::new(root).join("node_modules/.bin/tsc");
    if tsc.exists() && Path::new(root).join("tsconfig.json").exists() {
        return Some((
            tsc.display().to_string(),
            vec!["--noEmit".into()],
            "tsc --noEmit".to_string(),
        ));
    }
    None
}

fn build_command(root: &str) -> Option<(String, Vec<String>, String)> {
    let scripts = scripts_of(root);
    let pm = package_manager_bin(root);
    for name in ["build", "compile"] {
        if scripts.scripts.contains_key(name) {
            return Some((
                pm.to_string(),
                vec!["run".into(), name.into()],
                format!("{pm} run {name}"),
            ));
        }
    }
    None
}

/// Run one gate. `kind` is "typecheck" or "build".
pub fn run_check(root: &str, kind: &str) -> Result<CheckResult, String> {
    let started = Instant::now();
    let resolved = match kind {
        "typecheck" => typecheck_command(root),
        "build" => build_command(root),
        other => return Err(format!("unknown check: {other}")),
    };
    let Some((program, args, display)) = resolved else {
        let reason = if kind == "typecheck" {
            "no typecheck script and no local tsc — this project has no type gate to run"
        } else {
            "no build script in package.json"
        };
        return Ok(CheckResult {
            kind: kind.to_string(),
            status: CheckStatus::Skipped,
            command: String::new(),
            output: reason.to_string(),
            duration_ms: started.elapsed().as_millis() as u64,
        });
    };

    let (ok, output) = run_captured(root, &program, &args)?;
    Ok(CheckResult {
        kind: kind.to_string(),
        status: if ok { CheckStatus::Passed } else { CheckStatus::Failed },
        command: display,
        output: truncate(&output, MAX_OUTPUT_BYTES),
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

/// Spawn, drain both pipes on threads, and kill on the deadline. Returns
/// (succeeded, combined output).
fn run_captured(root: &str, program: &str, args: &[String]) -> Result<(bool, String), String> {
    let mut cmd = Command::new(program);
    crate::toolpath::apply(&mut cmd);
    let mut child = cmd
        .args(args)
        .current_dir(root)
        // Some toolchains colour their output when they think a TTY is there;
        // these strings are read by a human in a panel, not a terminal.
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("CI", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run {program}: {e}"))?;

    let mut stdout_pipe = child.stdout.take().ok_or("check stdout unavailable")?;
    let out_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout_pipe.read_to_string(&mut buf);
        buf
    });
    let mut stderr_pipe = child.stderr.take().ok_or("check stderr unavailable")?;
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr_pipe.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + CHECK_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                child.kill().ok();
                child.wait().ok();
                return Ok((
                    false,
                    format!(
                        "{program} ran longer than {}s and was stopped",
                        CHECK_TIMEOUT.as_secs()
                    ),
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(format!("check wait: {e}")),
        }
    };

    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    let mut combined = String::new();
    combined.push_str(stdout.trim_end());
    if !stderr.trim().is_empty() {
        if !combined.is_empty() {
            combined.push('\n');
        }
        combined.push_str(stderr.trim_end());
    }
    Ok((status.success(), combined))
}

/// Keep the tail of long tool output — the error is at the end, not the start.
fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let start = text.len() - max;
    // Don't slice through a multi-byte character.
    let start = (start..text.len())
        .find(|i| text.is_char_boundary(*i))
        .unwrap_or(text.len());
    format!("…(earlier output trimmed)…\n{}", &text[start..])
}

// --- session history (FR-5.7) ------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub hash: String,
    pub subject: String,
    pub when: String,
    pub files: Vec<String>,
    /// True for the merge commits — the ones with an interesting revert.
    pub is_merge: bool,
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&"?"),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Everything dedup has committed on this session branch, newest first —
/// the panel a merge is reverted from (FR-5.7).
pub fn history(root: &str, limit: u32) -> Result<Vec<HistoryEntry>, String> {
    // Only this branch's own commits: everything since it left the trunk.
    let log = git(
        root,
        &[
            "log",
            &format!("-{limit}"),
            "--first-parent",
            "--pretty=format:%h\u{1f}%s\u{1f}%cr",
        ],
    )?;

    let mut entries = Vec::new();
    for line in log.lines() {
        let mut parts = line.split('\u{1f}');
        let hash = parts.next().unwrap_or_default().to_string();
        let subject = parts.next().unwrap_or_default().to_string();
        let when = parts.next().unwrap_or_default().to_string();
        if hash.is_empty() || !subject.starts_with("dedup:") {
            // A commit dedup did not make is not dedup's to offer a revert for.
            continue;
        }
        let files = git(root, &["show", "--name-only", "--pretty=format:", &hash])
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(str::to_string)
            .collect();
        entries.push(HistoryEntry {
            is_merge: subject.starts_with("dedup: merge "),
            hash,
            subject,
            when,
            files,
        });
    }
    Ok(entries)
}

/// Undo one dedup commit by restoring exactly the paths it touched to their
/// state just before it, then committing that (FR-5.6 rollback, FR-5.7).
///
/// Deliberately not `git revert`: that demands a clean tree and would refuse
/// (or worse, involve) the user's own in-flight work. Restoring only the
/// commit's own paths keeps dedup's blast radius to dedup's own files, which
/// is the same promise every save on this branch already makes.
pub fn revert(root: &str, hash: &str) -> Result<String, String> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid commit hash".into());
    }
    let subject = git(root, &["log", "-1", "--pretty=format:%s", hash])?;
    if !subject.starts_with("dedup:") {
        return Err(format!(
            "{hash} is not a dedup commit — revert it with your own git tools"
        ));
    }
    let files: Vec<String> = git(root, &["show", "--name-only", "--pretty=format:", hash])?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    if files.is_empty() {
        return Err("that commit touched no files".into());
    }

    let parent = format!("{hash}~1");
    for file in &files {
        // A file the commit created has no parent version — deleting it is
        // the correct inverse, and `checkout` can't express that.
        let existed = Command::new("git")
            .args(["-C", root, "cat-file", "-e", &format!("{parent}:{file}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if existed {
            git(root, &["checkout", &parent, "--", file])?;
        } else {
            let path = Path::new(root).join(file);
            if path.exists() {
                std::fs::remove_file(&path).map_err(|e| format!("remove {file}: {e}"))?;
            }
            git(root, &["rm", "--cached", "--ignore-unmatch", "-q", "--", file]).ok();
        }
    }

    let message = format!("dedup: undo {hash} ({})", subject.trim_start_matches("dedup: "));
    let mut args: Vec<&str> = vec!["commit", "-m", &message, "--"];
    args.extend(files.iter().map(String::as_str));
    git(root, &args)?;
    git(root, &["rev-parse", "--short", "HEAD"])
}

/// Absolute path of the merge bundle, for tests that want to run it directly.
#[allow(dead_code)]
pub fn bundle_path(root: &str) -> Result<PathBuf, String> {
    crate::sidecar::ensure_named_bundle(root, "dedup-merge.mjs", MERGE_BUNDLE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dedup-merge-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, content: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    const CARD: &str = "export function Card({ title }) {\n  return <div className=\"p-4 border\">{title}</div>;\n}\n";
    const PRODUCT: &str = "export function ProductCard({ title }) {\n  return <div className=\"p-6 border\">{title}</div>;\n}\n";
    const HOME: &str = "import { Card } from \"./Card\";\nimport { ProductCard } from \"./ProductCard\";\n\nexport function Home() {\n  return <main><Card title=\"a\" /><ProductCard title=\"b\" /></main>;\n}\n";
    const CANONICAL: &str = "export function Card({ title, variant = \"default\" }) {\n  return <div className={variant === \"product\" ? \"p-6 border\" : \"p-4 border\"}>{title}</div>;\n}\n";

    fn fixture(tag: &str) -> PathBuf {
        let dir = temp_dir(tag);
        write(&dir, "src/Card.tsx", CARD);
        write(&dir, "src/ProductCard.tsx", PRODUCT);
        write(&dir, "src/Home.tsx", HOME);
        dir
    }

    fn members() -> Vec<MergeMember> {
        vec![
            MergeMember { file: "src/Card.tsx".into(), name: "Card".into() },
            MergeMember { file: "src/ProductCard.tsx".into(), name: "ProductCard".into() },
        ]
    }

    fn mapping() -> Vec<MergeMapping> {
        vec![
            MergeMapping {
                file: "src/Card.tsx".into(),
                name: "Card".into(),
                props: json!({}),
            },
            MergeMapping {
                file: "src/ProductCard.tsx".into(),
                name: "ProductCard".into(),
                props: json!({ "variant": "product" }),
            },
        ]
    }

    /// The sidecar really runs through node from Rust, and really rewrites.
    #[test]
    fn plans_and_applies_a_merge_through_the_sidecar() {
        let dir = fixture("e2e");
        let root = dir.to_str().unwrap();

        let planned = plan(root, members()).unwrap();
        assert_eq!(planned["ok"], true, "plan failed: {planned}");
        assert_eq!(planned["callSites"].as_array().unwrap().len(), 2);

        let canonical = Canonical {
            name: "Card".into(),
            file: "src/Card.tsx".into(),
            source: CANONICAL.into(),
        };

        // Dry run writes nothing.
        let preview = apply(root, canonical.clone(), mapping(), true).unwrap();
        assert_eq!(preview["ok"], true, "dry run failed: {preview}");
        assert!(dir.join("src/ProductCard.tsx").exists());

        let applied = apply(root, canonical, mapping(), false).unwrap();
        assert_eq!(applied["ok"], true, "apply failed: {applied}");
        let home = std::fs::read_to_string(dir.join("src/Home.tsx")).unwrap();
        assert!(home.contains("variant=\"product\""), "{home}");
        assert!(!home.contains("ProductCard"), "{home}");
        assert!(!dir.join("src/ProductCard.tsx").exists());
        assert!(dir.join(".dedup-trash/src/ProductCard.tsx").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn staging_dir_is_hidden_from_git_without_touching_gitignore() {
        let dir = fixture("ignore");
        let root = dir.to_str().unwrap();
        std::fs::create_dir_all(dir.join(".git/info")).unwrap();
        std::fs::write(dir.join(".git/info/exclude"), "# theirs\n*.log").unwrap();

        apply(
            root,
            Canonical {
                name: "Card".into(),
                file: "src/Card.tsx".into(),
                source: CANONICAL.into(),
            },
            mapping(),
            false,
        )
        .unwrap();

        let exclude = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert!(exclude.contains("*.log"), "their own rules must survive: {exclude}");
        assert!(exclude.contains(".dedup-trash/"), "{exclude}");
        assert!(!dir.join(".gitignore").exists(), "the user's .gitignore is not ours to edit");

        // Twice must not duplicate the rule.
        ignore_trash_dir(root);
        let again = std::fs::read_to_string(dir.join(".git/info/exclude")).unwrap();
        assert_eq!(again.matches(".dedup-trash/").count(), 1, "{again}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn trash_lists_restores_and_empties() {
        let dir = fixture("trash");
        let root = dir.to_str().unwrap();
        apply(
            root,
            Canonical {
                name: "Card".into(),
                file: "src/Card.tsx".into(),
                source: CANONICAL.into(),
            },
            mapping(),
            false,
        )
        .unwrap();

        let listed = trash(root, "list", None).unwrap();
        assert_eq!(listed["files"].as_array().unwrap().len(), 1);
        let restored = trash(root, "restore", None).unwrap();
        assert_eq!(restored["restored"][0], "src/ProductCard.tsx");
        assert!(dir.join("src/ProductCard.tsx").exists());
        let emptied = trash(root, "empty", None).unwrap();
        assert_eq!(emptied["ok"], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// "No typecheck available" must never masquerade as a pass.
    #[test]
    fn a_missing_gate_is_skipped_not_passed() {
        let dir = temp_dir("nogate");
        std::fs::write(dir.join("package.json"), r#"{"scripts":{}}"#).unwrap();
        let result = run_check(dir.to_str().unwrap(), "typecheck").unwrap();
        assert_eq!(result.status, CheckStatus::Skipped);
        assert!(result.output.contains("no typecheck"), "{}", result.output);

        let build = run_check(dir.to_str().unwrap(), "build").unwrap();
        assert_eq!(build.status, CheckStatus::Skipped);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A failing script fails the gate and keeps its output for the report.
    #[test]
    fn a_failing_script_fails_the_gate_with_its_output() {
        let dir = temp_dir("failgate");
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"build":"node -e \"console.error('TS2322: nope'); process.exit(1)\""}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
        let result = run_check(dir.to_str().unwrap(), "build").unwrap();
        assert_eq!(result.status, CheckStatus::Failed);
        assert!(result.output.contains("TS2322"), "{}", result.output);
        assert_eq!(result.command, "npm run build");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_passing_script_passes_the_gate() {
        let dir = temp_dir("passgate");
        std::fs::write(
            dir.join("package.json"),
            r#"{"scripts":{"typecheck":"node -e \"process.exit(0)\""}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("package-lock.json"), "{}").unwrap();
        let result = run_check(dir.to_str().unwrap(), "typecheck").unwrap();
        assert_eq!(result.status, CheckStatus::Passed, "{}", result.output);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn truncate_keeps_the_tail_where_the_error_is() {
        let text = format!("{}\nTS2322: the actual error", "noise\n".repeat(500));
        let out = truncate(&text, 100);
        assert!(out.contains("TS2322"));
        assert!(out.starts_with("…(earlier output trimmed)…"));
        assert!(out.len() < 200);
    }

    // --- history / revert ----------------------------------------------------

    fn git_t(root: &str, args: &[&str]) {
        let out = Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo(tag: &str) -> PathBuf {
        let dir = temp_dir(tag);
        let root = dir.to_str().unwrap();
        git_t(root, &["init", "-q", "-b", "main"]);
        git_t(root, &["config", "user.email", "t@t"]);
        git_t(root, &["config", "user.name", "t"]);
        dir
    }

    #[test]
    fn history_lists_dedup_commits_only() {
        let dir = repo("history");
        let root = dir.to_str().unwrap();
        write(&dir, "a.tsx", "a");
        git_t(root, &["add", "-A"]);
        git_t(root, &["commit", "-qm", "user: initial"]);
        write(&dir, "a.tsx", "a2");
        git_t(root, &["commit", "-qam", "dedup: adjust padding on Card"]);
        write(&dir, "a.tsx", "a3");
        git_t(root, &["commit", "-qam", "dedup: merge Card, ProductCard → Card"]);

        let entries = history(root, 20).unwrap();
        assert_eq!(entries.len(), 2, "{entries:?}");
        assert!(entries[0].is_merge);
        assert!(!entries[1].is_merge);
        assert_eq!(entries[0].files, vec!["a.tsx".to_string()]);
        assert!(entries.iter().all(|e| e.subject.starts_with("dedup:")));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The rollback restores the commit's paths — including files it deleted —
    /// and leaves the user's unrelated work exactly where it was.
    #[test]
    fn revert_restores_only_the_commits_own_paths() {
        let dir = repo("revert");
        let root = dir.to_str().unwrap();
        write(&dir, "Card.tsx", "old card");
        write(&dir, "ProductCard.tsx", "old product");
        write(&dir, "mine.txt", "committed");
        git_t(root, &["add", "-A"]);
        git_t(root, &["commit", "-qm", "user: initial"]);

        // A merge: Card rewritten, ProductCard deleted.
        std::fs::write(dir.join("Card.tsx"), "merged card").unwrap();
        std::fs::remove_file(dir.join("ProductCard.tsx")).unwrap();
        git_t(root, &["add", "-A"]);
        git_t(root, &["commit", "-qm", "dedup: merge Card, ProductCard → Card"]);
        let hash = git(root, &["rev-parse", "--short", "HEAD"]).unwrap();

        // The user has since edited something of their own, uncommitted.
        std::fs::write(dir.join("mine.txt"), "work in progress").unwrap();

        let undo = revert(root, &hash).unwrap();
        assert!(!undo.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("Card.tsx")).unwrap(), "old card");
        assert_eq!(
            std::fs::read_to_string(dir.join("ProductCard.tsx")).unwrap(),
            "old product",
            "a deleted file must come back"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("mine.txt")).unwrap(),
            "work in progress",
            "the user's uncommitted work must not be touched"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn revert_refuses_commits_dedup_did_not_make() {
        let dir = repo("revert-foreign");
        let root = dir.to_str().unwrap();
        write(&dir, "a.tsx", "a");
        git_t(root, &["add", "-A"]);
        git_t(root, &["commit", "-qm", "user: their own commit"]);
        let hash = git(root, &["rev-parse", "--short", "HEAD"]).unwrap();
        let err = revert(root, &hash).unwrap_err();
        assert!(err.contains("not a dedup commit"), "{err}");
        assert!(revert(root, "../etc").is_err(), "hashes must be validated");
        std::fs::remove_dir_all(&dir).ok();
    }
}
