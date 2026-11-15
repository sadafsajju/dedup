// Tests for chat edit-block parsing and application.
// Run: pnpm test:chat  (node --experimental-strip-types)
import assert from "node:assert/strict";
import {
  applyEditBlocks,
  applyProgram,
  parseChatReply,
  pickGeneratedImage,
  retargetReferences,
  undecoratePath,
} from "../src/lib/chatEdits.ts";
import { imageRequestPrompt, systemPromptFor } from "../src/lib/chat.ts";

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

// --- the agent protocol: asking for context, and editing more than one file

test("tool lines are a context request, not an edit", () => {
  const r = parseChatReply(
    "I need to see the header first.\nTOOL: grep <header\nTOOL: read src/App.tsx",
  );
  assert.equal(r.kind, "tools");
  if (r.kind !== "tools") return;
  assert.deepEqual(r.calls, [
    { tool: "grep", arg: "<header" },
    { tool: "read", arg: "src/App.tsx" },
  ]);
  assert.match(r.note, /header first/);
});

test("TOOL: list needs no argument; a bare read is ignored", () => {
  const r = parseChatReply("TOOL: list\nTOOL: read");
  assert.equal(r.kind, "tools");
  if (r.kind !== "tools") return;
  assert.deepEqual(r.calls, [{ tool: "list", arg: "" }]);
});

test("an edit reply wins over stray tool lines", () => {
  const r = parseChatReply(
    "TOOL: read src/App.tsx\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\nSUMMARY: x",
  );
  assert.equal(r.kind, "blocks");
});

test("blocks address their own file; a program spans several", () => {
  const r = parseChatReply(
    [
      "<<<<<<< SEARCH src/Card.tsx",
      '      <h3 className="text-lg">{title}</h3>',
      "=======",
      '      <Title>{title}</Title>',
      ">>>>>>> REPLACE",
      "<<<<<<< SEARCH src/Title.tsx",
      "const x = 1;",
      "=======",
      "const x = 2;",
      ">>>>>>> REPLACE",
      "SUMMARY: Use the Title component.",
    ].join("\n"),
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.equal(r.blocks[0].file, "src/Card.tsx");
  const out = applyProgram(
    new Map([
      ["src/Card.tsx", FILE],
      ["src/Title.tsx", "const x = 1;\n"],
    ]),
    r.blocks,
    r.creates,
    null,
  );
  assert.equal(out.size, 2);
  assert.match(out.get("src/Card.tsx") as string, /<Title>/);
  assert.match(out.get("src/Title.tsx") as string, /const x = 2;/);
});

test("an unaddressed block falls back to the file in play", () => {
  const r = parseChatReply(
    '<<<<<<< SEARCH\n    <div className="bg-white p-4 shadow">\n=======\n    <div className="bg-white p-4">\n>>>>>>> REPLACE\nSUMMARY: x',
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  const out = applyProgram(new Map([["a.tsx", FILE]]), r.blocks, [], "a.tsx");
  assert.doesNotMatch(out.get("a.tsx") as string, /shadow/);
});

test("editing a file the model never read is refused", () => {
  const r = parseChatReply(
    "<<<<<<< SEARCH src/Unseen.tsx\nfoo\n=======\nbar\n>>>>>>> REPLACE\nSUMMARY: x",
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.throws(
    () => applyProgram(new Map([["a.tsx", FILE]]), r.blocks, [], "a.tsx"),
    /never read/,
  );
});

test("CREATE adds a whole file; overwriting one is refused", () => {
  const r = parseChatReply(
    [
      "<<<<<<< CREATE src/Title.tsx",
      "export const Title = () => <h3 />;",
      ">>>>>>> END",
      "SUMMARY: Extract Title.",
    ].join("\n"),
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.equal(r.creates.length, 1);
  const out = applyProgram(new Map(), [], r.creates, null);
  assert.match(out.get("src/Title.tsx") as string, /export const Title/);
  assert.throws(
    () => applyProgram(new Map([["src/Title.tsx", "x"]]), [], r.creates, null),
    /already exists/,
  );
});

test("CREATE without a path, and an unterminated one, throw", () => {
  assert.throws(() => parseChatReply("<<<<<<< CREATE\nx\n>>>>>>> END"), /file path/);
  assert.throws(
    () => parseChatReply("<<<<<<< CREATE a.tsx\nx"),
    /unterminated/,
  );
});

test("a fenced snippet without a SUMMARY stays an answer", () => {
  // The dangerous case: a prose reply that illustrates with a code sample.
  // Read as a whole-file rewrite it would blank the rest of the module.
  const r = parseChatReply(
    "You could write it like this:\n```tsx\n<div className=\"p-4\" />\n```\nBut the class is computed at runtime, so I can't change it safely.",
  );
  assert.equal(r.kind, "answer");
});

test("ASSET names a file the agent generated, alongside the markup using it", () => {
  // The reply that motivated this: an agent that can generate an image cannot
  // type a PNG out as text, so it says where it left one and edits the page to
  // point at it — both in the same all-or-nothing proposal.
  const r = parseChatReply(
    [
      "<<<<<<< ASSET public/hero.png",
      "/Users/me/.codex/generated_images/abc/exec-def.png",
      ">>>>>>> END",
      "<<<<<<< SEARCH index.html",
      "  <header>",
      "=======",
      '  <header>\n    <img src="/hero.png" alt="A lighthouse at dusk" />',
      ">>>>>>> REPLACE",
      "SUMMARY: add a generated hero image",
    ].join("\n"),
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.deepEqual(r.assets, [
    {
      file: "public/hero.png",
      source: "/Users/me/.codex/generated_images/abc/exec-def.png",
    },
  ]);
  assert.equal(r.blocks.length, 1, "the edit using it rides along");
  assert.equal(r.summary, "add a generated hero image");
});

test("an ASSET block on its own is still an edit, not an answer", () => {
  const r = parseChatReply(
    "<<<<<<< ASSET img/logo.webp\n/tmp/x/out.webp\n>>>>>>> END\nSUMMARY: add the logo",
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.equal(r.assets.length, 1);
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.creates, []);
});

test("a malformed ASSET block throws rather than importing a guess", () => {
  // No destination: there is nowhere to put it.
  assert.throws(
    () => parseChatReply("<<<<<<< ASSET\n/tmp/x.png\n>>>>>>> END"),
    /destination path/,
  );
  // A body that is not exactly one path. An ASSET block is a *reference*, not
  // content, so there is nothing here to salvage — two paths is a model that
  // has misunderstood, and picking one of them would be dedup guessing which.
  for (const body of ["", "/tmp/a.png\n/tmp/b.png", "here it is: no path"]) {
    const reply = `<<<<<<< ASSET public/a.png\n${body}\n>>>>>>> END`;
    if (body === "here it is: no path") {
      // One line, so it parses — and is refused later by the import gate,
      // which is the only side that can tell a real path from a sentence.
      assert.equal(parseChatReply(reply).kind, "blocks");
      continue;
    }
    assert.throws(() => parseChatReply(reply), /exactly one file path/, body);
  }
  assert.throws(
    () => parseChatReply("<<<<<<< ASSET a.png\n/tmp/x.png"),
    /unterminated/,
  );
  // Markers still cannot nest.
  assert.throws(
    () => parseChatReply("<<<<<<< ASSET a.png\n<<<<<<< CREATE b.tsx\nx\n>>>>>>> END"),
    /nested/,
  );
});

test("a path wearing the prompt's own placeholder brackets is still a path", () => {
  // Reported from a real session: the prompt writes placeholders as
  // <project-relative path>, the model copied the brackets, and the import
  // gate reported that a PNG "cannot be saved as .png>" — which is a
  // confusing way to say the model made a typo. A real path wears no
  // brackets, quotes or backticks, so taking them off is unambiguous.
  const r = parseChatReply(
    [
      "<<<<<<< ASSET <public/hero.png>",
      "<C:/tmp/gen/out.png>",
      ">>>>>>> END",
      "SUMMARY: add the hero",
    ].join("\n"),
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.deepEqual(r.assets, [{ file: "public/hero.png", source: "C:/tmp/gen/out.png" }]);

  // Unpaired too. A model that opens a bracket does not reliably close it,
  // and `public/hero.png>` produced exactly the same unreadable complaint as
  // the balanced form did — the second report of this bug was this shape.
  for (const worn of [
    "<public/hero.png>",
    "public/hero.png>",
    "<public/hero.png",
    '"<public/hero.png>"',
  ]) {
    assert.equal(undecoratePath(worn), "public/hero.png", worn);
  }

  // Every marker shares the same undressing, and quotes and backticks are the
  // same reflex — TOOL arguments have always been stripped this way.
  assert.equal(undecoratePath('"src/App.tsx"'), "src/App.tsx");
  assert.equal(undecoratePath("`src/App.tsx`"), "src/App.tsx");
  assert.equal(undecoratePath('"<src/App.tsx>"'), "src/App.tsx", "two layers");
  // And a path that wears nothing is returned untouched, including one whose
  // name legitimately contains a quote-ish character. Quotes are only taken
  // off in balanced pairs for exactly this reason — angle brackets can be
  // stripped unpaired because they are never legal in a path, apostrophes
  // cannot because they are.
  assert.equal(undecoratePath("src/it's/App.tsx"), "src/it's/App.tsx");
  assert.equal(undecoratePath("img/it's.png"), "img/it's.png");

  const create = parseChatReply(
    '<<<<<<< CREATE "src/Title.tsx"\nexport const T = () => null;\n>>>>>>> END\nSUMMARY: add it',
  );
  assert.equal(create.kind, "blocks");
  if (create.kind !== "blocks") return;
  assert.equal(create.creates[0].file, "src/Title.tsx");

  // A bare marker still means "the file in play", not a file called "<>".
  const bare = parseChatReply(
    "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\nSUMMARY: x",
  );
  assert.equal(bare.kind, "blocks");
  if (bare.kind !== "blocks") return;
  assert.equal(bare.blocks[0].file, null);
});

// ── IMAGE: an image asked of another agent ──────────────────────────────

test("IMAGE names a destination and describes the picture, beside the markup", () => {
  const r = parseChatReply(
    [
      "<<<<<<< IMAGE public/hero.png",
      "A wide isometric illustration of a shipping container,",
      "warm orange palette, 16:9.",
      ">>>>>>> END",
      "<<<<<<< SEARCH src/Hero.tsx",
      "<div />",
      "=======",
      '<img src="/hero.png" alt="Container" />',
      ">>>>>>> REPLACE",
      "SUMMARY: add a hero illustration",
    ].join("\n"),
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.deepEqual(r.images, [
    {
      file: "public/hero.png",
      prompt: "A wide isometric illustration of a shipping container,\nwarm orange palette, 16:9.",
    },
  ]);
  assert.equal(r.assets.length, 0, "a request is not an import");
  assert.equal(r.blocks.length, 1);
});

test("an IMAGE block on its own is still an edit, and its path is undecorated", () => {
  const r = parseChatReply(
    "<<<<<<< IMAGE <img/logo.webp>\na flat monogram\n>>>>>>> END\nSUMMARY: add a logo",
  );
  assert.equal(r.kind, "blocks");
  if (r.kind !== "blocks") return;
  assert.equal(r.images[0].file, "img/logo.webp");
});

test("a malformed IMAGE block throws rather than generating a guess", () => {
  assert.throws(
    () => parseChatReply("<<<<<<< IMAGE a.png\n\n>>>>>>> END"),
    /describe the image/,
  );
  assert.throws(() => parseChatReply("<<<<<<< IMAGE\nsomething\n>>>>>>> END"), /destination/);
  assert.throws(() => parseChatReply("<<<<<<< IMAGE a.png\na cat"), /unterminated/);
});

test("pickGeneratedImage takes the one generated path from the answer", () => {
  assert.equal(
    pickGeneratedImage(
      "<<<<<<< ASSET public/hero.png\n/Users/me/.codex/generated_images/a1.png\n>>>>>>> END",
    ),
    "/Users/me/.codex/generated_images/a1.png",
  );
});

test("pickGeneratedImage refuses anything but exactly one image", () => {
  // Prose: the agent couldn't, and says why — that is the message to show.
  assert.throws(() => pickGeneratedImage("I can't generate images here."), /didn't produce an image: I can't/);
  // Two images where one was asked for.
  assert.throws(
    () =>
      pickGeneratedImage(
        "<<<<<<< ASSET a.png\n/x/1.png\n>>>>>>> END\n<<<<<<< ASSET b.png\n/x/2.png\n>>>>>>> END",
      ),
    /2 images/,
  );
  // An edit riding along: a second agent writing source nobody asked it to.
  assert.throws(
    () =>
      pickGeneratedImage(
        "<<<<<<< ASSET a.png\n/x/1.png\n>>>>>>> END\n<<<<<<< CREATE src/x.ts\nexport {};\n>>>>>>> END",
      ),
    /code changes/,
  );
  // Malformed markers fail loudly, attributed to the answer.
  assert.throws(() => pickGeneratedImage("<<<<<<< ASSET a.png\n/x/1.png"), /malformed/);
});

test("the image request is answerable by the picker it will be read with", () => {
  const prompt = imageRequestPrompt("public/hero.png", "a container ship");
  assert.match(prompt, /public\/hero\.png/);
  assert.match(prompt, /a container ship/);
  assert.match(prompt, /<<<<<<< ASSET public\/hero\.png/);
});

test("delegation is offered only to a backend that can't generate, and only when someone can", () => {
  const plain = systemPromptFor("src/App.tsx");
  assert.doesNotMatch(plain, /IMAGE|ASSET/, "no generator connected: neither directive");

  const delegating = systemPromptFor("src/App.tsx", false, false, "Codex");
  assert.match(delegating, /<<<<<<< IMAGE/);
  assert.match(delegating, /ask Codex/);
  assert.doesNotMatch(delegating, /<<<<<<< ASSET/, "it never names a source path");

  const generating = systemPromptFor("src/App.tsx", false, true, "Codex");
  assert.match(generating, /<<<<<<< ASSET/);
  assert.doesNotMatch(generating, /<<<<<<< IMAGE/, "a generator has no reason to send for one");
});

test("a renamed image takes the references this edit added with it", () => {
  const before = '<section class="hero">\n  <div class="ph">image</div>\n</section>\n';
  const after =
    '<section class="hero">\n  <img src="images/hero-container-lift.jpg" alt="Container">\n</section>\n';
  const [out] = retargetReferences(
    [{ file: "Main.dc.html", before, after }],
    "images/hero-container-lift.jpg",
    "images/hero-container-lift.png",
  );
  assert.equal(
    out.after,
    '<section class="hero">\n  <img src="images/hero-container-lift.png" alt="Container">\n</section>\n',
  );
});

test("every spelling of the path is a reference, but a longer name is not", () => {
  const after = [
    'src="./images/hero.jpg"',
    "url(/images/hero.jpg)",
    "srcset='hero.jpg 2x'",
    'src="images/big-hero.jpg"',
    'src="images/hero.jpg.bak"',
  ].join("\n");
  const [out] = retargetReferences(
    [{ file: "a.html", before: "", after }],
    "images/hero.jpg",
    "images/hero.png",
  );
  assert.deepEqual(out.after.split("\n"), [
    'src="./images/hero.png"',
    "url(/images/hero.png)",
    "srcset='hero.png 2x'",
    'src="images/big-hero.jpg"',
    'src="images/hero.jpg.bak"',
  ]);
});

test("a name the user's file already used is refused, not renamed", () => {
  assert.throws(
    () =>
      retargetReferences(
        [{ file: "a.html", before: '<img src="hero.jpg">', after: '<img src="hero.jpg"><img src="hero.jpg">' }],
        "hero.jpg",
        "hero.png",
      ),
    /already mentioned hero\.jpg/,
  );
});

test("files that don't mention the image, and a new file, are handled as such", () => {
  const files = [
    { file: "a.css", before: "body{}", after: "body{margin:0}" },
    { file: "new.html", before: null, after: '<img src="x.jpg">' },
  ];
  const out = retargetReferences(files, "x.jpg", "x.png");
  assert.equal(out[0], files[0], "an untouched file is the same object");
  assert.equal(out[1].after, '<img src="x.png">');
  assert.equal(retargetReferences(files, "x.png", "x.png"), files, "same name: nothing to do");
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
