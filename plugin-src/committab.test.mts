// The Commit tab's logic (src/lib/commitTab).
// Run: pnpm test:commit
//
// The tab is where dedup first reaches outside its session branch: a push,
// and a fast-forward of the user's own branch. Rust refuses the unsafe cases
// regardless (publish.rs has those tests). What is pinned here is the half the
// user actually sees — which buttons are offered, and the sentence beside a
// disabled one — plus the one list that replaced three separate panels.
import assert from "node:assert/strict";
import {
  buildChangeList,
  commitMessage,
  landState,
  landSummary,
  pickTarget,
  previewClash,
  pushState,
} from "../src/lib/commitTab.ts";
import type {
  BranchSync,
  EditAction,
  HistoryEntry,
  PendingEdit,
  SyncStatus,
} from "../src/lib/types.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const cls = (file: string, before: string, after: string): EditAction =>
  ({
    kind: "class",
    target: { file, dedupId: `${file}@3` },
    before,
    after,
    component: "Hero",
  }) as EditAction;

const entry = (hash: string, subject: string, files: string[]): HistoryEntry => ({
  hash,
  subject,
  when: "2 minutes ago",
  files,
});

const branch = (name: string, over: Partial<BranchSync> = {}): BranchSync => ({
  name,
  ahead: 2,
  dedupAhead: 2,
  behind: 0,
  checkedOutAt: null,
  checkedOutHere: false,
  unpushed: 0,
  ...over,
});

const sync = (over: Partial<SyncStatus> = {}): SyncStatus => ({
  isRepo: true,
  branch: "dedup/session-1",
  detached: false,
  onSession: true,
  remotes: [{ name: "origin", url: "git@example.test:a/b.git" }],
  remote: "origin",
  unpushed: ["aaa1111"],
  remoteAhead: 0,
  targets: [branch("main")],
  ...over,
});

const preview = (over: Partial<PendingEdit> = {}): PendingEdit =>
  ({
    messageId: "m1",
    summary: "make the hero taller",
    files: [{ file: "src/Hero.tsx", before: "a", after: "b" }],
    assets: [{ file: "public/hero.png", source: "/tmp/x.png", agent: "codex" }],
    previewing: true,
    ...over,
  }) as PendingEdit;

console.log("the list");

test("staged edits, the proposal and the commits come back as one list", () => {
  const list = buildChangeList({
    actions: [cls("src/A.tsx", "p-4", "p-6"), cls("src/A.tsx", "m-1", "m-2"), cls("src/B.tsx", "x", "y")],
    pendingEdit: preview(),
    history: [entry("bbb2222", "dedup: add Card", ["src/Card.tsx"])],
    sync: sync(),
  });
  assert.equal(list.staged.length, 3);
  assert.deepEqual(list.stagedFiles, ["src/A.tsx", "src/B.tsx"]);
  assert.deepEqual(list.proposal, {
    summary: "make the hero taller",
    // The generated image is part of the proposal, not a stray file.
    files: ["src/Hero.tsx", "public/hero.png"],
    previewing: true,
  });
  assert.equal(list.commits.length, 1);
  assert.equal(list.commits[0].title, "add Card");
});

test("a class scrubbed back to where it started is not a change", () => {
  const list = buildChangeList({
    actions: [cls("src/A.tsx", "p-4", "p-4"), cls("src/B.tsx", "p-4", "p-6")],
    pendingEdit: null,
    history: [],
    sync: null,
  });
  assert.equal(list.staged.length, 1);
  // The index is the one the store's revertAction takes — into the full
  // program, not into the filtered list.
  assert.equal(list.staged[0].index, 1);
  assert.deepEqual(list.stagedFiles, ["src/B.tsx"]);
  assert.equal(list.proposal, null);
});

test("commits keep the order they were given (newest first) and know an undo", () => {
  const list = buildChangeList({
    actions: [],
    pendingEdit: null,
    history: [
      entry("ccc3333", "dedup: undo bbb2222 (add Card)", ["src/Card.tsx"]),
      entry("bbb2222", "dedup: add Card", ["src/Card.tsx"]),
    ],
    sync: sync(),
  });
  assert.deepEqual(list.commits.map((c) => c.hash), ["ccc3333", "bbb2222"]);
  assert.deepEqual(list.commits.map((c) => c.isUndo), [true, false]);
});

test("pushed is three-valued: yes, no, and no remote to ask", () => {
  const history = [entry("aaa1111", "dedup: new", ["a"]), entry("bbb2222", "dedup: old", ["b"])];
  const of = (s: SyncStatus | null) =>
    buildChangeList({ actions: [], pendingEdit: null, history, sync: s }).commits.map((c) => c.pushed);
  assert.deepEqual(of(sync()), [false, true]);
  // Never pushed: every commit is unpushed, not "zero unpushed".
  assert.deepEqual(of(sync({ unpushed: null })), [false, false]);
  assert.deepEqual(of(sync({ remote: null, remotes: [], unpushed: null })), [null, null]);
  assert.deepEqual(of(null), [null, null]);
  // git abbreviates to different lengths in different places.
  assert.deepEqual(of(sync({ unpushed: ["aaa11112f"] })), [false, true]);
});

test("a commit whose file holds a live preview can't be undone until that is decided", () => {
  const history = [
    entry("aaa1111", "dedup: restyle hero", ["src/Hero.tsx"]),
    entry("bbb2222", "dedup: add Card", ["src/Card.tsx"]),
  ];
  const live = buildChangeList({ actions: [], pendingEdit: preview(), history, sync: sync() });
  assert.match(live.commits[0].undoBlocked ?? "", /src\/Hero\.tsx/);
  assert.equal(live.commits[1].undoBlocked, null);
  // Not on disk → nothing for the undo to overwrite.
  const failed = buildChangeList({
    actions: [],
    pendingEdit: preview({ previewing: false }),
    history,
    sync: sync(),
  });
  assert.equal(failed.commits[0].undoBlocked, null);
});

test("a save that would commit a live preview is caught by file", () => {
  assert.equal(previewClash(["src/A.tsx", "src/Hero.tsx"], preview()), "src/Hero.tsx");
  // The generated image counts: it is part of the uncommitted proposal.
  assert.equal(previewClash(["public/hero.png"], preview()), "public/hero.png");
  assert.equal(previewClash(["src/A.tsx"], preview()), null);
  assert.equal(previewClash(["src/Hero.tsx"], preview({ previewing: false })), null);
  assert.equal(previewClash(["src/Hero.tsx"], null), null);
});

console.log("the message");

test("a typed message gets dedup's prefix exactly once", () => {
  assert.equal(commitMessage("Tighten the hero", "x"), "dedup: Tighten the hero");
  assert.equal(commitMessage("dedup: Tighten the hero", "x"), "dedup: Tighten the hero");
  assert.equal(commitMessage("  DEDUP:   Tighten  ", "x"), "dedup: Tighten");
});

test("an empty message falls back to the generated description", () => {
  for (const empty of ["", "   ", "\n\n", "dedup:", null, undefined]) {
    assert.equal(commitMessage(empty, "adjust classes on Hero"), "dedup: adjust classes on Hero");
  }
});

test("lines after the first become the body", () => {
  assert.equal(
    commitMessage("Tighten the hero\r\n\r\nIt wrapped at 390px.\n", "x"),
    "dedup: Tighten the hero\n\nIt wrapped at 390px.",
  );
});

console.log("push");

test("offered with the number of commits it would send", () => {
  assert.deepEqual(pushState(sync(), "dedup/session-1", "origin"), {
    enabled: true,
    reason: null,
    count: 1,
  });
});

test("a branch the remote has never had can be pushed, without claiming a count", () => {
  const s = pushState(sync({ unpushed: null }), "dedup/session-1", "origin");
  assert.equal(s.enabled, true);
  assert.equal(s.count, null);
});

test("refused with the reason: no git, detached, no remote, nothing to send", () => {
  const no = (s: SyncStatus | null, b = "dedup/session-1", r: string | null = "origin") => {
    const st = pushState(s, b, r);
    assert.equal(st.enabled, false);
    return st.reason ?? "";
  };
  assert.match(no(null), /Reading/);
  assert.match(no(sync({ isRepo: false, branch: null })), /No git/);
  assert.match(no(sync({ detached: true, branch: null })), /detached/);
  assert.match(no(sync({ remotes: [], remote: null, unpushed: null })), /no remote/);
  assert.match(no(sync({ unpushed: [] })), /already on origin/);
  assert.match(no(sync(), "dedup/session-1", null), /Pick a remote/);
  assert.match(no(sync(), "dedup/session-1", "upstream"), /Pick a remote/);
  assert.match(no(sync(), "nope"), /no local branch/);
});

test("refused when the remote has moved on — never offered as a force", () => {
  const st = pushState(sync({ remoteAhead: 2 }), "dedup/session-1", "origin");
  assert.equal(st.enabled, false);
  assert.match(st.reason ?? "", /never force-pushes/);
  assert.match(st.reason ?? "", /2 commits/);
});

test("the target branch is pushed by its own count, after a landing", () => {
  const before = sync({ targets: [branch("main", { ahead: 2, unpushed: 0 })] });
  assert.equal(pushState(before, "main", "origin").enabled, false);
  const after = sync({ targets: [branch("main", { ahead: 0, dedupAhead: 0, unpushed: 2 })] });
  assert.deepEqual(pushState(after, "main", "origin"), { enabled: true, reason: null, count: 2 });
});

test("a second remote can be pushed to, but no count is claimed for it", () => {
  const s = sync({
    remotes: [
      { name: "origin", url: "a" },
      { name: "fork", url: "b" },
    ],
    unpushed: [],
  });
  assert.equal(pushState(s, "dedup/session-1", "origin").enabled, false);
  assert.deepEqual(pushState(s, "dedup/session-1", "fork"), { enabled: true, reason: null, count: null });
});

console.log("land");

test("offered when the target can be fast-forwarded", () => {
  assert.deepEqual(landState(sync(), "main"), { enabled: true, reason: null, count: 2 });
});

test("the target checked out in this folder is allowed — Rust requires a clean tree", () => {
  const s = sync({ targets: [branch("main", { checkedOutAt: "/p", checkedOutHere: true })] });
  assert.equal(landState(s, "main").enabled, true);
});

test("refused with the reason: diverged, another worktree, nothing to bring, not a session", () => {
  const no = (s: SyncStatus | null, t = "main") => {
    const st = landState(s, t);
    assert.equal(st.enabled, false);
    return st.reason ?? "";
  };
  assert.match(no(sync({ targets: [branch("main", { behind: 3 })] })), /3 commits.*can't be fast-forwarded/);
  assert.match(
    no(sync({ targets: [branch("main", { checkedOutAt: "/other", checkedOutHere: false })] })),
    /another worktree \(\/other\)/,
  );
  assert.match(no(sync({ targets: [branch("main", { ahead: 0 })] })), /already has every commit/);
  assert.match(no(sync({ onSession: false, branch: "feature" })), /session branch/);
  assert.match(no(sync({ detached: true, branch: null })), /detached/);
  assert.match(no(sync({ isRepo: false })), /No git/);
  assert.match(no(sync(), "nope"), /no local branch/);
});

test("the summary says when the commits are not all dedup's", () => {
  assert.equal(landSummary(branch("main", { ahead: 1, dedupAhead: 1 })), "1 dedup save");
  assert.equal(landSummary(branch("main", { ahead: 3, dedupAhead: 3 })), "3 dedup saves");
  assert.equal(
    landSummary(branch("main", { ahead: 5, dedupAhead: 3 })),
    "5 commits: 3 dedup saves and 2 from the branch this session started on",
  );
  assert.equal(landSummary(branch("main", { ahead: 2, dedupAhead: 0 })), "2 commits, none of them dedup saves");
});

console.log("the preselected target");

test("the branch the session started from wins over the trunk", () => {
  // Cut from `feature`: feature is 1 behind the session, main is 3.
  const targets = [branch("main", { ahead: 3, dedupAhead: 1 }), branch("feature", { ahead: 1, dedupAhead: 1 })];
  assert.equal(pickTarget(targets), "feature");
});

test("ties go to main, then master", () => {
  assert.equal(pickTarget([branch("zeta"), branch("master"), branch("main")]), "main");
  assert.equal(pickTarget([branch("zeta"), branch("master")]), "master");
});

test("a diverged branch is never preferred over one that can be fast-forwarded", () => {
  const targets = [branch("main", { behind: 1, ahead: 1 }), branch("feature", { ahead: 4 })];
  assert.equal(pickTarget(targets), "feature");
  // …but with nothing to fast-forward, the trunk is still the sensible default.
  assert.equal(pickTarget([branch("main", { behind: 1 }), branch("alpha", { behind: 1 })]), "main");
});

test("the user's own choice is kept while it still exists", () => {
  const targets = [branch("main"), branch("feature", { ahead: 1 })];
  assert.equal(pickTarget(targets, "main"), "main");
  assert.equal(pickTarget(targets, "gone"), "feature");
  assert.equal(pickTarget([]), null);
});

console.log(`\n${passed} passed`);
