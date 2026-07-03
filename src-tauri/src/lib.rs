//! dedup — Tauri core. Phase 0 surface: project detection, dev-server child
//! process management, git-state probe, and the recent-projects list.

mod devserver;
mod git;
mod instrument;
mod project;
mod proxy;
mod recents;
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
    let exec = if let Some(cmd) = custom_command {
        // The user's explicit command wins; no rewriting on top of it.
        ExecSpec::Shell(cmd)
    } else if framework == Framework::Vite {
        match instrument::setup(&root, dev_script.as_deref()) {
            Ok(Some(instr)) => ExecSpec::Direct {
                program: instr.program,
                args: instr.args,
            },
            Ok(None) => ExecSpec::Script(package_manager),
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
                ExecSpec::Script(package_manager)
            }
        }
    } else {
        ExecSpec::Script(package_manager)
    };
    devserver::start(&app, &state, &root, exec)
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
