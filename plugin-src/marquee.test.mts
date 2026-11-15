// Tests for multi-selection's two pure rules.
// Run: pnpm test:marquee
//
// `marqueeHits` (plugin-src/marquee.mjs) decides which elements a rectangle
// selects — it is bundled into the overlay, so this is the same code the
// canvas runs. `outermostOnly` / `toggleId` (src/lib/multiSelect) decide what
// the editor does with a selection once it has one.
import assert from "node:assert/strict";
// @ts-expect-error — a plain .mjs module with no declaration file.
import { marqueeHits, marqueeRect } from "./marquee.mjs";
import { countLabel, outermostOnly, toggleId } from "../src/lib/multiSelect.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.error(`  FAIL — ${name}\n${(e as Error).stack ?? e}`);
  }
}

// A page: a root holding a header and a section; the section holds two cards
// side by side, and the first card holds a title.
//
//   0 root     (0,0   1000x800)
//   1 header   (0,0   1000x100)
//   2 section  (0,100 1000x400)
//   3 cardA    (50,150  300x200)
//   4 titleA   (70,170  200x40)
//   5 cardB    (450,150 300x200)
const n = (parent: number, x: number, y: number, width: number, height: number) => ({
  parent,
  x,
  y,
  width,
  height,
});
const PAGE = [
  n(-1, 0, 0, 1000, 800),
  n(0, 0, 0, 1000, 100),
  n(0, 0, 100, 1000, 400),
  n(2, 50, 150, 300, 200),
  n(3, 70, 170, 200, 40),
  n(2, 450, 150, 300, 200),
];
const hits = (x0: number, y0: number, x1: number, y1: number) =>
  marqueeHits(PAGE, marqueeRect(x0, y0, x1, y1));

test("a rect is the same whichever corner the drag started from", () => {
  assert.deepEqual(marqueeRect(30, 40, 10, 5), { x: 10, y: 5, width: 20, height: 35 });
  assert.deepEqual(marqueeRect(10, 5, 30, 40), marqueeRect(30, 40, 10, 5));
});

test("a marquee across two siblings selects both, and not what is inside them", () => {
  // Starts in the section's padding, crosses card A (and its title) into B.
  assert.deepEqual(hits(20, 160, 500, 300), [3, 5]);
});

test("the container the drag started in is not selected for enclosing it", () => {
  // Entirely inside the section, touching only card B: the section and the
  // root both enclose the marquee and are looked through.
  assert.deepEqual(hits(420, 120, 480, 180), [5]);
});

test("a marquee inside one element reaches the elements inside that", () => {
  // Wholly within card A, over its title — the card encloses it.
  assert.deepEqual(hits(60, 160, 120, 200), [4]);
});

test("leaving the container selects at the container's level", () => {
  // From inside the section up into the header: the section no longer
  // encloses the marquee, so it is the section that is touched.
  assert.deepEqual(hits(500, 50, 600, 130), [1, 2]);
});

test("a small drag inside a leaf selects the leaf", () => {
  // Wholly within the title, which has nothing inside it to look through to.
  assert.deepEqual(hits(80, 175, 120, 195), [4]);
  // The header is a leaf too.
  assert.deepEqual(hits(400, 20, 500, 60), [1]);
});

test("a marquee over nothing but padding selects nothing", () => {
  assert.deepEqual(hits(800, 400, 900, 480), []);
  // Below everything except the root, which encloses it.
  assert.deepEqual(hits(100, 600, 200, 700), []);
});

test("touching edges is not touching", () => {
  // Ends exactly on card A's left edge.
  assert.deepEqual(hits(10, 160, 50, 300), []);
});

test("an element with no box is looked through, not skipped with its children", () => {
  // A `display: contents` wrapper: zero-sized, its child is very much there.
  const page = [n(-1, 0, 0, 1000, 800), n(0, 0, 0, 0, 0), n(1, 100, 100, 200, 50)];
  assert.deepEqual(marqueeHits(page, marqueeRect(50, 50, 150, 120)), [2]);
});

test("a child overflowing its parent can still be caught", () => {
  // The parent sits left of the marquee; its child hangs out to the right.
  const page = [n(-1, 0, 0, 1000, 800), n(0, 0, 0, 100, 100), n(1, 300, 20, 100, 50)];
  assert.deepEqual(marqueeHits(page, marqueeRect(280, 10, 350, 40)), [2]);
});

test("a marquee around the whole page selects its top level", () => {
  assert.deepEqual(hits(-10, -10, 1100, 900), [0]);
});

// --- the editor's side ------------------------------------------------------

const el = (id: string, ...ancestors: string[]) => ({
  dedupId: id,
  ancestry: [id, ...ancestors].map((dedupId) => ({ dedupId })),
});

test("an element inside another selected one is spoken for by its parent", () => {
  const card = el("a@3", "a@2", "a@0");
  const title = el("a@4", "a@3", "a@2", "a@0");
  const other = el("a@5", "a@2", "a@0");
  assert.deepEqual(
    outermostOnly([card, title, other]).map((e) => e.dedupId),
    ["a@3", "a@5"],
  );
  // Siblings are untouched, and so is their order.
  assert.deepEqual(outermostOnly([other, card]).map((e) => e.dedupId), ["a@5", "a@3"]);
});

test("the same element twice is one element", () => {
  const card = el("a@3", "a@0");
  assert.equal(outermostOnly([card, card]).length, 1);
});

test("shift-click adds an id, and takes it back out", () => {
  assert.deepEqual(toggleId(["a", "b"], "c"), ["a", "b", "c"]);
  assert.deepEqual(toggleId(["a", "b", "c"], "b"), ["a", "c"]);
  assert.deepEqual(toggleId(["a"], "a"), []);
});

test("a count reads as a count", () => {
  assert.equal(countLabel(1), "1 element");
  assert.equal(countLabel(3), "3 elements");
});

console.log(`\n${passed} multi-selection tests passed`);
