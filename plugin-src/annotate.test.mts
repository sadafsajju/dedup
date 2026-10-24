// Canvas markup: the invariants that keep hand-drawn ink usable. Run:
// pnpm test:annotate
//
// Three of these are the reasons the module is shaped the way it is. The seed
// one is the whole argument for storing a seed at all: rough.js re-randomises
// per call, so without it the same mark redrawn on the next pan is a different
// mark, and a sketch layer that crawls while you scroll is unusable. The
// storage ones are the same bargain the remembered canvas makes — dedup's own
// blob is still re-validated, because a NaN in a point is a path attribute
// that silently draws nothing.
import assert from "node:assert/strict";
import {
  MAX_ANNOTATIONS,
  MAX_NOTE,
  MAX_PEN_POINTS,
  PENS,
  annotationNotes,
  appendPoint,
  arrowHead,
  isDrawable,
  loadAnnotations,
  makeAnnotation,
  pathsFor,
  rectOf,
  saveAnnotations,
  type Annotation,
} from "../src/lib/annotate.ts";

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

const ROOT = "/x/app";
const mark = (over: Partial<Annotation> = {}): Annotation => ({
  ...makeAnnotation("box", "/pricing", [{ x: 10, y: 20 }, { x: 90, y: 60 }], PENS[0]),
  ...over,
});

/** Write a blob straight to storage — a stale or hand-edited entry. */
function stored(value: unknown) {
  store.set(`dedup:marks:${ROOT}`, JSON.stringify(value));
}

// --- geometry is a pure function of the mark ---------------------------------

test("the same seed draws the same shape, every time", () => {
  const pts = [{ x: 0, y: 0 }, { x: 120, y: 80 }];
  const a = pathsFor("box", pts, 1234, PENS[0]);
  const b = pathsFor("box", pts, 1234, PENS[0]);
  assert.ok(a.length > 0);
  assert.deepEqual(a, b);
});

test("a different seed draws a different shape", () => {
  const pts = [{ x: 0, y: 0 }, { x: 120, y: 80 }];
  assert.notDeepEqual(
    pathsFor("box", pts, 1234, PENS[0]),
    pathsFor("box", pts, 5678, PENS[0]),
  );
});

test("every kind produces path data", () => {
  const pts = [{ x: 5, y: 5 }, { x: 60, y: 40 }, { x: 90, y: 10 }];
  for (const kind of ["box", "ellipse", "arrow", "pen"] as const) {
    const paths = pathsFor(kind, pts, 99, PENS[1]);
    assert.ok(paths.length > 0, `${kind} drew nothing`);
    for (const d of paths) {
      assert.ok(d.startsWith("M"), `${kind} path is not a path: ${d}`);
      assert.ok(!/NaN|Infinity/.test(d), `${kind} path has a non-finite: ${d}`);
    }
  }
});

test("an arrow carries a head, and a box does not", () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  assert.ok(
    pathsFor("arrow", pts, 7, PENS[0]).length >
      pathsFor("box", pts, 7, PENS[0]).length - 1,
  );
  const barbs = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.equal(barbs.length, 2);
  // Both barbs point back down the shaft, and away from it on either side.
  for (const [tip, end] of barbs) {
    assert.equal(tip.x, 100);
    assert.ok(end.x < 100);
  }
  assert.ok(barbs[0][1].y !== barbs[1][1].y);
});

test("a degenerate mark draws nothing at all", () => {
  assert.deepEqual(pathsFor("box", [{ x: 1, y: 1 }], 1, PENS[0]), []);
});

// --- what counts as a mark ---------------------------------------------------

test("a press that did not drag is not a shape", () => {
  assert.equal(isDrawable("box", [{ x: 10, y: 10 }, { x: 12, y: 11 }]), false);
  assert.equal(isDrawable("box", [{ x: 10, y: 10 }, { x: 40, y: 40 }]), true);
});

test("a rectangle is the same however it was dragged", () => {
  const a = rectOf([{ x: 90, y: 60 }, { x: 10, y: 20 }]);
  assert.deepEqual(a, { x: 10, y: 20, w: 80, h: 40 });
});

test("freehand drops points too close to the last, and stops at the cap", () => {
  const start = [{ x: 0, y: 0 }];
  assert.equal(appendPoint(start, { x: 1, y: 1 }), start, "kept a redundant point");
  assert.equal(appendPoint(start, { x: 10, y: 0 }).length, 2);
  const full = Array.from({ length: MAX_PEN_POINTS }, (_, i) => ({ x: i * 5, y: 0 }));
  assert.equal(appendPoint(full, { x: 9999, y: 0 }), full, "grew past the cap");
});

// --- what travels to the chat agent ------------------------------------------

test("only marks with words become prompt context", () => {
  const notes = annotationNotes([
    mark({ note: "  " }),
    mark({ note: "this button is the wrong grey" }),
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\/pricing/);
  assert.match(notes[0], /wrong grey/);
});

test("notes from pages that are not open stay out of the prompt", () => {
  const notes = annotationNotes(
    [mark({ note: "a" }), mark({ route: "/gone", note: "b" })],
    ["/pricing"],
  );
  assert.equal(notes.length, 1);
  assert.match(notes[0], /"a"/);
});

test("the prompt list is capped", () => {
  const many = Array.from({ length: 30 }, (_, i) => mark({ note: `n${i}` }));
  assert.equal(annotationNotes(many, null, 12).length, 12);
});

// --- persistence -------------------------------------------------------------

test("marks come back as they were", () => {
  const list = [mark({ note: "hi" }), mark({ kind: "pen", route: "/" })];
  saveAnnotations(ROOT, list);
  assert.deepEqual(loadAnnotations(ROOT), list);
});

test("a corrupt entry costs the marks, not the project", () => {
  store.set(`dedup:marks:${ROOT}`, "{not json");
  assert.deepEqual(loadAnnotations(ROOT), []);
});

test("a mark with a non-finite point is dropped", () => {
  stored([{ ...mark(), points: [{ x: 0, y: 0 }, { x: NaN, y: 3 }] }]);
  assert.deepEqual(loadAnnotations(ROOT), []);
});

test("a route that is not a path is dropped", () => {
  stored([{ ...mark(), route: "//evil.example" }, { ...mark(), route: "x" }]);
  assert.deepEqual(loadAnnotations(ROOT), []);
});

test("an unknown kind is dropped rather than drawn as something else", () => {
  stored([{ ...mark(), kind: "spiral" }]);
  assert.deepEqual(loadAnnotations(ROOT), []);
});

test("a colour that is not a hex triplet falls back to the first pen", () => {
  stored([{ ...mark(), color: "url(#x)" }]);
  assert.equal(loadAnnotations(ROOT)[0].color, PENS[0]);
});

test("an overlong note is trimmed to what a prompt can carry", () => {
  stored([{ ...mark(), note: "x".repeat(MAX_NOTE + 500) }]);
  assert.equal(loadAnnotations(ROOT)[0].note.length, MAX_NOTE);
});

test("more marks than the cap are not read back", () => {
  stored(Array.from({ length: MAX_ANNOTATIONS + 50 }, () => mark()));
  assert.equal(loadAnnotations(ROOT).length, MAX_ANNOTATIONS);
});

console.log(`\n${passed} annotation checks passed`);
