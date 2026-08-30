// The staged program → write-back ops translation (src/lib/types) and the
// snippet rewriting it leans on (src/lib/palette). Run: pnpm test:actions
//
// The case worth protecting: text typed into a just-inserted element has no
// node in the file to address, so it has to be folded into the insert's own
// snippet. Get that wrong and the element lands on disk still saying "Text".
import assert from "node:assert/strict";
import {
  opsForFile,
  PENDING_PREFIX,
  stagingConflict,
  withoutAction,
} from "../src/lib/types.ts";
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
  lang: "jsx",
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

test("a snippet bound for an HTML page is respelled, not copied", () => {
  const insertOf = (kind: keyof typeof PALETTE, file: string) => {
    const { ops, failures } = opsForFile(
      [{ ...insertAction(), snippet: PALETTE[kind].snippet, preview: PALETTE[kind].preview }],
      file,
    );
    assert.deepEqual(failures, [], `${kind} → ${file}`);
    return (ops.find((o) => o.op === "insert") as { snippet: string }).snippet;
  };

  for (const kind of ["div", "text", "button", "image"] as const) {
    const html = insertOf(kind, "index.html");
    assert.match(html, /\sclass="/, `${kind}: className is not an HTML attribute`);
    assert.doesNotMatch(html, /className/);
    // The same actions bound for a .tsx file keep the JSX spelling.
    assert.match(insertOf(kind, "src/App.tsx"), /className=/);
  }

  // `<div />` in HTML is a div that never closes, and it would swallow every
  // sibling after it. A self-closing non-void element has to become a pair —
  // while a void one must NOT grow a closing tag.
  assert.match(insertOf("div", "index.html"), /^<div [^>]*><\/div>$/);
  assert.match(insertOf("image", "index.html"), /^<img [^>]*\/>$/);
});

test("a copied section is written in the language it was copied from", () => {
  // A pasted snippet is a verbatim slice of a real file, so it arrives already
  // in that file's spelling and there is no translation for an arbitrary
  // subtree — the palette's one-element markup is the only thing `toHtmlSnippet`
  // can respell. So the language travels with the snippet, and a mismatch is
  // refused rather than guessed at.
  const jsxSection =
    '<section className="card">\n  <h2>Title</h2>\n</section>';
  const htmlSection = '<section class="card">\n  <h2>Title</h2>\n</section>';
  const paste = (snippet: string, lang: "jsx" | "html", file: string) =>
    opsForFile([{ ...insertAction(), snippet, lang }], file);

  // Same language: written exactly as copied, down to the newline.
  const intoTsx = paste(jsxSection, "jsx", "src/App.tsx");
  assert.deepEqual(intoTsx.failures, []);
  assert.equal((intoTsx.ops[0] as { snippet: string }).snippet, jsxSection);

  const intoHtml = paste(htmlSection, "html", "index.html");
  assert.deepEqual(intoHtml.failures, []);
  assert.equal((intoHtml.ops[0] as { snippet: string }).snippet, htmlSection);

  // Crossing languages is refused, in both directions — and refused with a
  // reason, never dropped.
  const jsxIntoHtml = paste(jsxSection, "jsx", "index.html");
  assert.equal(jsxIntoHtml.ops.length, 0);
  assert.equal(jsxIntoHtml.failures.length, 1, "a JSX subtree into an HTML page");

  const htmlIntoTsx = paste(htmlSection, "html", "src/App.tsx");
  assert.equal(htmlIntoTsx.ops.length, 0);
  assert.match(htmlIntoTsx.failures[0], /HTML page/);
});

test("a pasted element is restyled in its own spelling, not JSX's", () => {
  // A pasted snippet is a verbatim slice of the file it came from, so a staged
  // insert is no longer always JSX. Folding a restyle in as `className` put a
  // JSX attribute into an HTML page, where it styles nothing — the edit
  // silently did not happen and the original classes stayed.
  const htmlPaste: EditAction = {
    kind: "insert",
    id: PENDING,
    target: { dedupId: "index.html@3", file: "index.html", index: 3 },
    position: "after",
    snippet: '<p class="text-base">Hello</p>',
    lang: "html",
    preview: '<p class="text-base">Hello</p>',
    label: "p",
  };
  const restyle: EditAction = {
    kind: "class",
    target: { dedupId: PENDING, file: "index.html", index: -1 },
    before: "text-base",
    after: "text-lg font-bold",
    component: null,
  };
  const { ops, failures } = opsForFile([htmlPaste, restyle], "index.html");
  assert.deepEqual(failures, []);
  const snippet = (ops[0] as { snippet: string }).snippet;
  assert.equal(snippet, '<p class="text-lg font-bold">Hello</p>', snippet);
  assert.doesNotMatch(snippet, /className/, "className means nothing in HTML");

  // The palette's own inserts are still JSX and still respelled on the way in.
  const fromPalette = opsForFile([{ ...insertAction() }, {
    kind: "class",
    target: { dedupId: PENDING, file: "index.html", index: -1 },
    before: "text-base",
    after: "text-lg",
    component: null,
  }], "index.html");
  assert.deepEqual(fromPalette.failures, []);
  assert.match((fromPalette.ops[0] as { snippet: string }).snippet, /class="text-lg"/);
});

test("discarding an insert takes the edits made to it with it", () => {
  // The deadlock this prevents: an edit addressed to an insert that is no
  // longer staged is refused by opsForFile — correctly, and permanently. A
  // review panel that dropped one row at a time could leave a program that
  // could never be saved, while the chat refuses to run for as long as any
  // edit targets the file. No way forward and no way back.
  const program: EditAction[] = [
    insertAction(),
    {
      kind: "text",
      target: pendingTarget,
      before: "Text",
      after: "Hello",
      component: null,
    },
    {
      kind: "class",
      target,
      before: "p-2",
      after: "p-4",
      component: null,
    },
  ];
  // Proof the orphan is fatal, so the guard below is load-bearing.
  assert.equal(opsForFile(program.slice(1), "src/App.tsx").failures.length, 1);

  const left = withoutAction(program, 0);
  assert.deepEqual(
    left.map((a) => a.kind),
    ["class"],
    "the insert and the text typed into it go together",
  );
  assert.deepEqual(opsForFile(left, "src/App.tsx").failures, []);

  // Discarding an ordinary edit takes only itself.
  assert.equal(withoutAction(program, 2).length, 2);
  // And an index that names nothing changes nothing.
  assert.equal(withoutAction(program, 9), program);
});

test("an element on its way out cannot also be staged against", () => {
  // Reported as "save failed: insert: the element it is placed against is
  // being deleted" — a program that could be built and then never saved, and
  // which blocked the chat too (it refuses while any edit targets the file).
  // The write-back was right to refuse; the editor was wrong to let it happen.
  const other = { dedupId: "src/App.tsx@7", file: "src/App.tsx", index: 7 };
  const paste: EditAction = {
    kind: "insert",
    id: PENDING,
    target,
    position: "after",
    snippet: "<section />",
    lang: "jsx",
    preview: "<section></section>",
    label: "Card · section",
  };
  const remove: EditAction = { kind: "remove", target, label: "Card · section" };

  // Paste beside it, then delete it — the order the bug was hit in.
  const refused = stagingConflict([paste], remove);
  assert.ok(refused, "deleting the anchor of a staged paste must be refused");
  assert.match(refused as string, /Card · section/, "it names what is in the way");
  assert.match(refused as string, /⌘S/, "and what to do about it");

  // And the other order: pasting against something already staged for
  // deletion has nothing to sit next to.
  assert.ok(stagingConflict([remove], paste));

  // A move is the same rule — its destination has to still exist. That one
  // never even reached a refusal: the write-back appends into a chunk it is
  // removing, and content appended to a removed chunk is dropped in silence.
  const move: EditAction = {
    kind: "move",
    target: other,
    to: target,
    position: "inside",
    label: "Row · li",
  };
  assert.ok(stagingConflict([move], remove), "delete a move's destination");
  assert.ok(stagingConflict([remove], move), "move onto a deleted element");
  // Its source, too: the write-back refuses that one loudly, which is still a
  // program that can be built and never saved.
  assert.ok(stagingConflict([{ ...move, to: other, target }], remove));
});

test("staging stays out of the way of everything that is fine", () => {
  const elsewhere = { dedupId: "src/App.tsx@9", file: "src/App.tsx", index: 9 };
  const remove: EditAction = { kind: "remove", target, label: "Card" };
  const paste: EditAction = {
    kind: "insert",
    id: PENDING,
    target: elsewhere,
    position: "after",
    snippet: "<section />",
    lang: "jsx",
    preview: "<section></section>",
    label: "Card",
  };
  // Delete one thing, paste beside another: an ordinary program.
  assert.equal(stagingConflict([remove], paste), null);
  assert.equal(stagingConflict([paste], remove), null);
  // Value edits are never in conflict with anything — they are also the ones
  // staged hundreds of times during a drag, so the check must fall straight
  // through for them.
  const classEdit: EditAction = {
    kind: "class",
    target,
    before: "p-2",
    after: "p-4",
    component: null,
  };
  assert.equal(stagingConflict([remove], classEdit), null);
  assert.equal(stagingConflict([], remove), null);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
