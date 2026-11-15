// The Commit tab's logic, with no React and no git in it: what the one list
// shows, what a save is called, and — the part worth pinning — whether a push
// or a landing may be offered and, when not, the sentence that says why.
//
// Pushing and landing are the two things dedup does outside its session
// branch. Rust refuses the unsafe cases whatever the UI does (`publish.rs`);
// this is the same rules read from `SyncStatus` so the button is disabled with
// its reason *before* the click, rather than failing after it.
import { isValueAction } from "./types";
import type {
  BranchSync,
  EditAction,
  HistoryEntry,
  PendingEdit,
  SyncStatus,
} from "./types";

export interface StagedRow {
  /** Index into the staged program — what `revertAction` takes. */
  index: number;
  action: EditAction;
}

export interface ProposalRow {
  summary: string;
  files: string[];
  /** On disk and on the canvas right now (false: the preview write failed). */
  previewing: boolean;
}

export interface CommitRow {
  hash: string;
  /** The subject without dedup's own prefix. */
  title: string;
  when: string;
  files: string[];
  isUndo: boolean;
  /** null when there is no remote to have pushed to. */
  pushed: boolean | null;
  /** Why this commit can't be undone right now, if it can't. */
  undoBlocked: string | null;
}

export interface ChangeList {
  staged: StagedRow[];
  /** Distinct files the staged edits will write. */
  stagedFiles: string[];
  proposal: ProposalRow | null;
  commits: CommitRow[];
}

const sameHash = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * Everything the tab lists, in the order it reads: not yet written, written
 * but not committed, committed. Three different states of "a change", which
 * used to live in three different places.
 */
export function buildChangeList(input: {
  actions: EditAction[];
  pendingEdit: PendingEdit | null;
  history: HistoryEntry[];
  sync: SyncStatus | null;
}): ChangeList {
  const { actions, pendingEdit, history, sync } = input;

  // A class scrubbed back to where it started is staged but not a change.
  const staged = actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => !isValueAction(action) || action.before !== action.after);

  const proposalFiles = pendingEdit
    ? [...pendingEdit.files.map((f) => f.file), ...pendingEdit.assets.map((a) => a.file)]
    : [];
  const previewed = new Set(pendingEdit?.previewing ? proposalFiles : []);

  const pushedState = (hash: string): boolean | null => {
    if (!sync?.remote) return null;
    // Never pushed: every commit is unpushed.
    if (sync.unpushed === null) return false;
    return !sync.unpushed.some((h) => sameHash(h, hash));
  };

  return {
    staged,
    stagedFiles: [...new Set(staged.map((r) => r.action.target.file))],
    proposal: pendingEdit
      ? { summary: pendingEdit.summary, files: proposalFiles, previewing: pendingEdit.previewing }
      : null,
    commits: history.map((h) => {
      // Undo restores the commit's files to how they were before it — which
      // would overwrite a preview sitting in one of them, and commit the
      // result. The preview has to be decided first.
      const clash = h.files.find((f) => previewed.has(f));
      return {
        hash: h.hash,
        title: h.subject.replace(/^dedup:\s*/, ""),
        when: h.when,
        files: h.files,
        isUndo: /^dedup:\s*undo\b/.test(h.subject),
        pushed: pushedState(h.hash),
        undoBlocked: clash
          ? `${clash} has an AI preview in it — keep or discard that first.`
          : null,
      };
    }),
  };
}

/**
 * The file that stops a save because a chat preview is sitting in it, if any.
 *
 * A save commits whole files (`git commit -- <path>`), and a preview is
 * uncommitted content in a file on purpose. Saving a staged edit to the same
 * file would commit the preview along with it — an AI edit landing in history
 * without ever having been accepted. So the preview is decided first.
 */
export function previewClash(files: string[], pendingEdit: PendingEdit | null): string | null {
  if (!pendingEdit?.previewing) return null;
  const previewed = new Set([
    ...pendingEdit.files.map((f) => f.file),
    ...pendingEdit.assets.map((a) => a.file),
  ]);
  return files.find((f) => previewed.has(f)) ?? null;
}

export const previewClashMessage = (file: string) =>
  `${file} has an AI preview in it. Keep or discard the preview first — saving now would commit it too.`;

/**
 * The commit message for a save. Always `dedup: …`: the prefix is how the
 * history (and its undo) tells dedup's commits from the user's own, so a
 * message typed without it still gets it, and one typed with it doesn't get
 * two. Empty falls back to the generated description. Lines after the first
 * become the body.
 */
export function commitMessage(draft: string | null | undefined, fallback: string): string {
  const lines = (draft ?? "").replace(/\r/g, "").split("\n");
  const subject = (lines[0] ?? "").trim().replace(/^dedup:\s*/i, "").trim();
  if (!subject) return `dedup: ${fallback}`;
  const body = lines.slice(1).join("\n").trim();
  return body ? `dedup: ${subject}\n\n${body}` : `dedup: ${subject}`;
}

/** A button's state: may it be pressed, and if not, why. */
export interface StepState {
  enabled: boolean;
  /** Shown beside a disabled button, or as a caveat under an enabled one. */
  reason: string | null;
  /** Commits involved; null when unknown (a branch the remote has never had). */
  count: number | null;
}

const blocked = (reason: string, count: number | null = 0): StepState => ({
  enabled: false,
  reason,
  count,
});

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function repoBlock(sync: SyncStatus | null): string | null {
  if (!sync) return "Reading the repository…";
  if (!sync.isRepo) return "No git here — set it up to commit, push or move commits.";
  if (sync.detached || !sync.branch)
    return "HEAD is detached — the project isn't on a branch. Switch to one with your own git tools.";
  return null;
}

/** May `branch` be pushed to `remote`? */
export function pushState(
  sync: SyncStatus | null,
  branch: string,
  remote: string | null,
): StepState {
  const repo = repoBlock(sync);
  if (repo || !sync) return blocked(repo ?? "");
  if (sync.remotes.length === 0)
    return blocked("This repository has no remote. Add one in a terminal: git remote add origin <url>");
  if (!remote || !sync.remotes.some((r) => r.name === remote)) return blocked("Pick a remote.");

  // Counts are known against the default remote only (that is what the status
  // compared with). For another remote the push is still allowed; the number
  // just isn't claimed.
  const known = remote === sync.remote;
  if (branch === sync.branch) {
    if (!known) return { enabled: true, reason: null, count: null };
    if (sync.remoteAhead > 0)
      return blocked(
        `${remote} has ${plural(sync.remoteAhead, "commit")} on this branch that you don't. dedup never force-pushes — pull them first.`,
        sync.unpushed?.length ?? null,
      );
    if (sync.unpushed === null)
      return { enabled: true, reason: `Not on ${remote} yet.`, count: null };
    if (sync.unpushed.length === 0) return blocked(`Everything here is already on ${remote}.`);
    return { enabled: true, reason: null, count: sync.unpushed.length };
  }

  const target = sync.targets.find((t) => t.name === branch);
  if (!target) return blocked(`There is no local branch called ${branch}.`);
  if (!known) return { enabled: true, reason: null, count: null };
  if (target.unpushed === null)
    return { enabled: true, reason: `Not on ${remote} yet.`, count: null };
  if (target.unpushed === 0) return blocked(`${branch} is already on ${remote}.`);
  return { enabled: true, reason: null, count: target.unpushed };
}

/** May the session's commits be brought onto `targetName` (fast-forward)? */
export function landState(sync: SyncStatus | null, targetName: string): StepState {
  const repo = repoBlock(sync);
  if (repo || !sync) return blocked(repo ?? "");
  if (!sync.onSession)
    return blocked("Nothing to bring: dedup's saves go on a session branch, and this isn't one.");
  const t = sync.targets.find((x) => x.name === targetName);
  if (!t) return blocked(`There is no local branch called ${targetName}.`);
  if (t.ahead === 0) return blocked(`${t.name} already has every commit from this session.`);
  if (t.behind > 0)
    return blocked(
      `${t.name} has ${plural(t.behind, "commit")} this session doesn't, so it can't be fast-forwarded. Merge with your own git tools, or push the session branch and open a pull request.`,
      t.ahead,
    );
  if (t.checkedOutAt && !t.checkedOutHere)
    return blocked(`${t.name} is checked out in another worktree (${t.checkedOutAt}).`, t.ahead);
  return { enabled: true, reason: null, count: t.ahead };
}

/**
 * What a landing brings, in words. A session cut from a feature branch carries
 * that branch's commits too, and "3 commits" would hide that two of them are
 * not dedup's — on main, that is the difference that matters.
 */
export function landSummary(t: BranchSync): string {
  const others = t.ahead - t.dedupAhead;
  if (others <= 0) return plural(t.ahead, "dedup save");
  if (t.dedupAhead === 0) return `${plural(t.ahead, "commit")}, none of them dedup saves`;
  return `${plural(t.ahead, "commit")}: ${plural(t.dedupAhead, "dedup save")} and ${others} from the branch this session started on`;
}

/**
 * The target to preselect: the branch the session most plausibly started
 * from — the one a fast-forward exists for that is the fewest commits behind.
 * Ties, and the case where nothing can be fast-forwarded, go to the trunk.
 * Only a preselection: nothing happens until the user confirms it by name.
 */
export function pickTarget(targets: BranchSync[], preferred?: string | null): string | null {
  if (preferred && targets.some((t) => t.name === preferred)) return preferred;
  const trunk = (n: string) => (n === "main" ? 0 : n === "master" ? 1 : 2);
  const rank = (t: BranchSync) => (t.behind === 0 && t.ahead > 0 ? 0 : 1);
  const sorted = [...targets].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? a.ahead - b.ahead : 0) ||
      trunk(a.name) - trunk(b.name) ||
      a.name.localeCompare(b.name),
  );
  return sorted[0]?.name ?? null;
}
