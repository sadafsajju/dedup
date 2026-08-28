//! Recent-projects list for the launch screen (FR-1.1). Persisted as a small
//! JSON file in the app config dir; most-recent first, de-duplicated, capped.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MAX_RECENTS: usize = 8;
const FILE_NAME: &str = "recents.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    /// Cached at open time so the launch grid can label cards without
    /// re-detecting eight projects on mount. Absent in pre-grid files.
    #[serde(default)]
    pub framework: Option<String>,
    /// Unix millis of the last open — drives the "3d ago" card subtitle.
    #[serde(default)]
    pub last_opened: Option<u64>,
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("no config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

pub fn load(app: &AppHandle) -> Vec<RecentProject> {
    let path = match store_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn add(app: &AppHandle, path: &str, name: &str, framework: Option<String>) -> Vec<RecentProject> {
    let mut list = load(app);
    list.retain(|r| r.path != path);
    list.insert(
        0,
        RecentProject {
            path: path.to_string(),
            name: name.to_string(),
            framework,
            last_opened: Some(now_millis()),
        },
    );
    list.truncate(MAX_RECENTS);

    if let Ok(store) = store_path(app) {
        if let Ok(text) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(store, text);
        }
    }
    list
}

pub fn remove(app: &AppHandle, path: &str) -> Vec<RecentProject> {
    let mut list = load(app);
    list.retain(|r| r.path != path);
    if let Ok(store) = store_path(app) {
        if let Ok(text) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(store, text);
        }
    }
    list
}
