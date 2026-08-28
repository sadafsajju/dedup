//! dedup — Tauri core. Phase 0 surface: project detection, dev-server child
//! process management, git-state probe, and the recent-projects list.

mod ai;
mod devserver;
mod git;
mod instrument;
mod merge;
mod project;
mod proxy;
mod recents;
mod scan;
mod session;
mod sidecar;
mod thumbs;
mod toolpath;
mod visual;

use devserver::{DevServerState, ExecSpec};
use project::{Framework, PackageManager, ProjectInfo};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
fn detect_project(root: String) -> ProjectInfo {
    project::detect(&root)
}

#[tauri::command]
fn git_status(root: String) -> git::GitStatus {
    git::status(&root)
}

/// Whether (and why not) element tagging is active for this session, so the
/// UI can say "inspection is off because X" instead of degrading silently.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct InstrumentationEvent {
    active: bool,
    /// "tagged" | "custom" | "framework" | "script" | "error"
    mode: &'static str,
    detail: Option<String>,
}

#[tauri::command]
fn start_dev_server(
    app: AppHandle,
    state: State<'_, DevServerState>,
    root: String,
    package_manager: PackageManager,
    framework: Framework,
    dev_script: Option<String>,
    custom_command: Option<String>,
) -> Result<(), String> {
    let (launch, instr_info): (devserver::Launch, InstrumentationEvent) =
        if let Some(cmd) = custom_command {
        // The user's explicit command wins; no rewriting on top of it.
        (
            ExecSpec::Shell(cmd).into(),
            InstrumentationEvent { active: false, mode: "custom", detail: None },
        )
    } else if framework == Framework::Vite {
        match instrument::setup(&root, dev_script.as_deref()) {
            Ok(Some(instr)) => (
                ExecSpec::Direct {
                    program: instr.program,
                    args: instr.args,
                }
                .into(),
                InstrumentationEvent { active: true, mode: "tagged", detail: None },
            ),
            Ok(None) => (
                ExecSpec::Script(package_manager, Vec::new()).into(),
                InstrumentationEvent { active: false, mode: "script", detail: None },
            ),
            Err(e) => {
                // Instrumentation is an enhancement, not a requirement — run
                // plain and tell the user why inspection is unavailable.
                let _ = app.emit(
                    "devserver://log",
                    serde_json::json!({
                        "stream": "stderr",
                        "line": format!("dedup: tagging setup failed ({e}) — inspection disabled"),
                    }),
                );
                (
                    ExecSpec::Script(package_manager, Vec::new()).into(),
                    InstrumentationEvent { active: false, mode: "error", detail: Some(e) },
                )
            }
        }
    } else if framework == Framework::Next {
        // Next has no --config flag, so tagging rides on a line the user adds
        // to their own next.config (see instrument::next_status). The wrapper
        // is inert without DEDUP_TAGGING, so setting it here is what turns
        // tagging on for dedup's dev server and nobody else's.
        match instrument::next_status(&root) {
            instrument::NextStatus::Wired { needs_webpack, .. } => {
                // Turbopack never runs the webpack hook dedup tags through, so
                // a Turbopack project is launched under webpack. The flag has
                // to *replace* the script's own bundler flag, not join it —
                // Next refuses to start with both — so dedup runs `next`
                // directly, carrying the env the script set up.
                let direct = needs_webpack
                    .then(|| instrument::next_webpack_launch(&root, dev_script.as_deref()))
                    .flatten();
                match direct {
                    Some(launch) => (
                        devserver::Launch {
                            exec: ExecSpec::Direct {
                                program: launch.program,
                                args: launch.args,
                            },
                            env: launch
                                .env
                                .into_iter()
                                .chain([("DEDUP_TAGGING".to_string(), "1".to_string())])
                                .collect(),
                        },
                        InstrumentationEvent {
                            active: true,
                            mode: "tagged",
                            detail: Some("webpack".to_string()),
                        },
                    ),
                    // Needs webpack but the dev script is too custom to
                    // rewrite: run it as written and say inspection is off,
                    // rather than start a server that tags nothing.
                    None if needs_webpack => (
                        ExecSpec::Script(package_manager, Vec::new()).into(),
                        InstrumentationEvent {
                            active: false,
                            mode: "framework",
                            detail: Some(
                                "Next.js on Turbopack — dedup couldn't rewrite this dev script to run webpack, so element tagging is off. Set a custom dev command with `--webpack`".into(),
                            ),
                        },
                    ),
                    None => (
                        devserver::Launch {
                            exec: ExecSpec::Script(package_manager, Vec::new()),
                            env: vec![("DEDUP_TAGGING".into(), "1".into())],
                        },
                        InstrumentationEvent { active: true, mode: "tagged", detail: None },
                    ),
                }
            }
            instrument::NextStatus::Offered { config, .. } => (
                ExecSpec::Script(package_manager, Vec::new()).into(),
                InstrumentationEvent {
                    active: false,
                    mode: "next-optin",
                    detail: Some(config),
                },
            ),
            instrument::NextStatus::Unavailable { reason } => (
                ExecSpec::Script(package_manager, Vec::new()).into(),
                InstrumentationEvent {
                    active: false,
                    mode: "framework",
                    detail: Some(format!("Next.js — {reason}")),
                },
            ),
        }
    } else {
        (
            ExecSpec::Script(package_manager, Vec::new()).into(),
            InstrumentationEvent {
                active: false,
                mode: "framework",
                detail: Some("this framework".to_string()),
            },
        )
    };
    let result = devserver::start(&app, &state, &root, launch);
    if result.is_ok() {
        let _ = app.emit("devserver://instrumentation", instr_info);
    }
    result
}

#[tauri::command]
fn stop_dev_server(app: AppHandle, state: State<'_, DevServerState>) -> Result<(), String> {
    devserver::stop(&app, &state)
}

#[tauri::command]
fn dev_server_running(state: State<'_, DevServerState>) -> bool {
    devserver::is_running(&state)
}

/// Report the element at ordinal `index` in `file`: className editability,
/// live line/col, and which structural edits it admits (FR-4.2).
#[tauri::command]
fn inspect_element(
    root: String,
    file: String,
    index: u32,
) -> Result<serde_json::Value, String> {
    sidecar::inspect(&root, &file, index)
}

/// Apply one file's staged edit program — class, text, insert, remove, move —
/// as a single AST-ranged write (FR-4.1).
#[tauri::command]
async fn apply_edits(
    root: String,
    file: String,
    ops: Vec<sidecar::EditOp>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::apply(&root, &file, &ops))
        .await
        .map_err(|e| format!("edit task failed: {e}"))?
}

/// Read one project source file (AI chat context). Path is resolved inside
/// the project root — anything escaping it is refused.
#[tauri::command]
fn read_source(root: String, file: String) -> Result<String, String> {
    let path = sidecar::resolve_in_root(&root, &file)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {file}: {e}"))
}

/// Replace one source file with AI-produced content. The sidecar re-parses
/// the content and refuses anything that doesn't parse — same trust gate as
/// class write-back. Returns `{ ok, changed }`.
#[tauri::command]
async fn write_source(
    root: String,
    file: String,
    content: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::write_file(&root, &file, &content))
        .await
        .map_err(|e| format!("write task failed: {e}"))?
}

/// Duplicate scan (FR-5.1/5.2): inventory + structural clustering. `files`
/// (relative paths) scopes clustering to the current canvas page; None scans
/// the whole project. Progress arrives as `scan://progress` events; the
/// return value is the full result. Async so the (potentially long) sidecar
/// run never blocks the main thread.
#[tauri::command]
async fn scan_project(
    app: AppHandle,
    root: String,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || scan::run(&app, &root, files))
        .await
        .map_err(|e| format!("scan task failed: {e}"))?
}

/// Last persisted scan for the project (None when never scanned).
#[tauri::command]
fn load_scan_result(root: String) -> Option<serde_json::Value> {
    scan::load_saved(&root)
}

/// Which coding-agent CLIs are installed. Preferred AI backends — they use a
/// subscription the user already has; an API key is the fallback.
#[tauri::command]
fn agent_available(agent: String) -> bool {
    ai::Agent::parse(&agent).is_some_and(ai::available)
}

/// One headless prompt through the named agent. `model` is whatever that CLI
/// calls a model; None uses its own default.
#[tauri::command]
async fn agent_prompt(
    agent: String,
    prompt: String,
    model: Option<String>,
) -> Result<String, String> {
    let agent = ai::Agent::parse(&agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    tauri::async_runtime::spawn_blocking(move || ai::prompt(agent, &prompt, model.as_deref()))
        .await
        .map_err(|e| format!("agent task failed: {e}"))?
}

/// Cached AI category assignments for the project's components.
#[tauri::command]
fn load_categories(root: String) -> Option<serde_json::Value> {
    scan::load_categories(&root)
}

#[tauri::command]
fn save_categories(root: String, categories: serde_json::Value) -> Result<(), String> {
    scan::save_categories(&root, &categories)
}

/// Mock-session seed for zero-login editing (None when never set up).
#[tauri::command]
fn load_session_seed(root: String) -> Option<session::SessionSeed> {
    session::load(&root)
}

/// Persist the reviewed seed script and whether it's active. Takes effect on
/// the next canvas frame reload — the tagger serves this file per request.
#[tauri::command]
fn save_session_seed(root: String, enabled: bool, script: String) -> Result<(), String> {
    session::save(&root, enabled, &script)
}

/// The app's auth SDK (when it uses one) plus any of its own session-storage
/// code — what the seed generator reasons from, and what tells the user when
/// a seed can't work at all.
#[tauri::command]
fn collect_auth_context(root: String) -> session::AuthContext {
    session::collect_auth_context(&root)
}

/// First-write branch guarantee + commit-per-save (FR-4.5, FR-4.6).
/// Returns (branch, short hash).
#[tauri::command]
fn commit_session(
    root: String,
    message: String,
    paths: Vec<String>,
) -> Result<(String, String), String> {
    let branch = git::ensure_session_branch(&root)?;
    let hash = git::commit_paths(&root, &message, &paths)?;
    Ok((branch, hash))
}

#[tauri::command]
fn get_recent_projects(app: AppHandle) -> Vec<recents::RecentProject> {
    recents::load(&app)
}

#[tauri::command]
fn add_recent_project(
    app: AppHandle,
    path: String,
    name: String,
    framework: Option<String>,
) -> Vec<recents::RecentProject> {
    recents::add(&app, &path, &name, framework)
}

#[tauri::command]
fn remove_recent_project(app: AppHandle, path: String) -> Vec<recents::RecentProject> {
    thumbs::forget(&app, &path);
    recents::remove(&app, &path)
}

/// Launch-grid card image, or null when the project was never captured.
#[tauri::command]
fn project_thumbnail(app: AppHandle, root: String) -> Option<String> {
    thumbs::load(&app, &root)
}

/// Snapshot the canvas region into the project's thumbnail. Blocking work
/// (it waits on WebKit's completion handler), so never on the main thread.
#[tauri::command]
async fn capture_project_thumbnail(
    app: AppHandle,
    root: String,
    rect: Option<thumbs::Rect>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || thumbs::capture(&app, &root, rect))
        .await
        .map_err(|e| format!("capture thumbnail: {e}"))?
}

/// Page routes discovered from the project's files (no dev server needed).
#[tauri::command]
async fn detect_routes(root: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || sidecar::routes(&root))
        .await
        .map_err(|e| format!("route scan failed: {e}"))?
}

/// What dedup can do for a Next.js project: already wired, an offer with the
/// exact config diff, or a reason it cannot be. Read-only.
#[tauri::command]
fn next_status(root: String) -> instrument::NextStatus {
    instrument::next_status(&root)
}

// --- Guarded merge (FR-5.4 -> FR-5.7) ----------------------------------------

/// Read-only merge plan: member sources, prop signatures, behaviour signals,
/// and every call site traced through a real import.
#[tauri::command]
async fn merge_plan(
    root: String,
    members: Vec<merge::MergeMember>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || merge::plan(&root, members))
        .await
        .map_err(|e| format!("merge plan task failed: {e}"))?
}

/// Compute the merge. `dryRun` returns every file's before/after and writes
/// nothing -- that is the diff the user approves before anything lands.
#[tauri::command]
async fn merge_apply(
    root: String,
    canonical: merge::Canonical,
    mapping: Vec<merge::MergeMapping>,
    dry_run: bool,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || merge::apply(&root, canonical, mapping, dry_run))
        .await
        .map_err(|e| format!("merge task failed: {e}"))?
}

/// Staged-deletion lifecycle: "list" | "restore" | "empty" (FR-5.5).
#[tauri::command]
async fn merge_trash(
    root: String,
    action: String,
    files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || merge::trash(&root, &action, files))
        .await
        .map_err(|e| format!("trash task failed: {e}"))?
}

/// One safety gate: "typecheck" or "build" (FR-5.6). A project with neither
/// reports `skipped` -- never a silent pass.
#[tauri::command]
async fn run_check(root: String, kind: String) -> Result<merge::CheckResult, String> {
    tauri::async_runtime::spawn_blocking(move || merge::run_check(&root, &kind))
        .await
        .map_err(|e| format!("check task failed: {e}"))?
}

/// dedup's own commits on this session branch, newest first (FR-5.7).
#[tauri::command]
fn session_history(root: String, limit: Option<u32>) -> Result<Vec<merge::HistoryEntry>, String> {
    merge::history(&root, limit.unwrap_or(50))
}

/// Undo one dedup commit, restoring only the paths it touched.
#[tauri::command]
async fn revert_commit(root: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || merge::revert(&root, &hash))
        .await
        .map_err(|e| format!("revert task failed: {e}"))?
}

// --- Visual pass (FR-5.2 visual signal, FR-5.6 #3) ---------------------------

/// Snapshots held between a "before" and an "after" capture. Bytes stay in
/// Rust: a full-resolution PNG per artboard is not something to shuttle
/// through the IPC boundary as base64 twice.
#[derive(Default)]
struct Snapshots(std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>);

/// Capture a canvas region under `label` for a later comparison.
#[tauri::command]
async fn visual_capture(
    app: AppHandle,
    snapshots: State<'_, Snapshots>,
    label: String,
    rect: Option<thumbs::Rect>,
) -> Result<(), String> {
    let png = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || thumbs::snapshot_png(&app, rect)
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))??;
    snapshots
        .0
        .lock()
        .map_err(|_| "snapshot store poisoned")?
        .insert(label, png);
    Ok(())
}

/// Pixel-diff two captures (FR-5.6 #3). A size change counts as a regression,
/// not as something to resize away.
#[tauri::command]
fn visual_compare(
    snapshots: State<'_, Snapshots>,
    before: String,
    after: String,
) -> Result<visual::DiffResult, String> {
    let store = snapshots.0.lock().map_err(|_| "snapshot store poisoned")?;
    let a = store
        .get(&before)
        .ok_or("no before-capture for that artboard")?;
    let b = store
        .get(&after)
        .ok_or("no after-capture for that artboard")?;
    Ok(visual::compare(&visual::decode_png(a)?, &visual::decode_png(b)?))
}

/// Perceptual hash of a canvas region -- the visual similarity signal.
#[tauri::command]
async fn visual_hash(app: AppHandle, rect: Option<thumbs::Rect>) -> Result<String, String> {
    let png = tauri::async_runtime::spawn_blocking(move || thumbs::snapshot_png(&app, rect))
        .await
        .map_err(|e| format!("hash task failed: {e}"))??;
    // As hex: a u64 does not survive JSON's number precision intact.
    Ok(format!("{:016x}", visual::phash(&visual::decode_png(&png)?)))
}

/// Visual similarity of two perceptual hashes, 0..1. Lives here rather than
/// in the frontend so there is one definition of "how alike do these look" —
/// the hash and its comparison are two halves of the same decision.
#[tauri::command]
fn visual_similarity(a: String, b: String) -> Result<f64, String> {
    let parse = |h: &str| u64::from_str_radix(h, 16).map_err(|_| format!("bad hash: {h}"));
    Ok(visual::hash_similarity(parse(&a)?, parse(&b)?))
}

#[tauri::command]
fn visual_forget(snapshots: State<'_, Snapshots>, prefix: Option<String>) -> Result<(), String> {
    let mut store = snapshots.0.lock().map_err(|_| "snapshot store poisoned")?;
    match prefix {
        Some(p) => store.retain(|k, _| !k.starts_with(&p)),
        None => store.clear(),
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DevServerState::default())
        .manage(Snapshots::default())
        .invoke_handler(tauri::generate_handler![
            detect_project,
            git_status,
            start_dev_server,
            stop_dev_server,
            dev_server_running,
            inspect_element,
            apply_edits,
            read_source,
            write_source,
            scan_project,
            load_scan_result,
            load_categories,
            save_categories,
            load_session_seed,
            save_session_seed,
            collect_auth_context,
            agent_available,
            agent_prompt,
            commit_session,
            get_recent_projects,
            add_recent_project,
            remove_recent_project,
            project_thumbnail,
            capture_project_thumbnail,
            detect_routes,
            next_status,
            merge_plan,
            merge_apply,
            merge_trash,
            run_check,
            session_history,
            revert_commit,
            visual_capture,
            visual_compare,
            visual_hash,
            visual_forget,
            visual_similarity,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ⌘Q and other app-level exits bypass the window close handler —
            // make sure the user's dev server never outlives us (FR-1.3).
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<DevServerState>() {
                    devserver::shutdown(&state);
                }
            }
        });
}
