// Smoke tests for the tagger transform. Run: pnpm test:plugin
// Tests the BUILT bundle (what actually ships inside the app).
import assert from "node:assert/strict";
import { tagCode } from "../src-tauri/assets/dedup-tagger.mjs";

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

test("tags a host element with file:line:col and component name", () => {
  const out = tagCode(
    `export function Button() {\n  return <button className="p-2">Hi</button>;\n}\n`,
    "src/Button.tsx",
  );
  assert.ok(out, "expected a transform");
  assert.match(out.code, /<button className="p-2" data-dedup-id="src\/Button\.tsx:2:9" data-dedup-component="Button">/);
});

test("tags self-closing elements", () => {
  const out = tagCode(
    `const Card = () => <img src="x.png" />;\n`,
    "src/Card.tsx",
  );
  assert.match(out.code, /<img src="x\.png" data-dedup-id="src\/Card\.tsx:1:19" data-dedup-component="Card" \/>/);
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
  assert.match(out.code, /<span data-dedup-id="src\/Nest\.tsx:1:26" data-dedup-component="Inner">/);
  assert.match(out.code, /<div data-dedup-id="src\/Nest\.tsx:2:41" data-dedup-component="Outer">/);
  assert.match(out.code, /<Inner data-dedup-id="src\/Nest\.tsx:2:46" data-dedup-component="Outer" \/>/);
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

test("wb: inspect reads a static className", () => {
  const file = fixture(
    "A.tsx",
    `export const A = () => <div className="p-4 flex">x</div>;\n`,
  );
  const r = runWb({ cmd: "inspect", file, line: 1, col: 23 });
  assert.deepEqual(
    { ok: r.ok, editable: r.editable, className: r.className },
    { ok: true, editable: true, className: "p-4 flex" },
  );
});

test("wb: inspect flags cn(...) as read-only with a reason", () => {
  const file = fixture(
    "B.tsx",
    `export const B = ({v}) => <div className={cn(v)}>x</div>;\n`,
  );
  const r = runWb({ cmd: "inspect", file, line: 1, col: 26 });
  assert.equal(r.editable, false);
  assert.match(r.reason, /cn/);
});

test("wb: write replaces the class string surgically", () => {
  const file = fixture(
    "C.tsx",
    `// a comment   with   weird   spacing\nexport const C = () => (\n  <div className="p-4">x</div>\n);\n`,
  );
  const r = runWb({
    cmd: "write",
    file,
    edits: [{ line: 3, col: 2, className: "p-6 flex gap-2" }],
  });
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /<div className="p-6 flex gap-2">x<\/div>/);
  assert.match(after, /\/\/ a comment {3}with {3}weird {3}spacing/); // untouched
});

test("wb: write adds className when the element has none", () => {
  const file = fixture(
    "D.tsx",
    `export const D = () => <span id="s">x</span>;\n`,
  );
  const r = runWb({
    cmd: "write",
    file,
    edits: [{ line: 1, col: 23, className: "text-sm" }],
  });
  assert.equal(r.ok, true, r.error);
  assert.match(
    fs.readFileSync(file, "utf8"),
    /<span className="text-sm" id="s">/,
  );
});

test("wb: batch edits in one file all land", () => {
  const file = fixture(
    "E.tsx",
    `export const E = () => (\n  <div className="a"><span className="b">x</span></div>\n);\n`,
  );
  const r = runWb({
    cmd: "write",
    file,
    edits: [
      { line: 2, col: 2, className: "a2" },
      { line: 2, col: 21, className: "b2" },
    ],
  });
  assert.equal(r.ok, true, r.error);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /<div className="a2"><span className="b2">/);
});

test("wb: refuses unsafe class strings and dynamic targets", () => {
  const file = fixture(
    "F.tsx",
    `export const F = ({c}) => <div className={c}>x</div>;\n`,
  );
  const r1 = runWb({
    cmd: "write",
    file,
    edits: [{ line: 1, col: 26, className: "p-4" }],
  });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /not editable/);
  const r2 = runWb({
    cmd: "write",
    file,
    edits: [{ line: 1, col: 26, className: `pwn" onClick={x}` }],
  });
  assert.equal(r2.ok, false);
  // file untouched either way
  assert.match(fs.readFileSync(file, "utf8"), /className=\{c\}/);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
