// Tests for chat edit-block parsing and application.
// Run: pnpm test:chat  (node --experimental-strip-types)
import assert from "node:assert/strict";
import { applyEditBlocks, parseChatReply } from "../src/lib/chatEdits.ts";

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

const FILE = `import React from "react";

export function Card({ title }: { title: string }) {
  return (
    <div className="bg-white p-4 shadow">
      <h3 className="text-lg">{title}</h3>
    </div>
  );
}
`;

test("parses one block + summary", () => {
  const reply = [
    "<<<<<<< SEARCH",
    '    <div className="bg-white p-4 shadow">',
    "=======",
    '    <div className="bg-white p-4 shadow rounded-lg">',
    ">>>>>>> REPLACE",
    "SUMMARY: Round the card corners.",
  ].join("\n");
  const r = parseChatReply(reply);
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.equal(r.blocks.length, 1);
  assert.equal(r.summary, "Round the card corners.");
  const out = applyEditBlocks(FILE, r.blocks);
  assert.match(out, /rounded-lg/);
  assert.match(out, /import React/); // rest untouched
});

test("parses multiple blocks, applies in order", () => {
  const reply = [
    "<<<<<<< SEARCH",
    '      <h3 className="text-lg">{title}</h3>',
    "=======",
    '      <h3 className="text-xl font-bold">{title}</h3>',
    ">>>>>>> REPLACE",
    "<<<<<<< SEARCH",
    '    <div className="bg-white p-4 shadow">',
    "=======",
    '    <div className="bg-white p-6 shadow">',
    ">>>>>>> REPLACE",
    "SUMMARY: Bigger title, more padding.",
  ].join("\n");
  const r = parseChatReply(reply);
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  const out = applyEditBlocks(FILE, r.blocks);
  assert.match(out, /text-xl font-bold/);
  assert.match(out, /p-6/);
});

test("empty REPLACE section deletes the searched lines", () => {
  const reply = [
    "<<<<<<< SEARCH",
    '      <h3 className="text-lg">{title}</h3>',
    "=======",
    ">>>>>>> REPLACE",
    "SUMMARY: Drop the title.",
  ].join("\n");
  const r = parseChatReply(reply);
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  const out = applyEditBlocks(FILE, r.blocks);
  assert.doesNotMatch(out, /<h3/);
});

test("non-matching SEARCH throws, file semantics stay intact", () => {
  const r = parseChatReply(
    "<<<<<<< SEARCH\nnot in the file\n=======\nx\n>>>>>>> REPLACE",
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.throws(() => applyEditBlocks(FILE, r.blocks), /didn't match/);
});

test("ambiguous SEARCH throws", () => {
  const doubled = FILE + FILE;
  const r = parseChatReply(
    '<<<<<<< SEARCH\n    <div className="bg-white p-4 shadow">\n=======\n    <div>\n>>>>>>> REPLACE',
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.throws(() => applyEditBlocks(doubled, r.blocks), /more than one place/);
});

test("malformed blocks throw instead of half-applying", () => {
  assert.throws(
    () => parseChatReply("<<<<<<< SEARCH\nabc\n>>>>>>> REPLACE"),
    /divider/,
  );
  assert.throws(() => parseChatReply("<<<<<<< SEARCH\nabc\n======="), /unterminated/);
});

test("full-file fence still accepted as fallback", () => {
  const r = parseChatReply(
    "```tsx\nexport const A = () => <p>x</p>;\n```\nSUMMARY: Rewrite.",
  );
  assert.equal(r.kind, "file");
  if (r.kind !== "file") return;
  assert.equal(r.content, "export const A = () => <p>x</p>;\n");
  assert.equal(r.summary, "Rewrite.");
});

test("prose reply (no markers, no fence) is an answer", () => {
  const r = parseChatReply(
    "That element's classes are computed at runtime, so I can't change them safely here.",
  );
  assert.equal(r.kind, "answer");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
