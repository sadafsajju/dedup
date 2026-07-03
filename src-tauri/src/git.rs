//! Minimal git-state probe (FR-1.5). The full safety model (dedicated branch,
//! commit-per-change) lands in Phase 2; here we just need to tell the user
//! whether the working tree is clean before they start.

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub is_dirty: bool,
    pub branch: Option<String>,
    /// Count of changed/untracked entries, for a quick "N uncommitted changes".
    pub changed_files: u32,
}

pub fn status(root: &str) -> GitStatus {
    let inside = Command::new("git")
        .args(["-C", root, "rev-parse", "--is-inside-work-tree"])
        .output();

    let is_repo = matches!(inside, Ok(ref o) if o.status.success());
    if !is_repo {
        return GitStatus {
            is_repo: false,
            is_dirty: false,
            branch: None,
            changed_files: 0,
        };
    }

    let porcelain = Command::new("git")
        .args(["-C", root, "status", "--porcelain"])
        .output();
    let changed_files = match porcelain {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count() as u32,
        Err(_) => 0,
    };

    let branch = Command::new("git")
        .args(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    GitStatus {
        is_repo: true,
        is_dirty: changed_files > 0,
        branch,
        changed_files,
    }
}
