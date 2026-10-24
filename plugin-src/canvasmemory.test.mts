// What comes back when a project is reopened. Run: pnpm test:canvas
//
// The pages row is the one piece of restored state that mounts iframes
// pointing at the user's app, so what it will and will not replay is worth
// pinning: a route that isn't a path, a session mode keyed to an artboard
// that no longer exists, or a row longer than the cap are all ways for a
// remembered canvas to do something the user never asked for.
import assert from "node:assert/strict";
import {
  MAX_ARTBOARDS,
  forgetCanvas,
  layoutArtboards,
  loadCanvas,
  saveCanvas,
  type SavedCanvas,
} from "../src/lib/canvasMemory.ts";

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
const canvas = (over: Partial<SavedCanvas> = {}): SavedCanvas => ({
  routes: ["/", "/pricing"],
  selectedRoute: "/pricing",
  sessionModes: { "/pricing": "out" },
  heldRoutes: [],
  offlineRoutes: [],
  positions: {},
  ...over,
});

/** Write a blob straight to storage, bypassing the save path — that is what
 * a stale or hand-edited entry looks like on the next open. */
function stored(value: unknown) {
  store.set(`dedup:canvas:${ROOT}`, JSON.stringify(value));
}

// --- the round trip ----------------------------------------------------------

test("a saved canvas comes back as it was", () => {
  const c = canvas({ heldRoutes: ["/"], offlineRoutes: ["/pricing"] });
  saveCanvas(ROOT, c);
  assert.deepEqual(loadCanvas(ROOT), c);
});

test("nothing saved means start empty", () => {
  assert.equal(loadCanvas(ROOT), null);
});

test("each project remembers its own canvas", () => {
  saveCanvas(ROOT, canvas());
  saveCanvas("/x/other", canvas({ routes: ["/docs"], selectedRoute: null, sessionModes: {} }));
  assert.deepEqual(loadCanvas(ROOT)!.routes, ["/", "/pricing"]);
  assert.deepEqual(loadCanvas("/x/other")!.routes, ["/docs"]);
});

test("forgetting one project leaves the others alone", () => {
  saveCanvas(ROOT, canvas());
  saveCanvas("/x/other", canvas());
  forgetCanvas(ROOT);
  assert.equal(loadCanvas(ROOT), null);
  assert.notEqual(loadCanvas("/x/other"), null);
});

// --- an empty row is not a canvas -------------------------------------------

test("closing every artboard restores an empty canvas, not a guess", () => {
  saveCanvas(ROOT, canvas({ routes: [], selectedRoute: null, sessionModes: {} }));
  assert.equal(loadCanvas(ROOT), null);
});

// --- what will never be replayed into a frame -------------------------------

test("only paths are routes — no origin, scheme or protocol-relative host", () => {
  stored({
    ...canvas(),
    routes: ["/", "http://evil.test/x", "//evil.test/x", "pricing", 7, null],
  });
  assert.deepEqual(loadCanvas(ROOT)!.routes, ["/"]);
});

test("a duplicated route mounts one artboard", () => {
  stored({ ...canvas(), routes: ["/", "/", "/pricing"] });
  assert.deepEqual(loadCanvas(ROOT)!.routes, ["/", "/pricing"]);
});

test("the row is capped at what the canvas will mount", () => {
  const many = Array.from({ length: MAX_ARTBOARDS + 12 }, (_, i) => `/p${i}`);
  stored({ ...canvas(), routes: many, selectedRoute: null, sessionModes: {} });
  assert.equal(loadCanvas(ROOT)!.routes.length, MAX_ARTBOARDS);
});

test("a corrupt entry restores an empty canvas", () => {
  store.set(`dedup:canvas:${ROOT}`, "{not json");
  assert.equal(loadCanvas(ROOT), null);
});

test("a canvas missing every optional field still loads", () => {
  stored({ routes: ["/"] });
  assert.deepEqual(loadCanvas(ROOT), {
    routes: ["/"],
    selectedRoute: null,
    sessionModes: {},
    heldRoutes: [],
    offlineRoutes: [],
    positions: {}, // saved before artboards could move: the row applies
  });
});

// --- choices belong to the artboards they were made on ----------------------

test("a mode keyed to a route that isn't open is dropped", () => {
  stored({
    ...canvas(),
    routes: ["/"],
    sessionModes: { "/": "in", "/gone": "out" },
    heldRoutes: ["/", "/gone"],
    offlineRoutes: ["/gone"],
  });
  const back = loadCanvas(ROOT)!;
  assert.deepEqual(back.sessionModes, { "/": "in" });
  assert.deepEqual(back.heldRoutes, ["/"]);
  assert.deepEqual(back.offlineRoutes, []);
});

test("an unknown session mode is dropped rather than restored", () => {
  stored({ ...canvas(), sessionModes: { "/pricing": "sudo" } });
  assert.deepEqual(loadCanvas(ROOT)!.sessionModes, {});
});

test("a selection whose artboard is gone is no selection", () => {
  stored({ ...canvas(), routes: ["/"], selectedRoute: "/pricing" });
  assert.equal(loadCanvas(ROOT)!.selectedRoute, null);
});

// --- where artboards sit -------------------------------------------------------

test("with nothing moved, artboards form the old row", () => {
  assert.deepEqual(layoutArtboards(["/", "/a", "/b"], undefined, 1440, 64), {
    "/": { x: 0, y: 0 },
    "/a": { x: 1504, y: 0 },
    "/b": { x: 3008, y: 0 },
  });
});

test("a moved artboard stays put, and a new one joins to the right of everything", () => {
  const layout = layoutArtboards(
    ["/", "/a", "/new"],
    { "/": { x: 0, y: 0 }, "/a": { x: 4000, y: 900 } },
    1440,
    64,
  );
  assert.deepEqual(layout["/a"], { x: 4000, y: 900 });
  assert.deepEqual(layout["/new"], { x: 4000 + 1440 + 64, y: 0 }, "past the rightmost, not into a gap");
});

test("a page moved far left doesn't drag the row's new arrivals with it", () => {
  // New arrivals start where the row always started; only something stored
  // further right pushes them along.
  const layout = layoutArtboards(["/", "/b"], { "/": { x: -9000, y: 0 } }, 390, 64);
  assert.deepEqual(layout["/b"], { x: 0, y: 0 });
});

test("positions come back per viewport, for open artboards, as numbers", () => {
  const positions = {
    desktop: { "/": { x: 10, y: 20 }, "/pricing": { x: 2000, y: -300 } },
    mobile: { "/": { x: 5, y: 5 } },
  };
  saveCanvas(ROOT, canvas({ positions }));
  assert.deepEqual(loadCanvas(ROOT)!.positions, positions);

  stored({
    ...canvas(),
    positions: {
      desktop: {
        "/": { x: 1, y: 2 },
        "/closed": { x: 3, y: 4 }, // not an open artboard
        "/pricing": { x: "9", y: 0 }, // not a number
      },
      tablet: { "/": { x: Infinity, y: 0 } }, // not finite → nothing left
      junk: "nope",
    },
  });
  assert.deepEqual(loadCanvas(ROOT)!.positions, { desktop: { "/": { x: 1, y: 2 } } });
});

console.log(`\n${passed} canvas-memory checks passed`);
