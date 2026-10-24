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

/// Make an existing folder a git repository whose first commit is its files as
/// they stand — the baseline every dedup edit is then committed on top of.
///
/// The user's explicit request, from a button: dedup's safety model needs git
/// and a folder of hand-written pages often has none. Refuses a folder that is
/// already inside a repository (including a parent's — that repository is the
/// user's, and a nested one would hide their files from it). If the baseline
/// commit fails, the `.git` this just created is removed again, so a failure
/// leaves the folder exactly as it was found rather than half set up.
pub fn init_baseline(root: &str) -> Result<(), String> {
    if status(root).is_repo {
        return Err("This folder is already in a git repository.".into());
    }
    let dot_git = std::path::Path::new(root).join(".git");
    if dot_git.exists() {
        return Err(
            "There is a .git folder here that git doesn't recognise as a repository — repair or remove it first."
                .into(),
        );
    }
    git(root, &["init", "-q", "-b", "main"])?;
    let result = git(root, &["add", "-A"]).and_then(|_| {
        // Nothing to commit (every file ignored) still leaves a valid repo.
        if git(root, &["diff", "--cached", "--name-only"])?.trim().is_empty() {
            return Ok(());
        }
        git(root, &["commit", "-q", "-m", "Baseline before dedup edits"]).map(|_| ())
    });
    if let Err(e) = result {
        // Ours to remove: it did not exist a moment ago (checked above).
        let _ = std::fs::remove_dir_all(&dot_git);
        return Err(if e.contains("tell me who you are") || e.contains("user.email") {
            "git doesn't know who to commit as yet. Run `git config --global user.name \"Your Name\"` and `git config --global user.email you@example.com` in a terminal, then try again.".into()
        } else {
            e
        });
    }
    Ok(())
}

/// Make sure we're on a dedup session branch (FR-4.6); create/switch on the
/// first write. Uncommitted user changes travel along (git switch keeps them).
/// Returns the branch name.
pub fn ensure_session_branch(root: &str) -> Result<String, String> {
    let st = status(root);
    if !st.is_repo {
        return Err("This project is not a git repository — dedup requires git to save (its safety model is branch + commit per change). Use “Set up git” in the top bar to make one.".into());
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

/// The paths in `paths` that git has never heard of — new files. NUL-separated
/// so a path with a space or a non-ASCII character comes back verbatim rather
/// than in git's quoted form.
fn untracked_among(root: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let mut args: Vec<&str> = vec!["ls-files", "--others", "--exclude-standard", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(git(root, &args)?
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

/// Same, for paths git already tracks.
fn tracked_among(root: &str, paths: &[String]) -> Result<Vec<String>, String> {
    let mut args: Vec<&str> = vec!["ls-files", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    Ok(git(root, &args)?
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect())
}

/// Commit exactly the given paths (worktree state), leaving anything the user
/// has staged for other files untouched (FR-4.5). Returns the short hash.
pub fn commit_paths(root: &str, message: &str, paths: &[String]) -> Result<String, String> {
    if paths.is_empty() {
        return Err("nothing to commit".into());
    }

    // `git commit -- <path>` takes a *pathspec*, and a pathspec only matches
    // files git already knows: a file dedup just created matches nothing and
    // the whole commit dies with "did not match any file(s) known to git".
    // So new files are staged first — and only new ones, because for a tracked
    // path the bare form is what leaves the user's own staged version of that
    // file alone, which is the FR-4.5 guarantee above.
    let untracked = untracked_among(root, paths)?;
    if !untracked.is_empty() {
        let mut args: Vec<&str> = vec!["add", "--"];
        args.extend(untracked.iter().map(String::as_str));
        git(root, &args)?;
    }

    // Anything neither tracked nor listed as untracked is ignored by the
    // user's .gitignore. Force-adding it would be dedup overriding a decision
    // the user wrote down, so say so instead — with the path, since the git
    // pathspec error names it without ever explaining why.
    let tracked = tracked_among(root, paths)?;
    if let Some(ignored) = paths
        .iter()
        .find(|p| !tracked.contains(p) && !untracked.contains(p))
    {
        return Err(format!(
            "{ignored} is ignored by this project's .gitignore, so dedup can't commit it. The change is on disk — un-ignore the path if you want it saved."
        ));
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

    /// The chat agent creates files (extracting a component, adding a page).
    /// An untracked path is not a pathspec git can match, so committing one
    /// without staging it first fails outright — and it fails *after* the
    /// file is already on disk, which is the worst possible moment.
    #[test]
    fn commit_paths_can_commit_a_file_that_did_not_exist() {
        let dir = temp_repo("newfile");
        let root = dir.to_str().unwrap();
        ensure_session_branch(root).unwrap();

        // The user has staged their own unrelated change, as before.
        std::fs::write(dir.join("b.tsx"), "b2-user-staged").unwrap();
        git(root, &["add", "b.tsx"]).unwrap();

        // dedup edits one existing file and creates two new ones, one nested.
        std::fs::write(dir.join("a.tsx"), "a2-dedup").unwrap();
        std::fs::write(dir.join("docs.html"), "<h1>docs</h1>").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/Card.tsx"), "card").unwrap();

        let hash = commit_paths(
            root,
            "dedup: add a docs page",
            &["a.tsx".into(), "docs.html".into(), "src/Card.tsx".into()],
        )
        .unwrap();
        assert!(!hash.is_empty());

        let show = git(root, &["show", "--stat", "--name-only", "HEAD"]).unwrap();
        assert!(show.contains("docs.html"), "the new file must land: {show}");
        assert!(show.contains("src/Card.tsx"), "nested too: {show}");
        assert!(show.contains("a.tsx"));
        // The user's staged work for an untouched file is still only staged.
        assert!(!show.contains("b.tsx"), "{show}");
        assert!(git(root, &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("b.tsx"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A new file the user's .gitignore covers can't be committed, and the
    /// reason has to survive to the message — git's own pathspec error names
    /// the path and never says why.
    #[test]
    fn an_ignored_new_file_is_refused_with_a_reason() {
        let dir = temp_repo("ignored");
        let root = dir.to_str().unwrap();
        ensure_session_branch(root).unwrap();
        std::fs::write(dir.join(".gitignore"), "generated/\n").unwrap();
        git(root, &["add", ".gitignore"]).unwrap();
        git(root, &["commit", "-qm", "ignore"]).unwrap();

        std::fs::create_dir_all(dir.join("generated")).unwrap();
        std::fs::write(dir.join("generated/Card.tsx"), "card").unwrap();

        let err = commit_paths(root, "dedup: x", &["generated/Card.tsx".into()]).unwrap_err();
        assert!(err.contains("generated/Card.tsx"), "{err}");
        assert!(err.contains(".gitignore"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Needs a commit identity, which a developer machine has globally; a bare
    /// CI box may not, and then there is nothing meaningful to assert.
    fn has_identity() -> bool {
        Command::new("git")
            .args(["config", "user.email"])
            .output()
            .is_ok_and(|o| o.status.success() && !o.stdout.is_empty())
    }

    #[test]
    fn a_plain_folder_becomes_a_repo_with_its_files_as_the_baseline() {
        if !has_identity() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("dedup-git-baseline-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("vendor")).unwrap();
        std::fs::write(dir.join("Main.dc.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(dir.join("vendor/react.js"), "x").unwrap();
        let root = dir.to_str().unwrap();

        init_baseline(root).unwrap();
        let st = status(root);
        assert!(st.is_repo);
        assert!(!st.is_dirty, "every file is in the baseline");
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(git(root, &["rev-list", "--count", "HEAD"]).unwrap(), "1");
        // And the safety model can now do its job.
        assert!(ensure_session_branch(root).unwrap().starts_with("dedup/session-"));

        // Never twice, and never over a repository that already exists.
        assert!(init_baseline(root).unwrap_err().contains("already"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_folder_inside_someone_elses_repo_is_refused() {
        let dir = temp_repo("nested");
        std::fs::create_dir_all(dir.join("site")).unwrap();
        let err = init_baseline(dir.join("site").to_str().unwrap()).unwrap_err();
        assert!(err.contains("already"), "{err}");
        assert!(!dir.join("site/.git").exists());
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
