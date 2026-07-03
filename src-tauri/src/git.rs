//! Git-state probe (FR-1.5) and the write safety model (FR-4.5/4.6): all
//! dedup writes land as commits on a dedicated `dedup/session-*` branch,
//! never on the user's own branch.

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
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Make sure we're on a dedup session branch (FR-4.6); create/switch on the
/// first write. Uncommitted user changes travel along (git switch keeps them).
/// Returns the branch name.
pub fn ensure_session_branch(root: &str) -> Result<String, String> {
    let st = status(root);
    if !st.is_repo {
        return Err("This project is not a git repository — dedup requires git to save (its safety model is branch + commit per change).".into());
    }
    if let Some(branch) = &st.branch {
        if branch.starts_with("dedup/session-") {
            return Ok(branch.clone());
        }
    }

    // Human-readable, minute-granular name; suffix on collision.
    let stamp = Command::new("date")
        .arg("+%Y%m%d-%H%M")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "session".to_string());

    let mut name = format!("dedup/session-{stamp}");
    for i in 2..10 {
        match git(root, &["switch", "-c", &name]) {
            Ok(_) => return Ok(name),
            Err(_) => name = format!("dedup/session-{stamp}-{i}"),
        }
    }
    Err("could not create a dedup session branch".into())
}

/// Commit exactly the given paths (worktree state), leaving anything the user
/// has staged for other files untouched (FR-4.5). Returns the short hash.
pub fn commit_paths(root: &str, message: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("nothing to commit".into());
    }
    let mut args: Vec<&str> = vec!["commit", "-m", message, "--"];
    args.extend(paths.iter().map(String::as_str));
    git(root, &args)?;
    git(root, &["rev-parse", "--short", "HEAD"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dedup-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.to_str().unwrap();
        git(root, &["init", "-q", "-b", "main"]).unwrap();
        git(root, &["config", "user.email", "t@t"]).unwrap();
        git(root, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.tsx"), "a1").unwrap();
        std::fs::write(dir.join("b.tsx"), "b1").unwrap();
        git(root, &["add", "-A"]).unwrap();
        git(root, &["commit", "-qm", "init"]).unwrap();
        dir
    }

    #[test]
    fn creates_session_branch_and_is_idempotent() {
        let dir = temp_repo("branch");
        let root = dir.to_str().unwrap();
        let name = ensure_session_branch(root).unwrap();
        assert!(name.starts_with("dedup/session-"));
        // Second call keeps the same branch.
        assert_eq!(ensure_session_branch(root).unwrap(), name);
        assert_eq!(status(root).branch.as_deref(), Some(name.as_str()));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn commit_paths_leaves_other_staged_files_alone() {
        let dir = temp_repo("commit");
        let root = dir.to_str().unwrap();
        ensure_session_branch(root).unwrap();

        // The user has staged their own unrelated change...
        std::fs::write(dir.join("b.tsx"), "b2-user-staged").unwrap();
        git(root, &["add", "b.tsx"]).unwrap();
        // ...and dedup edits a.tsx.
        std::fs::write(dir.join("a.tsx"), "a2-dedup").unwrap();

        let hash = commit_paths(root, "dedup: test edit", &["a.tsx".into()]).unwrap();
        assert!(!hash.is_empty());

        // a.tsx committed; b.tsx still staged, not committed.
        let show = git(root, &["show", "--stat", "--name-only", "HEAD"]).unwrap();
        assert!(show.contains("a.tsx"));
        assert!(!show.contains("b.tsx"));
        let staged = git(root, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains("b.tsx"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_outside_a_repo() {
        let dir = std::env::temp_dir().join(format!("dedup-git-norepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(ensure_session_branch(dir.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
