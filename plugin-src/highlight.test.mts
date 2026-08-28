// Syntax colouring for the code panel. Run: pnpm test:highlight
//
// The load-bearing test here is the round-trip one. The panel paints these
// tokens *behind* a transparent textarea, so the two layers have to render
// byte-identical text — if the tokenizer ever dropped, added or reordered a
// character, the caret would sit somewhere other than where the user is
// typing. Colour being slightly wrong is cosmetic; that is not.
import assert from "node:assert/strict";
import { tokenize, type TokenKind } from "../src/lib/highlight.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${(e as Error).stack ?? (e as Error).message}`);
    process.exitCode = 1;
  }
}

const roundTrips = (src: string) =>
  tokenize(src)
    .map((t) => t.text)
    .join("") === src;

/** Kinds in order, for asserting what got coloured. */
const kinds = (src: string): TokenKind[] => tokenize(src).map((t) => t.kind);
const textOf = (src: string, kind: TokenKind) =>
  tokenize(src)
    .filter((t) => t.kind === kind)
    .map((t) => t.text);

const SAMPLE = `import { useState } from "react";

// A card, and a comment with 'quotes' and /* not a block */
export function Card({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const label = \`\${title} — \${open ? "open" : "closed"}\`;
  /* block
     comment */
  return (
    <div className="rounded-lg p-4" onClick={() => setOpen(!open)}>
      <h3>{label}</h3>
      {open && <p>0x1f · 3.14</p>}
    </div>
  );
}
`;

// --- the invariant -----------------------------------------------------------

test("every character survives tokenizing, exactly once", () => {
  assert.ok(roundTrips(SAMPLE), "the sample must round-trip");
});

test("round-trips on the awkward inputs too", () => {
  for (const src of [
    "",
    "\n\n\n",
    "   ",
    "const a = 1",
    'const s = "unterminated',
    "const t = `unterminated",
    "// trailing comment with no newline",
    "/* unterminated block",
    "a < b && c > d",
    "<Foo.Bar baz />",
    "const emoji = \"→ ✓ 🎉\";",
    "\tconst tabbed = 1;\r\n",
    "const re = /not a comment/g;",
  ]) {
    assert.ok(roundTrips(src), `did not round-trip: ${JSON.stringify(src)}`);
  }
});

// --- colouring ---------------------------------------------------------------

test("strings, templates and comments are one token each", () => {
  assert.deepEqual(textOf('const a = "hi";', "string"), ['"hi"']);
  assert.deepEqual(textOf("const a = 'hi';", "string"), ["'hi'"]);
  assert.deepEqual(textOf("const a = `hi ${x}`;", "string"), ["`hi ${x}`"]);
  assert.deepEqual(textOf("// note\ncode", "comment"), ["// note"]);
  assert.deepEqual(textOf("/* a\nb */ code", "comment"), ["/* a\nb */"]);
});

test("an escaped quote does not end a string", () => {
  assert.deepEqual(textOf('"a \\" b" after', "string"), ['"a \\" b"']);
});

test("an unterminated quoted string stops at the line, not the file", () => {
  // Otherwise one stray quote paints the whole rest of the file green.
  const src = 'const a = "oops\nconst b = 2;';
  assert.deepEqual(textOf(src, "string"), ['"oops']);
  assert.ok(kinds(src).includes("keyword"), "line 2 must still be tokenized");
});

test("comment markers inside a string are not comments, and vice versa", () => {
  assert.deepEqual(textOf('const a = "// not a comment";', "comment"), []);
  assert.deepEqual(textOf("// a \"string\" inside a comment", "string"), []);
});

test("keywords are keywords, identifiers are not", () => {
  const words = textOf("export const constant = classy;", "keyword");
  assert.deepEqual(words, ["export", "const"]);
  assert.ok(!words.includes("constant"), "a prefix match is not a keyword");
});

test("JSX tag names are coloured, including closings and members", () => {
  assert.deepEqual(textOf("<div>x</div>", "tag"), ["<div", "</div"]);
  assert.deepEqual(textOf("<Foo.Bar />", "tag"), ["<Foo.Bar"]);
});

test("a less-than that isn't a tag stays plain", () => {
  assert.deepEqual(textOf("if (a < b) return;", "tag"), []);
});

test("numbers include hex and decimals", () => {
  assert.deepEqual(textOf("const a = 0x1f + 3.14;", "number"), ["0x1f", "3.14"]);
});

test("the whole sample colours plausibly", () => {
  const k = new Set(kinds(SAMPLE));
  for (const expected of ["comment", "string", "keyword", "number", "tag", "plain"] as TokenKind[]) {
    assert.ok(k.has(expected), `nothing was coloured as ${expected}`);
  }
});

console.log(`\n${passed} passed`);
