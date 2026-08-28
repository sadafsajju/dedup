// Merge-proposal parsing + the review diff. Run: pnpm test:proposal
//
// These two are the frontend half of the merge safety model. The parser is
// the boundary the model's reply crosses, and the diff is the only thing the
// user sees before approving a whole-project rewrite — so a parser that
// half-understands a reply, or a diff that hides a changed line, is a defect
// of the same kind as a bad write.
import assert from "node:assert/strict";
import { diffLines, diffStat, toHunks } from "../src/lib/diff.ts";
import { buildMergePrompt, parseMergeReply } from "../src/lib/mergeProposal.ts";
import { gateSummary, gatesPassed, hmrGate } from "../src/lib/mergeFlow.ts";
import { combinedConfidence, visualNote } from "../src/lib/visualPass.ts";
import type { GateResult, MergePlan } from "../src/lib/types.ts";

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

const PLAN: MergePlan = {
  ok: true,
  canonicalSuggestion: { name: "Card", file: "src/components/Card.tsx" },
  members: [
    {
      name: "Card",
      file: "src/components/Card.tsx",
      exportKind: "named",
      source: "export function Card({ title }) { return <div className=\"p-4\">{title}</div>; }",
      props: ["title"],
      behavior: { hooks: [], handlers: [], calls: [], statements: 1 },
      otherDeclarations: [],
      callSites: 3,
      fileIsDedicated: true,
    },
    {
      name: "ProductCard",
      file: "src/components/ProductCard.tsx",
      exportKind: "named",
      source: "export function ProductCard({ title }) { return <div className=\"p-6\">{title}</div>; }",
      props: ["title"],
      behavior: { hooks: ["useAnalytics"], handlers: [], calls: [], statements: 2 },
      otherDeclarations: [],
      callSites: 1,
      fileIsDedicated: true,
    },
  ],
  callSites: [
    {
      file: "src/Home.tsx",
      component: "Card",
      localName: "Card",
      line: 7,
      col: 6,
      attrs: [{ name: "title", spread: false, text: 'title="a"', value: "a" }],
      text: '<Card title="a" />',
    },
  ],
  behaviorDiff: { differs: true, detail: "useAnalytics — only in ProductCard" },
  reExports: [],
  filesScanned: 12,
};

const GOOD_REPLY = `Here is the merge.

FILE: src/components/Card.tsx
NAME: Card
SUMMARY: Add a variant prop with a class map covering both paddings

\`\`\`tsx
const styles = { default: "p-4", product: "p-6" };

export function Card({ title, variant = "default" }) {
  return <div className={styles[variant]}>{title}</div>;
}
\`\`\`

PROPS:
Card: {}
ProductCard: {"variant":"product"}

NOTES:
- ProductCard called useAnalytics; that hook now runs only when variant is "product".
`;

// --- prompt ------------------------------------------------------------------

test("the prompt carries sources, real call sites and the behaviour warning", () => {
  const prompt = buildMergePrompt(PLAN);
  assert.match(prompt, /export function ProductCard/);
  assert.match(prompt, /src\/Home\.tsx:7/);
  assert.match(prompt, /differ in behaviour/);
  assert.match(prompt, /useAnalytics — only in ProductCard/);
  assert.match(prompt, /List props for exactly these members: Card, ProductCard/);
});

// --- parsing -----------------------------------------------------------------

test("a well-formed reply parses into a proposal", () => {
  const p = parseMergeReply(GOOD_REPLY, PLAN);
  assert.equal(p.name, "Card");
  assert.equal(p.file, "src/components/Card.tsx");
  assert.match(p.source, /variant = "default"/);
  assert.equal(p.summary, "Add a variant prop with a class map covering both paddings");
  assert.deepEqual(p.mapping, [
    { name: "Card", file: "src/components/Card.tsx", props: {} },
    {
      name: "ProductCard",
      file: "src/components/ProductCard.tsx",
      props: { variant: "product" },
    },
  ]);
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0], /useAnalytics/);
});

test("a member the model forgot is a refusal, not a silent empty prop set", () => {
  const reply = GOOD_REPLY.replace('ProductCard: {"variant":"product"}\n', "");
  assert.throws(() => parseMergeReply(reply, PLAN), /no props for ProductCard/);
});

test("a source block that never mentions the promised name is refused", () => {
  const reply = GOOD_REPLY.replace(/export function Card/, "export function Panel");
  assert.throws(() => parseMergeReply(reply, PLAN), /never mentions/);
});

test("a path escaping the project is refused", () => {
  const reply = GOOD_REPLY.replace(
    "FILE: src/components/Card.tsx",
    "FILE: ../../etc/Card.tsx",
  );
  assert.throws(() => parseMergeReply(reply, PLAN), /outside the project/);
});

test("prop values that could break out of the JSX are refused", () => {
  const reply = GOOD_REPLY.replace(
    '{"variant":"product"}',
    '{"variant":"x\\" onClick={steal()} y=\\""}',
  );
  assert.throws(() => parseMergeReply(reply, PLAN), /can't be written into JSX/);
});

test("a prop value that isn't a string, number or boolean is refused", () => {
  const reply = GOOD_REPLY.replace('{"variant":"product"}', '{"items":["a","b"]}');
  assert.throws(() => parseMergeReply(reply, PLAN), /only strings, numbers and booleans/);
});

test("a reply with no source block is refused", () => {
  const reply = "FILE: a.tsx\nNAME: Card\nPROPS:\nCard: {}\nProductCard: {}";
  assert.throws(() => parseMergeReply(reply, PLAN), /no component source block/);
});

test("`none` and booleans/numbers are accepted prop forms", () => {
  const reply = GOOD_REPLY.replace(
    'Card: {}\nProductCard: {"variant":"product"}',
    'Card: none\nProductCard: {"elevated":true,"level":2}',
  );
  const p = parseMergeReply(reply, PLAN);
  assert.deepEqual(p.mapping[0].props, {});
  assert.deepEqual(p.mapping[1].props, { elevated: true, level: 2 });
});

// --- diff --------------------------------------------------------------------

test("an unchanged file diffs to no hunks", () => {
  const text = "a\nb\nc\n";
  const lines = diffLines(text, text);
  assert.deepEqual(toHunks(lines), []);
  assert.deepEqual(diffStat(lines), { added: 0, removed: 0 });
});

test("a changed line shows as one removal and one addition with line numbers", () => {
  const lines = diffLines("a\nb\nc", "a\nB\nc");
  const changed = lines.filter((l) => l.op !== "context");
  assert.deepEqual(
    changed.map((l) => [l.op, l.text]),
    [
      ["remove", "b"],
      ["add", "B"],
    ],
  );
  assert.equal(changed[0].before, 2);
  assert.equal(changed[0].after, null);
  assert.equal(changed[1].after, 2);
});

test("every changed line lands inside a hunk, however far apart", () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const after = before
    .split("\n")
    .map((l, i) => (i === 3 || i === 150 ? l + " changed" : l))
    .join("\n");
  const lines = diffLines(before, after);
  const hunks = toHunks(lines);
  assert.equal(hunks.length, 2, "distant changes should not be joined by 150 context lines");
  const shown = hunks.flatMap((h) => h.lines).filter((l) => l.op !== "context");
  assert.equal(shown.length, 4, "two changed lines = two removals + two additions");
  assert.deepEqual(diffStat(lines), { added: 2, removed: 2 });
});

test("a created file is all additions", () => {
  const lines = diffLines("", "a\nb\n");
  assert.ok(lines.every((l) => l.op === "add"));
  assert.deepEqual(diffStat(lines), { added: 2, removed: 0 });
});

test("a retired file is all removals", () => {
  const lines = diffLines("a\nb\n", "");
  assert.ok(lines.every((l) => l.op === "remove"));
  assert.deepEqual(diffStat(lines), { added: 0, removed: 2 });
});

test("an import swap in a real-looking file diffs to just those lines", () => {
  const before = `import { Card } from "./components/Card";
import { ProductCard } from "./components/ProductCard";

export function Home() {
  return (
    <main>
      <Card title="a" />
      <ProductCard title="b" />
    </main>
  );
}
`;
  const after = `import { Card } from "./components/Card";

export function Home() {
  return (
    <main>
      <Card title="a" />
      <Card title="b" variant="product" />
    </main>
  );
}
`;
  const lines = diffLines(before, after);
  assert.deepEqual(diffStat(lines), { added: 1, removed: 2 });
  const removed = lines.filter((l) => l.op === "remove").map((l) => l.text.trim());
  assert.deepEqual(removed, [
    'import { ProductCard } from "./components/ProductCard";',
    '<ProductCard title="b" />',
  ]);
});

// --- gates ---------------------------------------------------------------
//
// The rule these pin is the one the whole guarded merge rests on: a check
// that could not run is not a check that passed. Every "skipped" below is a
// real situation — a JS project with no tsc, a project with no build script,
// an artboard scrolled off screen — and in each of them the merge is allowed
// to stay, but the review has to say the evidence was weaker.

const gate = (
  kind: GateResult["kind"],
  status: GateResult["status"],
): GateResult => ({ kind, status, command: "x", output: "", durationMs: 0 });

test("a failed gate blocks the merge; a skipped one does not", () => {
  assert.equal(gatesPassed([gate("typecheck", "passed"), gate("build", "passed")]), true);
  assert.equal(gatesPassed([gate("typecheck", "passed"), gate("build", "skipped")]), true);
  assert.equal(gatesPassed([gate("typecheck", "failed"), gate("build", "passed")]), false);
});

test("the summary names what failed, and never hides what was unavailable", () => {
  assert.match(gateSummary([gate("typecheck", "failed"), gate("build", "passed")]), /typecheck failed/);
  assert.equal(gateSummary([gate("typecheck", "passed"), gate("visual", "passed")]), "all checks passed");
  assert.match(
    gateSummary([gate("typecheck", "passed"), gate("visual", "skipped")]),
    /visual unavailable/,
    "a skipped gate must show up in the summary, not round up to a clean pass",
  );
});

test("no dev server means the live-compile check is skipped, not passed", () => {
  const off = hmrGate(false, [], 0);
  assert.equal(off.status, "skipped");
  assert.match(off.output, /isn't running/);

  const clean = hmrGate(true, [], 0);
  assert.equal(clean.status, "passed");

  const broken = hmrGate(true, [{ source: "vite", content: "TS2322: nope" }], 0);
  assert.equal(broken.status, "failed");
  assert.match(broken.output, /TS2322/);
});

// --- visual signal --------------------------------------------------------

test("confidence is untouched until the visual pass has something to say", () => {
  assert.equal(combinedConfidence(0.9, undefined), 0.9);
  assert.equal(
    combinedConfidence(0.9, { score: null, hashed: [], unrendered: ["a", "b"] }),
    0.9,
    "members that cannot render must not drag a cluster's score down",
  );
});

test("a visual disagreement pulls confidence down and says so", () => {
  const agree = combinedConfidence(0.9, { score: 1, hashed: ["a", "b"], unrendered: [] });
  const differ = combinedConfidence(0.9, { score: 0.4, hashed: ["a", "b"], unrendered: [] });
  assert.ok(differ < 0.9 && agree > 0.9, `${differ} / ${agree}`);
  assert.match(
    visualNote({ score: 0.4, hashed: ["a", "b"], unrendered: [] }) ?? "",
    /render quite differently/,
  );
  assert.match(
    visualNote({ score: 0.95, hashed: ["a", "b"], unrendered: [] }) ?? "",
    /match at 95%/,
  );
});

test("an unrenderable member is reported rather than averaged away", () => {
  assert.match(
    visualNote({ score: null, hashed: [], unrendered: ["a"] }) ?? "",
    /structure alone/,
  );
  assert.equal(visualNote(undefined), null, "no pass run = nothing to say");
});

console.log(`\n${passed} passed`);
