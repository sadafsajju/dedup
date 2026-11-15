//! Getting a session's commits out of the session branch: pushing a branch to
//! a remote, and landing the session on another branch (main included).
//!
//! Everything else dedup does with git stays on `dedup/session-*`. These two
//! operations are the deliberate exceptions, by the owner's decision
//! (2026-11-10), and each is held to rules of its own:
//!
//! - **Only ever on an explicit request that names the branch and the remote.**
//!   Nothing here runs as a side effect of a save, and the names come in as
//!   arguments — never "whatever is configured".
//! - **Never a force.** A push the remote rejects stays rejected; a landing is
//!   a fast-forward or it is refused.
//! - **Commits travel, the working tree does not.** A push sends commits. A
//!   landing moves a branch *ref* and leaves HEAD, the index and every file
//!   where they were — so the user's uncommitted work and a live chat preview
//!   (uncommitted on purpose) cannot be swept in, by construction rather than
//!   by a check. The one case that has to touch files — the target is the
//!   branch checked out here — is refused unless the tree is clean.
//! - **No network unless asked.** `sync_status` reads refs only; "behind the
//!   remote" is as of the user's last fetch, and the push itself is what finds
//!   out otherwise.

use serde::Serialize;
use std::process::{Command, Stdio};

const SESSION_PREFIX: &str = "dedup/session-";
/// Branches offered as landing targets. A repo with hundreds of branches
/// would otherwise cost four git calls each, on every refresh of the tab.
const MAX_TARGETS: usize = 24;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    /// With any `user:token@` removed — a credential in a remote URL is common
    /// and has no business on screen.
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BranchSync {
    pub name: String,
    /// Commits the current branch has that this one lacks — what a landing
    /// would bring. Not only dedup's: a session cut from a feature branch
    /// carries that branch's commits too, and the UI has to say so.
    pub ahead: u32,
    /// How many of those are dedup's own saves.
    pub dedup_ahead: u32,
    /// Commits this branch has that the current one lacks. Non-zero means
    /// diverged: no fast-forward exists.
    pub behind: u32,
    /// Where it is checked out, if anywhere (this folder or a linked worktree).
    pub checked_out_at: Option<String>,
    /// Whether that checkout is this very folder.
    pub checked_out_here: bool,
    /// Commits not yet on `<remote>/<name>`; None when the remote has no such
    /// branch as far as the last fetch knows.
    pub unpushed: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub is_repo: bool,
    /// None on a detached HEAD.
    pub branch: Option<String>,
    pub detached: bool,
    pub on_session: bool,
    pub remotes: Vec<RemoteInfo>,
    /// The remote a push would default to; the user can pick another.
    pub remote: Option<String>,
    /// Short hashes on the current branch that `<remote>/<branch>` lacks.
    /// None when the branch has never been pushed there (or there is no
    /// remote) — which also means every commit is unpushed.
    pub unpushed: Option<Vec<String>>,
    /// Commits `<remote>/<branch>` has that the local branch lacks, as of the
    /// last fetch. A push would be rejected.
    pub remote_ahead: u32,
    pub targets: Vec<BranchSync>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResult {
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LandResult {
    pub target: String,
    pub from: String,
    pub commits: u32,
}

fn git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn ok(root: &str, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn count(root: &str, range: &str) -> u32 {
    git(root, &["rev-list", "--count", range])
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn is_repo(root: &str) -> bool {
    ok(root, &["rev-parse", "--is-inside-work-tree"])
}

/// The branch HEAD is on; None when detached.
fn current_branch(root: &str) -> Option<String> {
    git(root, &["symbolic-ref", "-q", "--short", "HEAD"])
        .ok()
        .filter(|s| !s.is_empty())
}

fn branch_exists(root: &str, name: &str) -> bool {
    // The `refs/heads/` prefix is the validation: a name that is really an
    // option, a refspec (`+main`, `a:b`) or a tag cannot resolve under it.
    !name.is_empty()
        && !name.starts_with('-')
        && ok(root, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")])
}

fn remote_names(root: &str) -> Vec<String> {
    git(root, &["remote"])
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

/// `https://user:token@host/x.git` → `https://host/x.git`. scp-style
/// (`git@host:x`) carries a login name, not a secret, and is left alone.
fn redact_url(url: &str) -> String {
    if let Some((scheme, rest)) = url.split_once("://") {
        let authority_end = rest.find('/').unwrap_or(rest.len());
        if let Some(at) = rest[..authority_end].rfind('@') {
            return format!("{scheme}://{}", &rest[at + 1..]);
        }
    }
    url.to_string()
}

fn default_remote(root: &str, branch: Option<&str>, remotes: &[String]) -> Option<String> {
    let configured = |key: &str| {
        git(root, &["config", "--get", key])
            .ok()
            .filter(|r| remotes.contains(r))
    };
    branch
        .and_then(|b| configured(&format!("branch.{b}.pushRemote")))
        .or_else(|| configured("remote.pushDefault"))
        .or_else(|| branch.and_then(|b| configured(&format!("branch.{b}.remote"))))
        .or_else(|| remotes.iter().find(|r| *r == "origin").cloned())
        .or_else(|| remotes.first().cloned())
}

/// (branch → worktree path) for every checked-out branch, plus this folder's
/// own worktree path.
fn checkouts(root: &str) -> (Vec<(String, String)>, String) {
    let here = git(root, &["rev-parse", "--show-toplevel"]).unwrap_or_default();
    let mut out = Vec::new();
    let mut path = String::new();
    for line in git(root, &["worktree", "list", "--porcelain"])
        .unwrap_or_default()
        .lines()
    {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            out.push((b.to_string(), path.clone()));
        }
    }
    (out, here)
}

fn same_path(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Where the branches stand, from refs alone — no fetch, nothing written.
pub fn sync_status(root: &str) -> SyncStatus {
    if !is_repo(root) {
        return SyncStatus::default();
    }
    let branch = current_branch(root);
    let names = remote_names(root);
    let remote = default_remote(root, branch.as_deref(), &names);
    let remotes = names
        .iter()
        .map(|name| RemoteInfo {
            name: name.clone(),
            url: redact_url(&git(root, &["remote", "get-url", name]).unwrap_or_default()),
        })
        .collect();

    let tracking = |b: &str| {
        remote
            .as_ref()
            .map(|r| format!("refs/remotes/{r}/{b}"))
            .filter(|r| ok(root, &["show-ref", "--verify", "--quiet", r]))
    };

    let (mut unpushed, mut remote_ahead) = (None, 0);
    if let Some(r) = branch.as_deref().and_then(tracking) {
        unpushed = Some(
            git(root, &["log", "--pretty=format:%h", &format!("{r}..HEAD")])
                .unwrap_or_default()
                .lines()
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect(),
        );
        remote_ahead = count(root, &format!("HEAD..{r}"));
    }

    let (checked_out, here) = checkouts(root);
    let has_head = ok(root, &["rev-parse", "--verify", "--quiet", "HEAD"]);
    let mut targets = Vec::new();
    if has_head {
        let listed = git(
            root,
            &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"],
        )
        .unwrap_or_default();
        for name in listed.lines().filter(|n| {
            !n.is_empty() && !n.starts_with(SESSION_PREFIX) && Some(*n) != branch.as_deref()
        }) {
            // Recent branches, and always the trunk however stale it looks.
            if targets.len() >= MAX_TARGETS && name != "main" && name != "master" {
                continue;
            }
            let ahead_range = format!("refs/heads/{name}..HEAD");
            let dedup_ahead = git(root, &["log", "--pretty=format:%s", &ahead_range])
                .unwrap_or_default()
                .lines()
                .filter(|s| s.starts_with("dedup:"))
                .count() as u32;
            let at = checked_out.iter().find(|(b, _)| b == name).map(|(_, p)| p.clone());
            targets.push(BranchSync {
                name: name.to_string(),
                ahead: count(root, &ahead_range),
                dedup_ahead,
                behind: count(root, &format!("HEAD..refs/heads/{name}")),
                checked_out_here: at.as_deref().is_some_and(|p| same_path(p, &here)),
                checked_out_at: at,
                unpushed: tracking(name).map(|r| count(root, &format!("{r}..refs/heads/{name}"))),
            });
        }
    }

    SyncStatus {
        is_repo: true,
        on_session: branch.as_deref().is_some_and(|b| b.starts_with(SESSION_PREFIX)),
        detached: branch.is_none(),
        branch,
        remotes,
        remote,
        unpushed,
        remote_ahead,
        targets,
    }
}

fn require_branch_state(root: &str, doing: &str) -> Result<(), String> {
    if !is_repo(root) {
        return Err(format!(
            "This project is not a git repository, so there is nothing to {doing}. Use “Set up git” first."
        ));
    }
    if current_branch(root).is_none() {
        return Err(format!(
            "HEAD is detached — the project is not on any branch, so dedup won't {doing}. Switch to a branch with your own git tools first."
        ));
    }
    Ok(())
}

/// Push one named local branch to the same name on one named remote.
///
/// Never forced: the refspec carries no `+`, so a remote that has moved on
/// rejects the push and that is the end of it. Commits only — the working
/// tree is not consulted, so nothing uncommitted (the user's edits, a chat
/// preview) can be sent. The user's own pre-push hook runs as it would for
/// them; skipping it would be overriding a rule they set.
pub fn push(root: &str, remote: &str, branch: &str) -> Result<PushResult, String> {
    require_branch_state(root, "push")?;
    let remotes = remote_names(root);
    if remotes.is_empty() {
        return Err("This repository has no remote to push to. Add one (`git remote add origin <url>`) in a terminal, then try again.".into());
    }
    if !remotes.iter().any(|r| r == remote) {
        return Err(format!("There is no remote called “{remote}” in this repository."));
    }
    if !branch_exists(root, branch) {
        return Err(format!("There is no local branch called “{branch}”."));
    }

    let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["push", "--porcelain", remote, &refspec])
        // A credential prompt has no terminal to appear in; without this the
        // push would wait forever for an answer nobody can give.
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if out.status.success() {
        return Ok(PushResult { remote: remote.into(), branch: branch.into() });
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    Err(explain_push_failure(&text, remote, branch))
}

fn explain_push_failure(text: &str, remote: &str, branch: &str) -> String {
    let lower = text.to_lowercase();
    if lower.contains("non-fast-forward") || lower.contains("fetch first") || lower.contains("[rejected]") {
        return format!(
            "{remote} has commits on {branch} that this copy doesn't, so the push was rejected. dedup never force-pushes — pull or merge them with your own git tools, then push again."
        );
    }
    if lower.contains("terminal prompts disabled")
        || lower.contains("could not read username")
        || lower.contains("authentication failed")
        || lower.contains("permission denied")
    {
        return format!(
            "git couldn't sign in to {remote}. Push once from a terminal (`git push {remote} {branch}`) so git can ask for and remember your credentials, then this will work."
        );
    }
    let detail = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("To ") && *l != "Done")
        .collect::<Vec<_>>()
        .join(" · ");
    format!("Push to {remote} failed: {detail}")
}

/// Bring a session's commits onto `target` by fast-forward, or refuse.
///
/// The ordinary case never touches a file: `target` is not checked out, so its
/// ref is moved (compare-and-swap against the commit it was just seen at) and
/// HEAD, the index and the working tree stay exactly as they were. If `target`
/// is the branch checked out in this folder, the files have to follow the ref,
/// and that is allowed only on a clean tree. Checked out in *another* worktree
/// it is refused outright — moving the ref under it would make that tree look
/// like a pile of uncommitted reversals.
///
/// Diverged is a refusal, not a merge: a merge commit would be a tree nobody
/// has seen rendered, written to the user's trunk by a tool. They can merge
/// with their own tools, or push the session branch and open a pull request.
pub fn land(root: &str, session: &str, target: &str) -> Result<LandResult, String> {
    require_branch_state(root, "move commits between branches")?;
    if !session.starts_with(SESSION_PREFIX) || !branch_exists(root, session) {
        return Err(format!("“{session}” is not a dedup session branch in this repository."));
    }
    if target.starts_with(SESSION_PREFIX) {
        return Err("A dedup session branch is not a place to land commits — pick one of your own branches.".into());
    }
    if !branch_exists(root, target) {
        return Err(format!("There is no local branch called “{target}”."));
    }
    let from = format!("refs/heads/{session}");
    let to = format!("refs/heads/{target}");

    let commits = count(root, &format!("{to}..{from}"));
    if commits == 0 {
        return Err(format!("{target} already has every commit on {session}."));
    }
    if !ok(root, &["merge-base", "--is-ancestor", &to, &from]) {
        let theirs = count(root, &format!("{from}..{to}"));
        return Err(format!(
            "{target} has {theirs} commit{} this session doesn't, so it can't be fast-forwarded and dedup won't merge for you. Merge with your own git tools (`git switch {target}` then `git merge {session}`), or push the session branch and open a pull request.",
            if theirs == 1 { "" } else { "s" }
        ));
    }

    let (checked_out, here) = checkouts(root);
    if let Some((_, path)) = checked_out.iter().find(|(b, _)| b == target) {
        if !same_path(path, &here) {
            return Err(format!(
                "{target} is checked out in another worktree ({path}). Moving it from here would leave that folder looking full of uncommitted changes — land it from there with your own git tools."
            ));
        }
        // Tracked changes only: an untracked file is not in the way unless the
        // incoming commits create the same path, and git itself refuses that.
        let dirty = git(root, &["status", "--porcelain", "--untracked-files=no"])?;
        if !dirty.is_empty() {
            let n = dirty.lines().count();
            return Err(format!(
                "{target} is checked out here with {n} uncommitted change{} (a chat preview counts). dedup won't touch them — commit, stash or discard them first.",
                if n == 1 { "" } else { "s" }
            ));
        }
        git(root, &["merge", "--ff-only", "--quiet", &from])
            .map_err(|e| format!("Fast-forwarding {target} failed: {e}"))?;
        return Ok(LandResult { target: target.into(), from: session.into(), commits });
    }

    let new = git(root, &["rev-parse", "--verify", &from])?;
    let old = git(root, &["rev-parse", "--verify", &to])?;
    git(
        root,
        &["update-ref", "-m", &format!("dedup: fast-forward to {session}"), &to, &new, &old],
    )
    .map_err(|e| format!("{target} changed while dedup was looking at it — nothing was moved. ({e})"))?;
    Ok(LandResult { target: target.into(), from: session.into(), commits })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "dedup-publish-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        // macOS: /var → /private/var. Worktree paths come back canonical.
        std::fs::canonicalize(d).unwrap()
    }

    fn s(p: &Path) -> &str {
        p.to_str().unwrap()
    }

    fn commit(root: &Path, file: &str, body: &str, msg: &str) {
        std::fs::write(root.join(file), body).unwrap();
        git(s(root), &["add", "--", file]).unwrap();
        git(s(root), &["commit", "-qm", msg]).unwrap();
    }

    /// A repo on `main` with one commit.
    fn repo(tag: &str) -> PathBuf {
        let d = dir(tag);
        let r = s(&d);
        git(r, &["init", "-q", "-b", "main"]).unwrap();
        git(r, &["config", "user.email", "t@t"]).unwrap();
        git(r, &["config", "user.name", "t"]).unwrap();
        git(r, &["config", "commit.gpgsign", "false"]).unwrap();
        commit(&d, "a.tsx", "a1", "init");
        d
    }

    /// …then a session branch with two dedup saves on it.
    fn repo_with_session(tag: &str) -> PathBuf {
        let d = repo(tag);
        git(s(&d), &["switch", "-qc", "dedup/session-1"]).unwrap();
        commit(&d, "a.tsx", "a2", "dedup: adjust classes on Hero");
        commit(&d, "b.tsx", "b1", "dedup: add Card");
        d
    }

    fn bare_remote(root: &Path, tag: &str) -> PathBuf {
        let remote = dir(tag);
        git(s(&remote), &["init", "-q", "--bare", "-b", "main"]).unwrap();
        git(s(root), &["remote", "add", "origin", s(&remote)]).unwrap();
        remote
    }

    fn rev(root: &Path, r: &str) -> String {
        git(s(root), &["rev-parse", r]).unwrap()
    }

    fn rm(dirs: &[&Path]) {
        for d in dirs {
            std::fs::remove_dir_all(d).ok();
        }
    }

    // --- status ------------------------------------------------------------

    #[test]
    fn status_outside_a_repo_is_empty_not_an_error() {
        let d = dir("st-norepo");
        let st = sync_status(s(&d));
        assert!(!st.is_repo);
        assert!(st.branch.is_none() && st.remotes.is_empty() && st.targets.is_empty());
        rm(&[&d]);
    }

    #[test]
    fn status_counts_what_a_landing_would_bring() {
        let d = repo_with_session("st-counts");
        let st = sync_status(s(&d));
        assert!(st.is_repo && st.on_session && !st.detached);
        assert_eq!(st.branch.as_deref(), Some("dedup/session-1"));
        assert!(st.remote.is_none());
        assert!(st.unpushed.is_none(), "never pushed is not 'zero unpushed'");
        let main = st.targets.iter().find(|t| t.name == "main").unwrap();
        assert_eq!((main.ahead, main.dedup_ahead, main.behind), (2, 2, 0));
        assert!(main.checked_out_at.is_none());
        rm(&[&d]);
    }

    /// A session cut from a feature branch carries that branch's commits; the
    /// numbers must let the UI say "3 commits, 1 of them dedup's".
    #[test]
    fn status_separates_dedup_commits_from_the_rest() {
        let d = repo("st-mixed");
        git(s(&d), &["switch", "-qc", "feature"]).unwrap();
        commit(&d, "f.tsx", "f", "user work");
        commit(&d, "g.tsx", "g", "more user work");
        git(s(&d), &["switch", "-qc", "dedup/session-1"]).unwrap();
        commit(&d, "a.tsx", "a2", "dedup: x");
        let st = sync_status(s(&d));
        let main = st.targets.iter().find(|t| t.name == "main").unwrap();
        assert_eq!((main.ahead, main.dedup_ahead), (3, 1));
        let feature = st.targets.iter().find(|t| t.name == "feature").unwrap();
        assert_eq!((feature.ahead, feature.dedup_ahead), (1, 1));
        assert!(
            st.targets.iter().all(|t| !t.name.starts_with("dedup/session-")),
            "a session branch is never offered as a target"
        );
        rm(&[&d]);
    }

    #[test]
    fn status_knows_what_is_unpushed_after_a_push() {
        let d = repo_with_session("st-unpushed");
        let remote = bare_remote(&d, "st-unpushed-remote");
        push(s(&d), "origin", "dedup/session-1").unwrap();
        assert_eq!(sync_status(s(&d)).unpushed, Some(vec![]));
        commit(&d, "a.tsx", "a3", "dedup: later");
        let st = sync_status(s(&d));
        assert_eq!(st.remote.as_deref(), Some("origin"));
        let unpushed = st.unpushed.unwrap();
        assert_eq!(unpushed.len(), 1);
        assert_eq!(unpushed[0], git(s(&d), &["rev-parse", "--short", "HEAD"]).unwrap());
        rm(&[&d, &remote]);
    }

    #[test]
    fn a_credential_in_a_remote_url_never_reaches_the_ui() {
        assert_eq!(
            redact_url("https://me:ghp_secret@github.com/a/b.git"),
            "https://github.com/a/b.git"
        );
        assert_eq!(redact_url("git@github.com:a/b.git"), "git@github.com:a/b.git");
        assert_eq!(redact_url("/tmp/x@y/repo"), "/tmp/x@y/repo");
        assert_eq!(redact_url("https://github.com/a/b@c.git"), "https://github.com/a/b@c.git");
    }

    // --- push --------------------------------------------------------------

    #[test]
    fn push_sends_the_named_branch_and_only_commits() {
        let d = repo_with_session("push-ok");
        let remote = bare_remote(&d, "push-ok-remote");
        // Uncommitted work — the user's, or a chat preview. Not a commit, so
        // not something a push can carry.
        std::fs::write(d.join("a.tsx"), "PREVIEW").unwrap();
        std::fs::write(d.join("new.tsx"), "untracked").unwrap();

        let res = push(s(&d), "origin", "dedup/session-1").unwrap();
        assert_eq!((res.remote.as_str(), res.branch.as_str()), ("origin", "dedup/session-1"));
        assert_eq!(rev(&remote, "refs/heads/dedup/session-1"), rev(&d, "HEAD"));
        assert_eq!(
            git(s(&remote), &["show", "dedup/session-1:a.tsx"]).unwrap(),
            "a2",
            "the remote has the committed file, not the preview"
        );
        assert!(git(s(&remote), &["show", "dedup/session-1:new.tsx"]).is_err());
        assert!(
            !ok(s(&remote), &["show-ref", "--verify", "--quiet", "refs/heads/main"]),
            "only the branch that was named"
        );
        assert_eq!(std::fs::read_to_string(d.join("a.tsx")).unwrap(), "PREVIEW");
        rm(&[&d, &remote]);
    }

    #[test]
    fn push_refuses_without_git() {
        let d = dir("push-norepo");
        let err = push(s(&d), "origin", "main").unwrap_err();
        assert!(err.contains("not a git repository"), "{err}");
        rm(&[&d]);
    }

    #[test]
    fn push_refuses_with_no_remote() {
        let d = repo_with_session("push-noremote");
        let err = push(s(&d), "origin", "dedup/session-1").unwrap_err();
        assert!(err.contains("no remote"), "{err}");
        rm(&[&d]);
    }

    #[test]
    fn push_refuses_a_remote_or_branch_that_does_not_exist() {
        let d = repo_with_session("push-unknown");
        let remote = bare_remote(&d, "push-unknown-remote");
        assert!(push(s(&d), "upstream", "dedup/session-1").unwrap_err().contains("upstream"));
        assert!(push(s(&d), "origin", "nope").unwrap_err().contains("nope"));
        // Names that are really refspecs or options resolve to nothing.
        for bad in ["+main", "main:main", "--force", "--all", ""] {
            assert!(push(s(&d), "origin", bad).is_err(), "{bad}");
        }
        assert!(push(s(&d), "--force", "main").is_err());
        rm(&[&d, &remote]);
    }

    #[test]
    fn push_refuses_on_a_detached_head() {
        let d = repo_with_session("push-detached");
        let remote = bare_remote(&d, "push-detached-remote");
        git(s(&d), &["checkout", "-q", "--detach"]).unwrap();
        let err = push(s(&d), "origin", "dedup/session-1").unwrap_err();
        assert!(err.contains("detached"), "{err}");
        assert!(sync_status(s(&d)).detached);
        rm(&[&d, &remote]);
    }

    /// The remote moved on. A force would win; dedup must lose, and say why.
    #[test]
    fn push_is_never_forced() {
        let d = repo_with_session("push-nonff");
        let remote = bare_remote(&d, "push-nonff-remote");
        push(s(&d), "origin", "dedup/session-1").unwrap();
        let theirs = rev(&remote, "refs/heads/dedup/session-1");
        // Rewrite local history so it no longer contains what was pushed.
        git(s(&d), &["reset", "-q", "--hard", "HEAD~1"]).unwrap();
        commit(&d, "c.tsx", "c", "dedup: something else");

        let err = push(s(&d), "origin", "dedup/session-1").unwrap_err();
        assert!(err.contains("never force-pushes"), "{err}");
        assert_eq!(rev(&remote, "refs/heads/dedup/session-1"), theirs, "remote untouched");
        rm(&[&d, &remote]);
    }

    // --- land --------------------------------------------------------------

    #[test]
    fn land_fast_forwards_the_target_without_touching_a_file() {
        let d = repo_with_session("land-ok");
        // In-flight work riding on the session branch: one tracked edit, one
        // staged, one untracked. All three must come out exactly as they went in.
        std::fs::write(d.join("a.tsx"), "user edit").unwrap();
        std::fs::write(d.join("staged.tsx"), "staged").unwrap();
        git(s(&d), &["add", "staged.tsx"]).unwrap();
        std::fs::write(d.join("untracked.tsx"), "u").unwrap();
        let before = git(s(&d), &["status", "--porcelain"]).unwrap();

        let res = land(s(&d), "dedup/session-1", "main").unwrap();
        assert_eq!((res.commits, res.target.as_str()), (2, "main"));
        assert_eq!(rev(&d, "refs/heads/main"), rev(&d, "refs/heads/dedup/session-1"));
        assert_eq!(current_branch(s(&d)).as_deref(), Some("dedup/session-1"), "HEAD stays");
        assert_eq!(git(s(&d), &["status", "--porcelain"]).unwrap(), before);
        assert_eq!(std::fs::read_to_string(d.join("a.tsx")).unwrap(), "user edit");
        assert_eq!(
            git(s(&d), &["show", "main:a.tsx"]).unwrap(),
            "a2",
            "main got the commit, not the uncommitted edit"
        );
        assert!(git(s(&d), &["show", "main:staged.tsx"]).is_err());

        // Nothing left to bring: said, not silently repeated.
        assert!(land(s(&d), "dedup/session-1", "main").unwrap_err().contains("already"));
        rm(&[&d]);
    }

    #[test]
    fn land_then_push_puts_the_session_on_the_remote_main() {
        let d = repo_with_session("land-push");
        let remote = bare_remote(&d, "land-push-remote");
        land(s(&d), "dedup/session-1", "main").unwrap();
        push(s(&d), "origin", "main").unwrap();
        assert_eq!(rev(&remote, "refs/heads/main"), rev(&d, "refs/heads/dedup/session-1"));
        let st = sync_status(s(&d));
        let main = st.targets.iter().find(|t| t.name == "main").unwrap();
        assert_eq!((main.ahead, main.unpushed), (0, Some(0)));
        rm(&[&d, &remote]);
    }

    #[test]
    fn land_refuses_a_diverged_target() {
        let d = repo_with_session("land-diverged");
        git(s(&d), &["switch", "-q", "main"]).unwrap();
        commit(&d, "m.tsx", "m", "work on main meanwhile");
        git(s(&d), &["switch", "-q", "dedup/session-1"]).unwrap();
        let main = rev(&d, "refs/heads/main");

        let err = land(s(&d), "dedup/session-1", "main").unwrap_err();
        assert!(err.contains("can't be fast-forwarded"), "{err}");
        assert!(err.contains("1 commit "), "{err}");
        assert_eq!(rev(&d, "refs/heads/main"), main, "main untouched");
        let st = sync_status(s(&d));
        assert_eq!(st.targets.iter().find(|t| t.name == "main").unwrap().behind, 1);
        rm(&[&d]);
    }

    /// The one path that moves files: the target is checked out right here.
    #[test]
    fn land_refuses_a_dirty_target_and_fast_forwards_a_clean_one() {
        let d = repo_with_session("land-dirty");
        git(s(&d), &["switch", "-q", "main"]).unwrap();
        std::fs::write(d.join("a.tsx"), "uncommitted on main").unwrap();
        let main = rev(&d, "refs/heads/main");

        let err = land(s(&d), "dedup/session-1", "main").unwrap_err();
        assert!(err.contains("uncommitted change"), "{err}");
        assert_eq!(rev(&d, "refs/heads/main"), main);
        assert_eq!(
            std::fs::read_to_string(d.join("a.tsx")).unwrap(),
            "uncommitted on main",
            "their work is exactly where they left it"
        );

        // Clean: the files follow the ref, as a `git merge --ff-only` would.
        git(s(&d), &["checkout", "-q", "--", "a.tsx"]).unwrap();
        std::fs::write(d.join("untracked.tsx"), "u").unwrap();
        land(s(&d), "dedup/session-1", "main").unwrap();
        assert_eq!(rev(&d, "HEAD"), rev(&d, "refs/heads/dedup/session-1"));
        assert_eq!(std::fs::read_to_string(d.join("a.tsx")).unwrap(), "a2");
        assert_eq!(std::fs::read_to_string(d.join("untracked.tsx")).unwrap(), "u");
        rm(&[&d]);
    }

    #[test]
    fn land_refuses_a_target_checked_out_in_another_worktree() {
        let d = repo_with_session("land-wt");
        let other = dir("land-wt-other");
        std::fs::remove_dir_all(&other).unwrap();
        git(s(&d), &["worktree", "add", "-q", s(&other), "main"]).unwrap();
        let main = rev(&d, "refs/heads/main");

        let st = sync_status(s(&d));
        let t = st.targets.iter().find(|t| t.name == "main").unwrap();
        assert!(t.checked_out_at.is_some() && !t.checked_out_here);

        let err = land(s(&d), "dedup/session-1", "main").unwrap_err();
        assert!(err.contains("another worktree"), "{err}");
        assert_eq!(rev(&d, "refs/heads/main"), main);
        rm(&[&d, &other]);
    }

    #[test]
    fn land_refuses_on_a_detached_head_and_without_git() {
        let d = repo_with_session("land-detached");
        git(s(&d), &["checkout", "-q", "--detach"]).unwrap();
        let main = rev(&d, "refs/heads/main");
        let err = land(s(&d), "dedup/session-1", "main").unwrap_err();
        assert!(err.contains("detached"), "{err}");
        assert_eq!(rev(&d, "refs/heads/main"), main);

        let plain = dir("land-norepo");
        let err = land(s(&plain), "dedup/session-1", "main").unwrap_err();
        assert!(err.contains("not a git repository"), "{err}");
        rm(&[&d, &plain]);
    }

    #[test]
    fn land_only_moves_a_session_onto_a_real_branch_of_the_users() {
        let d = repo_with_session("land-names");
        git(s(&d), &["branch", "dedup/session-2", "main"]).unwrap();
        git(s(&d), &["branch", "feature", "main"]).unwrap();
        // Source must be a session branch.
        assert!(land(s(&d), "feature", "main").unwrap_err().contains("not a dedup session"));
        assert!(land(s(&d), "dedup/session-9", "main").is_err());
        // Target must be the user's, and must exist.
        assert!(land(s(&d), "dedup/session-1", "dedup/session-2").is_err());
        assert!(land(s(&d), "dedup/session-1", "nope").unwrap_err().contains("nope"));
        for bad in ["--force", "+main", "main:feature", ""] {
            assert!(land(s(&d), "dedup/session-1", bad).is_err(), "{bad}");
        }
        rm(&[&d]);
    }
}
