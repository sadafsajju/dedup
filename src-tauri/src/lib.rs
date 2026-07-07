//! dedup — Tauri core. Phase 0 surface: project detection, dev-server child
//! process management, git-state probe, and the recent-projects list.

mod ai;
mod devserver;
mod git;
mod instrument;
mod project;
mod proxy;
mod recents;
mod scan;
mod sidecar;

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
    let (exec, instr_info) = if let Some(cmd) = custom_command {
        // The user's explicit command wins; no rewriting on top of it.
        (
            ExecSpec::Shell(cmd),
            InstrumentationEvent { active: false, mode: "custom", detail: None },
        )
    } else if framework == Framework::Vite {
        match instrument::setup(&root, dev_script.as_deref()) {
            Ok(Some(instr)) => (
                ExecSpec::Direct {
                    program: instr.program,
                    args: instr.args,
                },
                InstrumentationEvent { active: true, mode: "tagged", detail: None },
            ),
            Ok(None) => (
                ExecSpec::Script(package_manager),
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
                    ExecSpec::Script(package_manager),
                    InstrumentationEvent { active: false, mode: "error", detail: Some(e) },
                )
            }
        }
    } else {
        let fw = if framework == Framework::Next { "Next.js" } else { "this framework" };
        (
            ExecSpec::Script(package_manager),
            InstrumentationEvent {
                active: false,
                mode: "framework",
                detail: Some(fw.to_string()),
            },
        )
    };
    let result = devserver::start(&app, &state, &root, exec);
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

/// Read className + editability for the element at `file:line:col` (FR-4.2).
#[tauri::command]
fn inspect_element(
    root: String,
    file: String,
    line: u32,
    col: u32,
) -> Result<serde_json::Value, String> {
    sidecar::inspect(&root, &file, line, col)
}

/// Apply staged class edits to one file via AST rewrite (FR-4.1).
#[tauri::command]
fn write_classes(
    root: String,
    file: String,
    edits: Vec<sidecar::ClassEdit>,
) -> Result<serde_json::Value, String> {
    sidecar::write(&root, &file, &edits)
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

/// Is the Claude Code CLI installed? (Preferred AI backend — uses the
/// user's existing subscription; API key is the fallback.)
#[tauri::command]
fn claude_code_available() -> bool {
    ai::available()
}

/// One headless prompt through the user's Claude Code install. `model` picks
/// the CLI model ("sonnet", "opus", …); None uses the CLI default.
#[tauri::command]
async fn claude_code_prompt(prompt: String, model: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ai::prompt(&prompt, model.as_deref()))
        .await
        .map_err(|e| format!("claude task failed: {e}"))?
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
fn add_recent_project(app: AppHandle, path: String, name: String) -> Vec<recents::RecentProject> {
    recents::add(&app, &path, &name)
}

#[tauri::command]
fn remove_recent_project(app: AppHandle, path: String) -> Vec<recents::RecentProject> {
    recents::remove(&app, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(DevServerState::default())
        .invoke_handler(tauri::generate_handler![
            detect_project,
            git_status,
            start_dev_server,
            stop_dev_server,
            dev_server_running,
            inspect_element,
            write_classes,
            read_source,
            write_source,
            scan_project,
            load_scan_result,
            load_categories,
            save_categories,
            claude_code_available,
            claude_code_prompt,
            commit_session,
            get_recent_projects,
            add_recent_project,
            remove_recent_project,
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
