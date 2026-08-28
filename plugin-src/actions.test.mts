// The staged program → write-back ops translation (src/lib/types) and the
// snippet rewriting it leans on (src/lib/palette). Run: pnpm test:actions
//
// The case worth protecting: text typed into a just-inserted element has no
// node in the file to address, so it has to be folded into the insert's own
// snippet. Get that wrong and the element lands on disk still saying "Text".
import assert from "node:assert/strict";
import { opsForFile, PENDING_PREFIX } from "../src/lib/types.ts";
import type { EditAction } from "../src/lib/types.ts";
import { classNameOf, PALETTE, textOf, withAttr, withText } from "../src/lib/palette.ts";

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

const PENDING = `${PENDING_PREFIX}abc`;
const target = { dedupId: "src/App.tsx@3", file: "src/App.tsx", index: 3 };
const pendingTarget = { dedupId: PENDING, file: "src/App.tsx", index: -1 };

const insertAction = (): EditAction => ({
  kind: "insert",
  id: PENDING,
  target,
  position: "after",
  snippet: PALETTE.text.snippet,
  preview: PALETTE.text.preview,
  label: "Text",
});

test("palette snippets round-trip through the rewriters", () => {
  for (const entry of Object.values(PALETTE)) {
    const withClass = withAttr(entry.snippet, "className", "p-4");
    assert.ok(withClass, `cannot rewrite ${entry.kind}`);
    assert.equal(classNameOf(withClass!), "p-4");
    // The preview uses the HTML spelling of the same attribute.
    assert.ok(withAttr(entry.preview, "class", "p-4"));
  }
  assert.equal(textOf(PALETTE.text.snippet), "Text");
  assert.equal(textOf(PALETTE.image.snippet), null, "a void element holds no text");
  assert.equal(withText(PALETTE.image.snippet, "x"), null);
});

test("rewriters refuse values that would break out of the markup", () => {
  for (const bad of ['a" onClick={x}', "a<b>", "a{b}", "a\nb", "a`b"]) {
    assert.equal(withText(PALETTE.text.snippet, bad), null, `accepted text: ${bad}`);
    assert.equal(
      withAttr(PALETTE.text.snippet, "className", bad),
      null,
      `accepted class: ${bad}`,
    );
  }
});

test("text typed into a staged insert is folded into its snippet", () => {
  const actions: EditAction[] = [
    insertAction(),
    {
      kind: "text",
      target: pendingTarget,
      before: "Text",
      after: "Pricing",
      component: null,
    },
  ];
  const { ops, failures } = opsForFile(actions);
  assert.deepEqual(failures, []);
  assert.equal(ops.length, 1, "the text edit must not become an op of its own");
  assert.equal(ops[0].op, "insert");
  assert.match(String(ops[0].snippet), />Pricing</);
});

test("classes and text fold together, newest wins", () => {
  const actions: EditAction[] = [
    insertAction(),
    { kind: "text", target: pendingTarget, before: "Text", after: "One", component: null },
    { kind: "class", target: pendingTarget, before: "text-base", after: "text-xl", component: null },
    { kind: "text", target: pendingTarget, before: "One", after: "Two", component: null },
  ];
  const { ops, failures } = opsForFile(actions);
  assert.deepEqual(failures, []);
  assert.equal(ops.length, 1);
  const snippet = String(ops[0].snippet);
  assert.match(snippet, />Two</);
  assert.match(snippet, /className="text-xl"/);
});

test("edits on real elements stay their own ops, in order", () => {
  const actions: EditAction[] = [
    { kind: "class", target, before: "a", after: "b", component: "App" },
    insertAction(),
    { kind: "text", target: pendingTarget, before: "Text", after: "Hi", component: null },
    { kind: "remove", target: { ...target, index: 5 }, label: "b · span" },
  ];
  const { ops } = opsForFile(actions);
  assert.deepEqual(
    ops.map((o) => o.op),
    ["class", "insert", "remove"],
  );
});

test("an edit that cannot be folded is reported, not dropped", () => {
  const actions: EditAction[] = [
    insertAction(),
    {
      kind: "text",
      target: pendingTarget,
      before: "Text",
      after: 'evil" onClick={pwn}',
      component: null,
    },
  ];
  const { failures } = opsForFile(actions);
  assert.equal(failures.length, 1, "a silent drop would write the wrong element");

  // An edit whose insert was withdrawn is likewise a refusal, not a no-op.
  const orphaned = opsForFile([
    { kind: "text", target: pendingTarget, before: "Text", after: "Hi", component: null },
  ]);
  assert.equal(orphaned.failures.length, 1);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
