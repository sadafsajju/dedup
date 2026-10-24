// Tests for parked canvas pieces (src/lib/parking).
// Run: pnpm test:parking
//
// A parked piece is the only copy of an element once its removal is saved, so
// every transition that could lose one — or keep one that should be gone — is
// pinned here.
import assert from "node:assert/strict";
import {
  artboardAt,
  frameToScreen,
  persistable,
  reconcileParked,
  sanitizeParked,
  screenToFrame,
  screenToSurface,
  settleParked,
  visibleParked,
} from "../src/lib/parking.ts";
import type { ParkedPiece } from "../src/lib/parking.ts";
import { redoStep, undoStep } from "../src/lib/undo.ts";
import type { EditAction } from "../src/lib/types.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    process.exitCode = 1;
    console.error(`FAIL — ${name}\n${e}`);
  }
}

const piece = (over: Partial<ParkedPiece> = {}): ParkedPiece => ({
  id: "p1",
  x: 1600,
  y: 200,
  width: 320,
  height: 120,
  clip: {
    snippet: "<section>hi</section>",
    lang: "jsx",
    preview: "<section>hi</section>",
    label: "Hero · section",
    file: "src/Home.tsx",
    refs: [],
  },
  picture: "data:image/png;base64,AAAA",
  fromRoute: "/",
  removal: null,
  placement: null,
  createdAt: 1,
  ...over,
});

const remove = (dedupId: string): EditAction => ({
  kind: "remove",
  target: { dedupId, file: "src/Home.tsx", index: 3 },
  label: "Hero · section",
});
const insert = (id: string): EditAction =>
  ({
    kind: "insert",
    id,
    target: { dedupId: "src/Pricing.tsx@4", file: "src/Pricing.tsx", index: 4 },
    position: "after",
    snippet: "<section>hi</section>",
    lang: "jsx",
    preview: "<section>hi</section>",
    label: "Hero · section",
  }) as EditAction;

test("while its removal is staged, a dragged-out piece stays parked", () => {
  const parked = [piece({ removal: "src/Home.tsx@3" })];
  assert.equal(reconcileParked(parked, [remove("src/Home.tsx@3")]), parked, "unchanged, by identity");
});

test("undoing the removal takes the piece off the canvas — it is back in the page", () => {
  const parked = [piece({ removal: "src/Home.tsx@3" })];
  assert.deepEqual(reconcileParked(parked, []), []);
});

test("undoing a placement puts the card back", () => {
  const parked = [piece({ placement: "pending:a" })];
  assert.deepEqual(visibleParked(parked), [], "hidden while placed");
  const next = reconcileParked(parked, []);
  assert.equal(next[0].placement, null);
  assert.equal(visibleParked(next).length, 1, "drawn again");
});

test("a saved piece doesn't depend on anything staged", () => {
  const parked = [piece()];
  assert.equal(reconcileParked(parked, []), parked);
});

test("a save keeps what was parked and finishes what was placed", () => {
  const settled = settleParked([
    piece({ id: "out", removal: "src/Home.tsx@3" }),
    piece({ id: "placed", placement: "pending:a" }),
    piece({ id: "kept" }),
  ]);
  assert.deepEqual(settled.map((p) => [p.id, p.removal, p.placement]), [
    ["out", null, null],
    ["kept", null, null],
  ]);
  // Settled in the same update that empties the program: reconciling the
  // result against nothing staged must keep every piece.
  assert.equal(reconcileParked(settled, []).length, 2);
});

test("the order matters: emptying the program *before* settling would lose the piece", () => {
  const parked = [piece({ removal: "src/Home.tsx@3" })];
  assert.deepEqual(reconcileParked(parked, []), [], "which is why save settles first");
  assert.equal(reconcileParked(settleParked(parked), []).length, 1);
});

test("only what a restart can keep goes to disk", () => {
  const out = persistable([
    piece({ id: "unsaved", removal: "src/Home.tsx@3" }), // still in its page
    piece({ id: "placing", placement: "pending:a" }), // the insert won't survive
    piece({ id: "kept" }),
  ]);
  assert.deepEqual(out.map((p) => [p.id, p.placement]), [
    ["placing", null],
    ["kept", null],
  ]);
});

test("pieces read back from disk are checked, and always settled", () => {
  const good = { ...piece({ removal: "x", placement: "y" }) };
  const loaded = sanitizeParked([good, { id: 3 }, null, { ...good, clip: { ...good.clip, lang: "vue" } }]);
  assert.equal(loaded.length, 1, "malformed entries are dropped, not drawn");
  assert.equal(loaded[0].removal, null);
  assert.equal(loaded[0].placement, null);
  assert.equal(sanitizeParked({ not: "a list" }).length, 0);
  assert.equal(
    sanitizeParked([{ ...good, picture: "javascript:alert(1)" }])[0].picture,
    null,
    "a picture is an image data URL or nothing",
  );
});

test("frame, screen and surface coordinates round-trip at any zoom", () => {
  // A 1440px-wide frame drawn at 0.5 zoom, 100px from the window's left.
  const frame = { left: 100, top: 50, width: 720, height: 3200 };
  const onScreen = frameToScreen(frame, 1440, { x: 1500, y: 40 });
  assert.deepEqual(onScreen, { x: 850, y: 70 }, "past the frame's right edge");
  assert.deepEqual(screenToFrame(frame, 1440, onScreen), { x: 1500, y: 40 });
  // The canvas container at (0, 48), panned by (100, 50) and zoomed 0.5.
  assert.deepEqual(screenToSurface({ x: 0, y: 48 }, { x: 100, y: 50 }, 0.5, { x: 850, y: 70 }), {
    x: 1500,
    y: -56,
  });
});

test("the artboard under a point, or none", () => {
  const boards = [
    { route: "/", box: { left: 0, top: 0, width: 100, height: 100 } },
    { route: "/pricing", box: { left: 200, top: 0, width: 100, height: 100 } },
  ];
  assert.equal(artboardAt({ x: 250, y: 50 }, boards), "/pricing");
  assert.equal(artboardAt({ x: 150, y: 50 }, boards), null, "the gap between them is canvas");
  assert.equal(artboardAt({ x: 100, y: 50 }, boards), null, "the right edge is outside");
});

// --- one gesture, one undo -------------------------------------------------

const cls = (n: number): EditAction =>
  ({
    kind: "class",
    target: { dedupId: `src/Home.tsx@${n}`, file: "src/Home.tsx", index: n },
    before: "p-2",
    after: "p-4",
  }) as EditAction;
const withGesture = (a: EditAction, gesture: string): EditAction => ({ ...a, gesture }) as EditAction;

test("a move between artboards undoes and redoes as one step", () => {
  const earlier = cls(1);
  const paste = withGesture(insert("pending:m"), "g1");
  const cut = withGesture(remove("src/Home.tsx@3"), "g1");
  const program = [earlier, paste, cut];

  const undone = undoStep(program, [])!;
  assert.deepEqual(undone.actions, [earlier], "both halves go together");
  const redone = redoStep(undone.actions, undone.redo)!;
  assert.deepEqual(redone.actions, program, "and come back in their original order");
  assert.deepEqual(redone.redo, []);
});

test("ordinary edits still undo one at a time", () => {
  const program = [cls(1), cls(2), remove("src/Home.tsx@3")];
  const once = undoStep(program, [])!;
  assert.deepEqual(once.actions, program.slice(0, 2));
  const twice = undoStep(once.actions, once.redo)!;
  assert.deepEqual(twice.actions, program.slice(0, 1));
  assert.deepEqual(redoStep(twice.actions, twice.redo)!.actions, program.slice(0, 2));
  assert.equal(undoStep([], []), null, "nothing to undo");
  assert.equal(redoStep([], []), null, "nothing to redo");
});

test("two separate moves are two steps, even back to back", () => {
  const a = [withGesture(insert("pending:a"), "g1"), withGesture(remove("src/Home.tsx@3"), "g1")];
  const b = [withGesture(insert("pending:b"), "g2"), withGesture(remove("src/Home.tsx@5"), "g2")];
  const undone = undoStep([...a, ...b], [])!;
  assert.deepEqual(undone.actions, a);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
