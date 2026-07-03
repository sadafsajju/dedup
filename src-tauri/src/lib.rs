//! dedup — Tauri core. Phase 0 surface: project detection, dev-server child
//! process management, git-state probe, and the recent-projects list.

mod devserver;
mod git;
mod project;
mod recents;

use devserver::DevServerState;
use project::{PackageManager, ProjectInfo};
use tauri::{AppHandle, State};

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
    custom_command: Option<String>,
) -> Result<(), String> {
    devserver::start(&app, &state, &root, package_manager, custom_command)
}

#[tauri::command]
fn stop_dev_server(app: AppHandle, state: State<'_, DevServerState>) -> Result<(), String> {
    devserver::stop(&app, &state)
}

#[tauri::command]
fn dev_server_running(state: State<'_, DevServerState>) -> bool {
    devserver::is_running(&state)
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
            get_recent_projects,
            add_recent_project,
            remove_recent_project,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
