//! Session save history and scoped undo.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub hash: String,
    pub subject: String,
    pub when: String,
    pub files: Vec<String>,
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
/// for the save-history panel.
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
            hash,
            subject,
            when,
            files,
        });
    }
    Ok(entries)
}

/// Undo one dedup commit by restoring exactly the paths it touched to their
/// state just before it, then committing that undo.
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
            git(
                root,
                &["rm", "--cached", "--ignore-unmatch", "-q", "--", file],
            )
            .ok();
        }
    }

    let message = format!(
        "dedup: undo {hash} ({})",
        subject.trim_start_matches("dedup: ")
    );
    let mut args: Vec<&str> = vec!["commit", "-m", &message, "--"];
    args.extend(files.iter().map(String::as_str));
    git(root, &args)?;
    git(root, &["rev-parse", "--short", "HEAD"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_history_and_undo_preserve_unrelated_work() {
        let root = std::env::temp_dir().join(format!(
            "dedup-history-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_str().unwrap();
        git(root_str, &["init", "-q"]).unwrap();
        git(root_str, &["config", "user.name", "History Test"]).unwrap();
        git(root_str, &["config", "user.email", "history@example.test"]).unwrap();
        git(root_str, &["config", "commit.gpgsign", "false"]).unwrap();
        std::fs::write(root.join("page.html"), "before").unwrap();
        std::fs::write(root.join("notes.txt"), "original notes").unwrap();
        git(root_str, &["add", "."]).unwrap();
        git(root_str, &["commit", "-qm", "initial project"]).unwrap();
        std::fs::write(root.join("page.html"), "after").unwrap();
        std::fs::write(root.join("new.css"), "body {}").unwrap();
        git(root_str, &["add", "page.html", "new.css"]).unwrap();
        git(root_str, &["commit", "-qm", "dedup: update page"]).unwrap();
        std::fs::write(root.join("notes.txt"), "user's unsaved work").unwrap();

        let entries = history(root_str, 50).unwrap();
        assert_eq!(entries.len(), 1, "only dedup saves appear");
        assert_eq!(entries[0].subject, "dedup: update page");
        assert_eq!(entries[0].files, vec!["new.css", "page.html"]);
        revert(root_str, &entries[0].hash).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("page.html")).unwrap(),
            "before"
        );
        assert!(
            !root.join("new.css").exists(),
            "undo removes a file created by the save"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("notes.txt")).unwrap(),
            "user's unsaved work"
        );
        let entries = history(root_str, 50).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].subject.starts_with("dedup: undo "));
        std::fs::remove_dir_all(root).unwrap();
    }
}
