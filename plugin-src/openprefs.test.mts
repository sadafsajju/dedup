// When the compatibility card is shown. Run: pnpm test:openprefs
//
// This decides whether a safety affordance appears, so it is worth pinning
// precisely. The card carries a verdict and two gates — the dirty-tree
// acknowledgement (FR-1.5) and the custom dev command — and the rule is that
// it appears whenever it has something the user has not already seen and
// agreed to. Skipping it in the wrong case silently drops a gate; showing it
// in every case trains people to click through it, which drops the gate just
// as effectively while looking responsible.
import assert from "node:assert/strict";
import {
  fingerprintOf,
  forgetOpen,
  prefFor,
  reasonToShowCard,
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
  hasTailwind: true,
  hasTypescript: true,
  hasGit: true,
  devScript: "vite",
  support: "full",
  summary: "Vite + Tailwind + TS + pnpm — fully supported",
  warnings: [],
  ...over,
});

const clean: GitStatus = { isRepo: true, isDirty: false, branch: "main", changedFiles: 0 };
const dirty: GitStatus = { isRepo: true, isDirty: true, branch: "main", changedFiles: 3 };

// --- when the card appears ---------------------------------------------------

test("the first open always shows the card", () => {
  assert.equal(reasonToShowCard(project(), clean), "first-open");
});

test("a second open of an unchanged project goes straight in", () => {
  const p = project();
  rememberOpen(p, clean, null);
  assert.equal(reasonToShowCard(p, clean), null);
});

test("an unsupported project always shows the card, however often it is opened", () => {
  // It cannot be opened at all without the card's custom-command escape
  // hatch, so skipping it would be a dead end.
  const p = project({ support: "unsupported", devScript: null });
  rememberOpen(p, clean, "vite --port 3000");
  assert.equal(reasonToShowCard(p, clean), "unsupported");
});

test("a changed verdict brings the card back", () => {
  const before = project();
  rememberOpen(before, clean, null);
  for (const change of [
    { hasTailwind: false },
    { hasTypescript: false },
    { hasGit: false },
    { framework: "next" as const },
    { support: "partial" as const },
    { devScript: "vite --host" },
    { warnings: ["Next.js: element inspection needs one line in next.config.ts."] },
  ]) {
    assert.equal(
      reasonToShowCard(project(change), clean),
      "verdict-changed",
      `a change to ${JSON.stringify(change)} must be shown`,
    );
  }
});

// --- the dirty-tree gate (FR-1.5) -------------------------------------------

test("a dirty tree shows the card until it has been acknowledged once", () => {
  const p = project();
  // Opened while clean: the acknowledgement was never asked for.
  rememberOpen(p, clean, null);
  assert.equal(reasonToShowCard(p, dirty), "needs-ack");

  // Acknowledged now.
  rememberOpen(p, dirty, null);
  assert.equal(reasonToShowCard(p, dirty), null);
});

test("an acknowledgement survives the tree going clean and dirty again", () => {
  // The arrangement the user agreed to — dedup branches and commits only its
  // own files — does not change when the tree is dirty again next week.
  const p = project();
  rememberOpen(p, dirty, null);
  assert.equal(reasonToShowCard(p, clean), null);
  assert.equal(reasonToShowCard(p, dirty), null);
});

test("a non-repo never asks for the acknowledgement", () => {
  const p = project({ hasGit: false });
  rememberOpen(p, clean, null);
  const noRepo: GitStatus = { isRepo: false, isDirty: false, branch: null, changedFiles: 0 };
  assert.equal(reasonToShowCard(p, noRepo), null);
});

// --- what is carried forward -------------------------------------------------

test("the custom dev command survives a skipped card", () => {
  // It is only settable on the card, so forgetting it would silently drop the
  // project back to its own dev script.
  const p = project();
  rememberOpen(p, clean, "vite --port 4000");
  assert.equal(reasonToShowCard(p, clean), null);
  assert.equal(prefFor(p.root)?.customCommand, "vite --port 4000");
});

test("removing a project forgets it entirely", () => {
  const p = project();
  rememberOpen(p, dirty, "vite --port 4000");
  forgetOpen(p.root);
  assert.equal(prefFor(p.root), null);
  assert.equal(reasonToShowCard(p, clean), "first-open", "re-adding is a first open");
});

test("two projects are remembered independently", () => {
  const a = project({ root: "/x/a" });
  const b = project({ root: "/x/b" });
  rememberOpen(a, clean, "a-cmd");
  assert.equal(reasonToShowCard(a, clean), null);
  assert.equal(reasonToShowCard(b, clean), "first-open");
  assert.equal(prefFor("/x/a")?.customCommand, "a-cmd");
});

// --- robustness --------------------------------------------------------------

test("corrupt storage shows the card rather than failing to open", () => {
  store.set("dedup:opened", "{not json");
  assert.equal(reasonToShowCard(project(), clean), "first-open");
  assert.doesNotThrow(() => rememberOpen(project(), clean, null));
});

test("the fingerprint is stable for the same verdict", () => {
  assert.equal(fingerprintOf(project()), fingerprintOf(project()));
  assert.notEqual(fingerprintOf(project()), fingerprintOf(project({ hasGit: false })));
});

console.log(`\n${passed} passed`);
