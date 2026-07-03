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

test("produces a sourcemap", () => {
  const out = tagCode(`const A = () => <p>x</p>;\n`, "src/A.tsx");
  assert.ok(out.map && out.map.mappings.length > 0);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
