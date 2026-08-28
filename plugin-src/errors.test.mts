// Dev-server output → build errors (src/lib/errors). Run: pnpm test:errors
import assert from "node:assert/strict";
import { foldLine, isErrorLine, shouldIgnore } from "../src/lib/errors.ts";
import type { ParsedError } from "../src/lib/errors.ts";

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

const ESC = String.fromCharCode(27);
const fold = (lines: string[]): ParsedError[] =>
  lines.reduce<ParsedError[]>((acc, l) => foldLine(acc, l), []);

test("dev-server chatter is not an error", () => {
  for (const line of [
    "  VITE v5.4.2  ready in 312 ms",
    "  ➜  Local:   http://localhost:5173/",
    "10:12:31 [vite] hmr update /src/App.tsx",
    "",
  ]) {
    assert.ok(!isErrorLine(line) || shouldIgnore(line), `flagged: ${line}`);
  }
  assert.deepEqual(fold(["  VITE v5.4.2  ready in 312 ms", "  ➜  Local: x"]), []);
});

test("a compile failure becomes one error with its detail lines", () => {
  const errors = fold([
    "[plugin:vite:react-babel] /src/App.tsx: Unexpected token (12:4)",
    "  10 |   return (",
    "  11 |     <div>",
    "  12 |     <p>",
    "     |     ^",
    "  at parseError (/x/node_modules/vite/dist/node.js:1:1)",
  ]);
  assert.equal(errors.length, 1, "detail lines must not become their own errors");
  assert.match(errors[0].content, /Unexpected token/);
  assert.match(errors[0].content, /\^/, "code frame kept");
  assert.equal(errors[0].content.split("\n").length, 6);
});

test("a successful compile clears everything", () => {
  const errors = fold([
    "Failed to compile",
    "  TS2304: Cannot find name 'foo'",
    "10:12:33 [vite] page reload src/App.tsx",
  ]);
  assert.deepEqual(errors, []);
});

test("the same error repeated stays one entry", () => {
  const line = `Failed to resolve import "./gone" from "src/App.tsx"`;
  assert.equal(fold([line, line, line]).length, 1);
});

test("distinct errors accumulate, ANSI colour codes stripped", () => {
  const errors = fold([
    `${ESC}[31mSyntaxError: bad${ESC}[0m`,
    "Cannot find module 'left-pad'",
  ]);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].content, "SyntaxError: bad");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
