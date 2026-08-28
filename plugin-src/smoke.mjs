// Smoke tests for the tagger transform. Run: pnpm test:plugin
// Tests the BUILT bundle (what actually ships inside the app).
import assert from "node:assert/strict";
import {
  buildBootScript,
  discoverRoutes,
  tagCode,
} from "../src-tauri/assets/dedup-tagger.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${e.message}`);
    process.exitCode = 1;
  }
}

test("tags a host element with file@ordinal and component name", () => {
  const out = tagCode(
    `export function Button() {\n  return <button className="p-2">Hi</button>;\n}\n`,
    "src/Button.tsx",
  );
  assert.ok(out, "expected a transform");
  assert.match(out.code, /<button className="p-2" data-dedup-id="src\/Button\.tsx@0" data-dedup-component="Button"/);
});

test("ids are positions in the walk, not in the file", () => {
  // The same elements, reformatted: identity must not move with the columns.
  const a = tagCode(
    `export const A = () => <div><b>x</b><i>y</i></div>;\n`,
    "src/A.tsx",
  );
  const b = tagCode(
    `export const A = () => (\n  <div>\n    <b>x</b>\n    <i>y</i>\n  </div>\n);\n`,
    "src/A.tsx",
  );
  const ids = (out) => [...out.code.matchAll(/data-dedup-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(a), ["src/A.tsx@0", "src/A.tsx@1", "src/A.tsx@2"]);
  assert.deepEqual(ids(a), ids(b));
});

test("marks list items, conditional branches, component roots and body", () => {
  const out = tagCode(
    `export function P({xs, ok}) {
  return (
    <body>
      <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>
      {ok && <b>yes</b>}
      {ok ? <i>a</i> : <u>b</u>}
    </body>
  );
}\n`,
    "src/P.tsx",
  );
  assert.match(out.code, /<body data-dedup-id="src\/P\.tsx@0"[^>]*data-dedup-core="body"/);
  assert.match(out.code, /<li key=\{x\} data-dedup-id[^>]*data-dedup-dyn="array"/);
  assert.match(out.code, /<b data-dedup-id[^>]*data-dedup-dyn="conditional"/);
  assert.match(out.code, /<i data-dedup-id[^>]*data-dedup-dyn="conditional"/);
  assert.match(out.code, /<u data-dedup-id[^>]*data-dedup-dyn="conditional"/);
  // A list item is an array root, never a component root.
  assert.doesNotMatch(out.code, /<li[^>]*data-dedup-core/);
  // The <ul> is plain markup inside the component.
  assert.doesNotMatch(out.code, /<ul[^>]*data-dedup-(dyn|core)/);
});

test("tags self-closing elements", () => {
  const out = tagCode(
    `const Card = () => <img src="x.png" />;\n`,
    "src/Card.tsx",
  );
  assert.match(out.code, /<img src="x\.png" data-dedup-id="src\/Card\.tsx@0" data-dedup-component="Card" data-dedup-core="root" \/>/);
});

test("skips fragments in all spellings", () => {
  const out = tagCode(
    `import React, { Fragment } from "react";
export function List() {
  return (
    <>
      <Fragment key="a"><li>a</li></Fragment>
      <React.Fragment><li>b</li></React.Fragment>
    </>
  );
}\n`,
    "src/List.tsx",
  );
  assert.ok(out);
  assert.doesNotMatch(out.code, /Fragment[^>]*data-dedup-id/);
  assert.match(out.code, /<li data-dedup-id/);
});

test("nested components get their own enclosing name", () => {
  const out = tagCode(
    `function Inner() { return <span>i</span>; }
export default function Outer() { return <div><Inner /></div>; }\n`,
    "src/Nest.tsx",
  );
  assert.match(out.code, /<span data-dedup-id="src\/Nest\.tsx@0" data-dedup-component="Inner"/);
  assert.match(out.code, /<div data-dedup-id="src\/Nest\.tsx@1" data-dedup-component="Outer"/);
  assert.match(out.code, /<Inner data-dedup-id="src\/Nest\.tsx@2" data-dedup-component="Outer" \/>/);
});

test("handles TypeScript generics on JSX", () => {
  const out = tagCode(
    `const G = () => <Select<string> value="a">x</Select>;\n`,
    "src/G.tsx",
  );
  assert.match(out.code, /value="a" data-dedup-id/);
});

test("returns null for files without JSX", () => {
  assert.equal(tagCode(`export const x = 1;\n`, "src/x.tsx"), null);
});

test("returns null on unparseable garbage instead of throwing", () => {
  assert.equal(tagCode(`const = <<<>>;;;`, "src/bad.tsx"), null);
});

test("appends a virtual export for file-local components when asked", () => {
  const out = tagCode(
    `function LocalCard() { return <div className="p-4">x</div>; }
export function Page() { return <LocalCard />; }\n`,
    "src/Page.tsx",
    "LocalCard",
  );
  assert.ok(out);
  assert.match(out.code, /export \{ LocalCard \};/);
});

test("rejects unsafe virtual export names", () => {
  const out = tagCode(
    `export const A = () => <p>x</p>;\n`,
    "src/A.tssx".replace("tssx", "tsx"),
    "x; alert(1)",
  );
  assert.ok(out); // still tags the JSX
  assert.doesNotMatch(out.code, /alert/);
});

test("produces a sourcemap", () => {
  const out = tagCode(`const A = () => <p>x</p>;\n`, "src/A.tsx");
  assert.ok(out.map && out.map.mappings.length > 0);
});

// --- write-back tests (run the built bundle as a child process, as Rust does) --

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WB = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/assets/dedup-writeback.mjs",
);

function runWb(req) {
  const out = execFileSync("node", [WB], { input: JSON.stringify(req) });
  return JSON.parse(out.toString());
}

function fixture(name, content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dedup-wb-")), name);
  fs.writeFileSync(file, content);
  return file;
}

test("wb: inspect reads a static className and the live position", () => {
  const file = fixture(
    "A.tsx",
    `// leading comment\nexport const A = () => <div className="p-4 flex">x</div>;\n`,
  );
  const r = runWb({ cmd: "inspect", file, index: 0 });
  assert.deepEqual(
    { ok: r.ok, editable: r.editable, className: r.className, line: r.line },
    { ok: true, editable: true, className: "p-4 flex", line: 2 },
  );
  assert.equal(r.tag, "div");
  assert.equal(r.core, "root");
  assert.equal(r.text, "x");
});

test("wb: inspect flags cn(...) as read-only with a reason", () => {
  const file = fixture(
    "B.tsx",
    `export const B = ({v}) => <div className={cn(v)}>x</div>;\n`,
  );
  const r = runWb({ cmd: "inspect", file, index: 0 });
  assert.equal(r.editable, false);
  assert.match(r.reason, /cn/);
});

test("wb: inspect reports which structural edits a node admits", () => {
  const file = fixture(
    "Caps.tsx",
    `export const C = ({xs}) => (
  <div>
    <img src="a.png" />
    <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>
  </div>
);\n`,
  );
  const root = runWb({ cmd: "inspect", file, index: 0 });
  assert.equal(root.canRemove, false, "a component root is not removable");
  assert.match(root.structuralReason, /root element/);

  const img = runWb({ cmd: "inspect", file, index: 1 });
  assert.equal(img.canMove, true);
  assert.equal(img.canAcceptChildren, false, "<img> takes no children");

  const li = runWb({ cmd: "inspect", file, index: 3 });
  assert.equal(li.dynamic, "array");
  assert.equal(li.canMove, false);
  assert.match(li.structuralReason, /\.map/);
});

test("wb: class op replaces the class string surgically", () => {
  const file = fixture(
    "C.tsx",
    `// a comment   with   weird   spacing\nexport const C = () => (\n  <div className="p-4">x</div>\n);\n`,
  );
  const r = runWb({ cmd: "apply", file, ops: [{ op: "class", index: 0, className: "p-6 flex gap-2" }] });
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /<div className="p-6 flex gap-2">x<\/div>/);
  assert.match(after, /\/\/ a comment {3}with {3}weird {3}spacing/); // untouched
});

test("wb: class op adds className when the element has none", () => {
  const file = fixture("D.tsx", `export const D = () => <span id="s">x</span>;\n`);
  const r = runWb({ cmd: "apply", file, ops: [{ op: "class", index: 0, className: "text-sm" }] });
  assert.equal(r.ok, true, r.error);
  assert.match(fs.readFileSync(file, "utf8"), /<span className="text-sm" id="s">/);
});

test("wb: batch ops in one file all land", () => {
  const file = fixture(
    "E.tsx",
    `export const E = () => (\n  <div className="a"><span className="b">x</span></div>\n);\n`,
  );
  const r = runWb({
    cmd: "apply",
    file,
    ops: [
      { op: "class", index: 0, className: "a2" },
      { op: "class", index: 1, className: "b2" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.match(fs.readFileSync(file, "utf8"), /<div className="a2"><span className="b2">/);
});

test("wb: refuses unsafe class strings and dynamic targets", () => {
  const file = fixture("F.tsx", `export const F = ({c}) => <div className={c}>x</div>;\n`);
  const r1 = runWb({ cmd: "apply", file, ops: [{ op: "class", index: 0, className: "p-4" }] });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /not editable/);
  const r2 = runWb({
    cmd: "apply",
    file,
    ops: [{ op: "class", index: 0, className: `pwn" onClick={x}` }],
  });
  assert.equal(r2.ok, false);
  assert.match(fs.readFileSync(file, "utf8"), /className=\{c\}/); // untouched
});

test("wb: text op rewrites a static text child, and refuses richer ones", () => {
  const file = fixture(
    "T.tsx",
    `export const T = ({n}) => (\n  <div>\n    <h1>Hello</h1>\n    <p>{n} items</p>\n  </div>\n);\n`,
  );
  const ok = runWb({ cmd: "apply", file, ops: [{ op: "text", index: 1, text: "Goodbye" }] });
  assert.equal(ok.ok, true, ok.error);
  assert.match(fs.readFileSync(file, "utf8"), /<h1>Goodbye<\/h1>/);

  const refused = runWb({ cmd: "apply", file, ops: [{ op: "text", index: 2, text: "x" }] });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /expression/);
});

test("wb: remove deletes the element and its line", () => {
  const file = fixture(
    "R.tsx",
    `export const R = () => (\n  <div>\n    <a>one</a>\n    <b>two</b>\n  </div>\n);\n`,
  );
  const r = runWb({ cmd: "apply", file, ops: [{ op: "remove", index: 1 }] });
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(after, /<a>one<\/a>/);
  assert.match(after, /<b>two<\/b>/);
  assert.doesNotMatch(after, /\n\s*\n\s*<b>/, "no blank line left behind");
});

test("wb: insert places a validated snippet, and refuses invalid ones", () => {
  const file = fixture(
    "I2.tsx",
    `export const I = () => (\n  <div>\n    <a>one</a>\n  </div>\n);\n`,
  );
  const r = runWb({
    cmd: "apply",
    file,
    ops: [{ op: "insert", target: 1, position: "after", snippet: `<p className="x">new</p>` }],
  });
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /<a>one<\/a>\n    <p className="x">new<\/p>/, after);

  for (const snippet of ["<div>", "<a/><b/>", "{evil()}", ""]) {
    const bad = runWb({ cmd: "apply", file, ops: [{ op: "insert", target: 1, position: "after", snippet }] });
    assert.equal(bad.ok, false, `snippet should be refused: ${snippet}`);
  }
});

test("wb: move re-parents, re-indents, and carries edits made inside it", () => {
  const file = fixture(
    "M.tsx",
    `export const M = () => (
  <div>
    <a className="one">
      <span>deep</span>
    </a>
    <section className="two" />
  </div>
);\n`,
  );
  const r = runWb({
    cmd: "apply",
    file,
    ops: [
      { op: "move", index: 1, target: 3, position: "inside" },
      { op: "class", index: 1, className: "one moved" },
      { op: "text", index: 2, text: "still deep" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(file, "utf8");
  // The self-closing target was expanded to take the child.
  assert.match(after, /<section className="two">\n      <a className="one moved">/, after);
  assert.match(after, /<span>still deep<\/span>/, after);
  assert.match(after, /<\/section>/);
});

test("wb: refuses moves that would corrupt structure, writing nothing", () => {
  const source = `export const X = ({xs}) => (
  <div>
    <a><b>x</b></a>
    <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul>
  </div>
);\n`;
  const file = fixture("X.tsx", source);
  const cases = [
    [{ op: "move", index: 1, target: 2, position: "inside" }, /inside itself/],
    [{ op: "move", index: 1, target: 1, position: "after" }, /relative to itself/],
    [{ op: "move", index: 4, target: 1, position: "inside" }, /\.map/],
    [{ op: "remove", index: 0 }, /root element/],
    [{ op: "class", index: 99, className: "p-1" }, /not found/],
  ];
  for (const [op, pattern] of cases) {
    const r = runWb({ cmd: "apply", file, ops: [op] });
    assert.equal(r.ok, false, `should refuse: ${JSON.stringify(op)}`);
    assert.match(r.error, pattern);
  }
  assert.equal(fs.readFileSync(file, "utf8"), source, "file must be untouched");
});

test("wb: one refused op aborts the whole program", () => {
  const source = `export const P = () => (\n  <div>\n    <a>one</a>\n  </div>\n);\n`;
  const file = fixture("P2.tsx", source);
  const r = runWb({
    cmd: "apply",
    file,
    ops: [
      { op: "class", index: 1, className: "fine" },
      { op: "remove", index: 0 }, // component root — refused
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), source);
});

test("wb: writeFile replaces the whole file when content parses", () => {
  const file = fixture("G.tsx", `export const G = () => <div>old</div>;\n`);
  const next = `export const G = () => (\n  <div className="p-4">new</div>\n);\n`;
  const r = runWb({ cmd: "writeFile", file, content: next });
  assert.deepEqual({ ok: r.ok, changed: r.changed }, { ok: true, changed: true });
  assert.equal(fs.readFileSync(file, "utf8"), next);
});

test("wb: writeFile refuses content that does not parse", () => {
  const before = `export const H = () => <div>x</div>;\n`;
  const file = fixture("H.tsx", before);
  const r = runWb({
    cmd: "writeFile",
    file,
    content: `export const H = () => <div>x</div;\n`, // broken JSX
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /does not parse/);
  assert.equal(fs.readFileSync(file, "utf8"), before); // untouched
});

test("wb: writeFile refuses empty content and reports no-op writes", () => {
  const before = `export const I = () => <p>x</p>;\n`;
  const file = fixture("I.tsx", before);
  const empty = runWb({ cmd: "writeFile", file, content: "  \n" });
  assert.equal(empty.ok, false);
  const same = runWb({ cmd: "writeFile", file, content: before });
  assert.deepEqual({ ok: same.ok, changed: same.changed }, { ok: true, changed: false });
});

// --- the invariant the id scheme rests on ----------------------------------

test("tagger and write-back agree on every ordinal, across both bundles", () => {
  // If these two walks ever disagree, every id in the app points at the wrong
  // element — and it would fail silently. Check them against each other on a
  // file with all the shapes that make traversal order interesting.
  const source = `import React, { Fragment } from "react";

function Row({ item, ok }) {
  return (
    <li className="row">
      <span>{item.name}</span>
      {ok ? <b>yes</b> : <i>no</i>}
    </li>
  );
}

export default function Page({ items, ok }) {
  return (
    <main className="page">
      <>
        <h1>Title</h1>
        <Fragment><h2>Sub</h2></Fragment>
      </>
      <Widget<string> value="a">
        <img src="a.png" />
      </Widget>
      <ul>{items.map((item) => <Row key={item.id} item={item} ok={ok} />)}</ul>
      {ok && <footer><small>fine print</small></footer>}
    </main>
  );
}
`;
  const tagged = tagCode(source, "src/Page.tsx");
  assert.ok(tagged);
  // Every stamped id, with the tag it was stamped onto. Read backwards from
  // the attribute rather than forwards from the tag: `<Widget<string> …>` has
  // a `>` inside its generics, which any forward pattern trips over.
  const stamped = [...tagged.code.matchAll(/data-dedup-id="([^"]+)"/g)].map((m) => {
    // A tag's `<` is never preceded by an identifier character — that would be
    // the `<` of a generic argument list, `<Widget<string> …>`.
    let open = m.index;
    do {
      open = tagged.code.lastIndexOf("<", open - 1);
    } while (open > 0 && /[\w.]/.test(tagged.code[open - 1]));
    const tag = tagged.code.slice(open + 1).match(/^[A-Za-z][\w.]*/)[0];
    return { tag, id: m[1] };
  });
  assert.ok(stamped.length >= 10, `only tagged ${stamped.length}`);

  const file = fixture("Page.tsx", source);
  for (const { tag, id } of stamped) {
    const index = Number(id.split("@")[1]);
    const r = runWb({ cmd: "inspect", file, index });
    assert.equal(r.ok, true, `write-back cannot resolve ${id}: ${r.error}`);
    assert.equal(r.tag, tag, `ordinal ${index} is <${r.tag}> to the write-back but <${tag}> to the tagger`);
  }
  // And nothing beyond the last ordinal exists.
  const past = runWb({ cmd: "inspect", file, index: stamped.length });
  assert.equal(past.ok, false, "write-back sees more elements than the tagger tagged");
});

// --- route discovery (pages-as-artboards) ----------------------------------

test("routes: finds static react-router paths, skips dynamic ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-routes-"));
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, "App.tsx"),
    `import { Routes, Route } from "react-router-dom";
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/about" element={<About />} />
      <Route path="/orders/:id" element={<Order />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}`,
  );
  // A file with path-ish strings but no router must not contribute.
  fs.writeFileSync(
    path.join(src, "config.ts"),
    `export const api = { path: "/api/things" };`,
  );
  const routes = discoverRoutes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(routes, ["/", "/about"]);
});

test("routes: object-config router paths, '/' always first", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-routes-"));
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(
    path.join(src, "router.ts"),
    `import { createBrowserRouter } from "react-router";
export const router = createBrowserRouter([
  { path: "/zebra", element: null },
  { path: "/alpha", element: null },
]);`,
  );
  const routes = discoverRoutes(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(routes, ["/", "/alpha", "/zebra"]);
});

// --- boot script: mock session + hold --------------------------------------

/**
 * Run a boot script in a stand-in for a page. `search` is the frame URL's
 * query (that is how a hold is armed); `framed` says whether the page is
 * embedded, which gates everything.
 */
function runBoot(out, { framed = true, search = "" } = {}) {
  const warned = [];
  const timers = [];
  const win = {
    setTimeout: (fn, delay, ...args) => {
      timers.push({ kind: "timeout", fn, delay, args });
      return timers.length;
    },
    setInterval: (fn, delay, ...args) => {
      timers.push({ kind: "interval", fn, delay, args });
      return timers.length;
    },
    clearTimeout: (id) => timers.push({ kind: "clear", id }),
    clearInterval: (id) => timers.push({ kind: "clear", id }),
  };
  win.self = win;
  win.top = framed ? {} : win;
  const writes = [];
  const history = { pushState: () => writes.push(["pushState"]), replaceState: () => writes.push(["replaceState"]) };
  const localStorage = { setItem: (k, v) => writes.push([k, v]) };
  new Function("window", "history", "location", "localStorage", "console", out)(
    win,
    history,
    { search },
    localStorage,
    { warn: (...a) => warned.push(a) },
  );
  return { win, history, warned, writes, timers };
}

test("boot: no seed, disabled seed, and empty script all serve a no-op", () => {
  for (const seed of [
    null,
    undefined,
    { enabled: false, script: "localStorage.setItem('t','x')" },
    { enabled: true, script: "   " },
  ]) {
    const out = buildBootScript(seed);
    assert.ok(!out.includes("localStorage.setItem('t'"), `seed leaked: ${out}`);
    // Still has to be valid JS — it is injected into <head> unconditionally.
    new Function(out);
  }
});

test("boot: an active seed is gated to framed pages and can't throw out", () => {
  const script = `localStorage.setItem("authToken", "mock");`;
  const out = buildBootScript({ enabled: true, script });
  assert.ok(out.includes(script), "seed body missing");
  // The framed gate is the promise that the user's own browsing of their dev
  // server is never seeded — assert by running it, not by matching source.
  assert.deepEqual(runBoot(out, { framed: false }).writes, []);
  assert.deepEqual(runBoot(out, { framed: true }).writes, [["authToken", "mock"]]);
});

test("boot: a throwing seed is swallowed, never breaking the app's boot", () => {
  const out = buildBootScript({ enabled: true, script: `throw new Error("bad seed");` });
  // Would propagate and kill the page's <head> script without the try/catch.
  assert.equal(runBoot(out).warned.length, 1, "a failing seed must warn, not throw");
});

test("hold: does nothing unless the frame asked for it", () => {
  const out = buildBootScript(null);
  const idle = runBoot(out, { search: "" });
  assert.equal(idle.win.__dedupHeld, undefined, "unflagged frames must run free");
  const held = runBoot(out, { search: "?__dedup_hold=1" });
  assert.equal(held.win.__dedupHeld, true);
});

test("hold: queues the long timers a splash advances on, runs the short ones", () => {
  const { win, timers } = runBoot(buildBootScript(null), { search: "?__dedup_hold=1" });
  let splashDone = false;
  const heldId = win.setTimeout(() => (splashDone = true), 2000);
  // React's scheduler falls back to setTimeout — stalling it would hang the
  // page rather than pause it, so short delays must pass straight through.
  let scheduled = false;
  win.setTimeout(() => (scheduled = true), 0);

  assert.equal(splashDone, false, "the splash timer must not have run");
  assert.equal(
    timers.filter((t) => t.kind === "timeout").length,
    1,
    "only the short timer reaches the real setTimeout",
  );
  assert.equal(timers.find((t) => t.kind === "timeout").delay, 0);

  // Releasing plays the transition rather than discarding it.
  win.__dedupRelease();
  assert.equal(splashDone, true, "release must flush what was held");
  assert.equal(win.__dedupHeld, false);
  void heldId;
  void scheduled;
});

test("hold: freezes navigation, and a cancelled held timer stays cancelled", () => {
  const { win, history } = runBoot(buildBootScript(null), { search: "?__dedup_hold=1" });
  let navigated = false;
  const id = win.setTimeout(() => (navigated = true), 1500);
  win.clearTimeout(id);

  // A "redirecting…" screen usually pushes history directly too.
  history.pushState({}, "", "/home");
  assert.equal(navigated, false);

  win.__dedupRelease();
  assert.equal(navigated, false, "a cleared timer must not fire on release");
});

test("hold: releasing restores the page's own timers and history", () => {
  const { win, history, timers, writes } = runBoot(buildBootScript(null), {
    search: "?__dedup_hold=1",
  });
  win.__dedupRelease();
  // Everything must be handed back exactly as found — the app keeps running
  // long after the hold is over.
  win.setTimeout(() => {}, 5000);
  assert.equal(
    timers.filter((t) => t.kind === "timeout").length,
    1,
    "long timers must reach the real setTimeout again after release",
  );
  history.pushState({}, "", "/next");
  assert.deepEqual(writes, [["pushState"]], "navigation must work again");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
