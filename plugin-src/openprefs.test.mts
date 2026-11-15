// When opening a project stops to ask something. Run: pnpm test:openprefs
//
// There is no compatibility verdict any more — every project opens. What is
// left are two questions only the user can answer: the command that starts a
// project dedup could not work out how to run, and the dirty-tree
// acknowledgement (FR-1.5). The rule is that the panel appears for exactly
// those and nothing else. Skipping it in the wrong case silently drops a
// gate; showing it in every case trains people to click through it, which
// drops the gate just as effectively while looking responsible.
import assert from "node:assert/strict";
import {
  defaultCommand,
  forgetOpen,
  prefFor,
  reasonToAsk,
  rememberOpen,
} from "../src/lib/openPrefs.ts";
import type { GitStatus, ProjectInfo } from "../src/lib/types.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    store.clear();
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${(e as Error).stack ?? (e as Error).message}`);
    process.exitCode = 1;
  }
}

// localStorage stand-in — the module is browser code.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const project = (over: Partial<ProjectInfo> = {}): ProjectInfo => ({
  root: "/x/app",
  name: "app",
  packageManager: "pnpm",
  framework: "vite",
  stack: "Vite",
  hasTailwind: true,
  hasTypescript: true,
  hasGit: true,
  isEmpty: false,
  staticDir: null,
  devScript: "vite",
  devScriptName: "dev",
  runCommand: null,
  runnable: true,
  summary: "Vite + Tailwind + TS + pnpm",
  notes: [],
  ...over,
});

const clean: GitStatus = { isRepo: true, isDirty: false, branch: "main", changedFiles: 0 };
const dirty: GitStatus = { isRepo: true, isDirty: true, branch: "main", changedFiles: 3 };

// --- when opening stops to ask ----------------------------------------------

test("a first open goes straight in — there is no verdict to deliver", () => {
  assert.equal(reasonToAsk(project(), clean), null);
});

test("no kind of project is held at the door for what it is", () => {
  // Each of these used to be "partially supported" or "unsupported" and got
  // a card. None of them is a question.
  for (const p of [
    project({ hasTailwind: false }),
    project({ hasTypescript: false }),
    project({ hasGit: false }),
    project({ framework: "next", stack: "Next.js" }),
    project({ framework: "unknown", stack: "Astro", devScript: "astro dev" }),
    project({ framework: "unknown", stack: "Django", devScript: null, devScriptName: null, runCommand: "python3 manage.py runserver" }),
    project({ notes: ["Next.js: element inspection needs one line in next.config.ts."] }),
  ]) {
    assert.equal(reasonToAsk(p, clean), null, `${p.stack} must open`);
  }
});

test("a project dedup cannot start is asked for a command, once", () => {
  const p = project({ framework: "unknown", stack: "Project", devScript: null, devScriptName: null, runnable: false });
  assert.equal(reasonToAsk(p, clean), "needs-command");
  // Given one, it is remembered — the next open has nothing left to ask.
  rememberOpen(p, clean, "go run .");
  assert.equal(reasonToAsk(p, clean), null);
  assert.equal(prefFor(p.root)?.customCommand, "go run .");
});

test("a changed project is not a reason to ask again", () => {
  const before = project();
  rememberOpen(before, clean, null);
  for (const change of [
    { hasTailwind: false },
    { hasGit: false },
    { framework: "next" as const },
    { devScript: "vite --host" },
  ]) {
    assert.equal(reasonToAsk(project(change), clean), null);
  }
});

// --- the dirty-tree gate (FR-1.5) -------------------------------------------

test("a dirty tree shows the card until it has been acknowledged once", () => {
  const p = project();
  // Opened while clean: the acknowledgement was never asked for.
  rememberOpen(p, clean, null);
  assert.equal(reasonToAsk(p, dirty), "needs-ack");

  // Acknowledged now.
  rememberOpen(p, dirty, null);
  assert.equal(reasonToAsk(p, dirty), null);
});

test("an acknowledgement survives the tree going clean and dirty again", () => {
  // The arrangement the user agreed to — dedup branches and commits only its
  // own files — does not change when the tree is dirty again next week.
  const p = project();
  rememberOpen(p, dirty, null);
  assert.equal(reasonToAsk(p, clean), null);
  assert.equal(reasonToAsk(p, dirty), null);
});

test("a non-repo never asks for the acknowledgement", () => {
  const p = project({ hasGit: false });
  rememberOpen(p, clean, null);
  const noRepo: GitStatus = { isRepo: false, isDirty: false, branch: null, changedFiles: 0 };
  assert.equal(reasonToAsk(p, noRepo), null);
});

// --- what is carried forward -------------------------------------------------

test("the custom dev command survives a skipped card", () => {
  // It is only settable on the card, so forgetting it would silently drop the
  // project back to its own dev script.
  const p = project();
  rememberOpen(p, clean, "vite --port 4000");
  assert.equal(reasonToAsk(p, clean), null);
  assert.equal(prefFor(p.root)?.customCommand, "vite --port 4000");
});

test("removing a project forgets it entirely", () => {
  const p = project();
  rememberOpen(p, dirty, "vite --port 4000");
  forgetOpen(p.root);
  assert.equal(prefFor(p.root), null);
  // Re-adding is a first open: the acknowledgement is asked for again.
  assert.equal(reasonToAsk(p, dirty), "needs-ack");
});

test("two projects are remembered independently", () => {
  const a = project({ root: "/x/a" });
  const b = project({ root: "/x/b" });
  rememberOpen(a, clean, "a-cmd");
  assert.equal(reasonToAsk(a, clean), null);
  assert.equal(prefFor("/x/b"), null);
  assert.equal(prefFor("/x/a")?.customCommand, "a-cmd");
});

// --- robustness --------------------------------------------------------------

test("corrupt storage asks again rather than failing to open", () => {
  store.set("dedup:opened", "{not json");
  assert.equal(reasonToAsk(project(), dirty), "needs-ack");
  assert.doesNotThrow(() => rememberOpen(project(), clean, null));
});

test("a pref saved by the old card still counts", () => {
  // Entries written before the verdict was removed carry a fingerprint.
  // The command and the acknowledgement in them are still the user's.
  store.set(
    "dedup:opened",
    JSON.stringify({ "/x/app": { fingerprint: "[...]", customCommand: "vite --port 4000", ackedDirty: true } }),
  );
  assert.equal(reasonToAsk(project(), dirty), null);
  assert.equal(prefFor("/x/app")?.customCommand, "vite --port 4000");
});

// --- what the start command is called ----------------------------------------

test("the default command names what will actually run", () => {
  assert.equal(defaultCommand(project()), "pnpm run dev");
  assert.equal(defaultCommand(project({ devScriptName: "start", packageManager: "unknown" })), "npm run start");
  assert.equal(
    defaultCommand(project({ framework: "unknown", devScript: null, devScriptName: null, runCommand: "php artisan serve" })),
    "php artisan serve",
  );
  // dedup serves a static site itself: there is no command of theirs.
  assert.equal(defaultCommand(project({ framework: "static", devScript: null, devScriptName: null })), null);
  assert.equal(defaultCommand(project({ framework: "unknown", devScript: null, devScriptName: null, runnable: false })), null);
});

console.log(`\n${passed} passed`);
