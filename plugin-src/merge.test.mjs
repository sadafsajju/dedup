// Guarded-merge codemod tests. Run: pnpm test:merge
// Tests the BUILT bundle, as a child process, the way the Rust core runs it —
// a merge that only works from source is a merge that doesn't ship.
//
// The bar these assert is the one from PRD §6: a merge either lands whole and
// correct, or the project is left exactly as it was. Every refusal case here
// exists because the alternative is a corrupted user codebase.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/assets/dedup-merge.mjs",
);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
}

function run(request) {
  const out = execFileSync("node", [BUNDLE], { input: JSON.stringify(request) });
  return JSON.parse(out.toString().trim().split("\n").pop());
}

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-merge-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

// --- fixtures ---------------------------------------------------------------

const CARD = `export function Card({ title, body }) {
  return (
    <div className="rounded-lg border p-4 shadow-sm">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-gray-600">{body}</p>
    </div>
  );
}
`;

const PRODUCT_CARD = `export function ProductCard({ title, body }) {
  return (
    <div className="rounded-lg border p-6 shadow-md">
      <h3 className="text-lg font-bold">{title}</h3>
      <p className="text-sm text-slate-600">{body}</p>
    </div>
  );
}
`;

const HOME = `import { Card } from "./components/Card";
import { ProductCard } from "./components/ProductCard";

export function Home() {
  return (
    <main>
      <Card title="a" body="b" />
      <ProductCard title="c" body="d" />
    </main>
  );
}
`;

/** The canonical component a review would have approved. */
const CANONICAL = `const styles = {
  default: "rounded-lg border p-4 shadow-sm",
  product: "rounded-lg border p-6 shadow-md",
};

export function Card({ title, body, variant = "default" }) {
  return (
    <div className={styles[variant]}>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="text-sm text-gray-600">{body}</p>
    </div>
  );
}
`;

const baseProject = () =>
  fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": PRODUCT_CARD,
    "src/Home.tsx": HOME,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }),
  });

const MEMBERS = [
  { file: "src/components/Card.tsx", name: "Card" },
  { file: "src/components/ProductCard.tsx", name: "ProductCard" },
];

const MAPPING = [
  { file: "src/components/Card.tsx", name: "Card", props: {} },
  {
    file: "src/components/ProductCard.tsx",
    name: "ProductCard",
    props: { variant: "product" },
  },
];

// --- plan --------------------------------------------------------------------

test("plan reports each member's source, props and call sites", () => {
  const root = baseProject();
  const res = run({ cmd: "plan", root, members: MEMBERS });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.members.length, 2);
  const card = res.members.find((m) => m.name === "Card");
  assert.match(card.source, /export function Card/);
  assert.deepEqual(card.props, ["title", "body"]);
  assert.equal(card.fileIsDedicated, true);
  assert.equal(card.exportKind, "named");
  // One use of each, both in Home.
  assert.equal(res.callSites.length, 2);
  assert.ok(res.callSites.every((s) => s.file === "src/Home.tsx"));
  const product = res.callSites.find((s) => s.component === "ProductCard");
  assert.deepEqual(
    product.attrs.map((a) => a.name),
    ["title", "body"],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("a same-named component from elsewhere is not a call site", () => {
  // The trap the name-based counter falls into: `<Card>` here is a different
  // Card entirely, imported from a library. Renaming it would be a bug.
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": PRODUCT_CARD,
    "src/Other.tsx": `import { Card } from "some-ui-kit";
export function Other() {
  return <Card title="not ours" />;
}
`,
    "src/Home.tsx": HOME,
  });
  const res = run({ cmd: "plan", root, members: MEMBERS });
  assert.equal(res.ok, true, res.error);
  assert.ok(
    !res.callSites.some((s) => s.file === "src/Other.tsx"),
    `library Card was mistaken for ours: ${JSON.stringify(res.callSites)}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("call sites reached through a tsconfig path alias are found", () => {
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": PRODUCT_CARD,
    "src/Aliased.tsx": `import { ProductCard } from "@/components/ProductCard";
export function Aliased() {
  return <ProductCard title="x" body="y" />;
}
`,
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }),
  });
  const res = run({ cmd: "plan", root, members: MEMBERS });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.callSites.length, 1);
  assert.equal(res.callSites[0].file, "src/Aliased.tsx");
  fs.rmSync(root, { recursive: true, force: true });
});

test("behaviour differences are reported, not buried (FR-5.8)", () => {
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": `export function ProductCard({ title, body, onBuy }) {
  const track = useAnalytics();
  return (
    <div className="rounded-lg border p-6 shadow-md" onClick={() => { track("buy"); onBuy(); }}>
      <h3 className="text-lg font-bold">{title}</h3>
      <p className="text-sm text-slate-600">{body}</p>
    </div>
  );
}
`,
  });
  const res = run({ cmd: "plan", root, members: MEMBERS });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.behaviorDiff.differs, true);
  assert.match(res.behaviorDiff.detail, /useAnalytics|onClick/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("identical behaviour is not flagged", () => {
  const root = baseProject();
  const res = run({ cmd: "plan", root, members: MEMBERS });
  assert.equal(res.behaviorDiff.differs, false);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- dry run (the reviewable diff, FR-5.4) -----------------------------------

test("dry run produces the whole diff and writes nothing", () => {
  const root = baseProject();
  const before = read(root, "src/Home.tsx");
  const res = run({
    cmd: "apply",
    root,
    dryRun: true,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, true, res.error);
  const kinds = res.changes.map((c) => `${c.kind}:${c.file}`).sort();
  assert.deepEqual(kinds, [
    "callsite:src/Home.tsx",
    "canonical:src/components/Card.tsx",
    "retired:src/components/ProductCard.tsx",
  ]);
  const home = res.changes.find((c) => c.file === "src/Home.tsx");
  assert.match(home.after, /<Card title="c" body="d" variant="product" \/>/);
  // Nothing on disk moved.
  assert.equal(read(root, "src/Home.tsx"), before);
  assert.ok(fs.existsSync(path.join(root, "src/components/ProductCard.tsx")));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- apply -------------------------------------------------------------------

test("apply rewrites call sites, imports, and retires the merged file", () => {
  const root = baseProject();
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, true, res.error);

  const home = read(root, "src/Home.tsx");
  assert.match(home, /<Card title="a" body="b" \/>/);
  assert.match(home, /<Card title="c" body="d" variant="product" \/>/);
  assert.ok(!home.includes("ProductCard"), `stale reference left behind:\n${home}`);
  // The Card import stays; the ProductCard one is gone.
  assert.match(home, /import \{ Card \} from "\.\/components\/Card";/);

  // Canonical file now holds the merged component.
  assert.match(read(root, "src/components/Card.tsx"), /variant = "default"/);

  // The merged-away file is staged, not destroyed (FR-5.5).
  assert.ok(!fs.existsSync(path.join(root, "src/components/ProductCard.tsx")));
  assert.equal(
    read(root, ".dedup-trash/src/components/ProductCard.tsx"),
    PRODUCT_CARD,
  );
  assert.deepEqual(res.trashed, ["src/components/ProductCard.tsx"]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("merging into a new file adds the import where the old one was", () => {
  const root = baseProject();
  const res = run({
    cmd: "apply",
    root,
    canonical: {
      name: "Card",
      file: "src/components/ui/Card.tsx",
      source: CANONICAL,
    },
    mapping: MAPPING,
  });
  assert.equal(res.ok, true, res.error);
  const home = read(root, "src/Home.tsx");
  assert.match(home, /import \{ Card \} from "@\/components\/ui\/Card";/, home);
  assert.ok(!home.includes('from "./components/Card"'), home);
  // Both original members retired.
  assert.deepEqual(res.trashed.sort(), [
    "src/components/Card.tsx",
    "src/components/ProductCard.tsx",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a name collision at the call site aliases the import instead of shadowing", () => {
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": PRODUCT_CARD,
    "src/Page.tsx": `import { Card } from "some-ui-kit";
import { ProductCard } from "./components/ProductCard";

export function Page() {
  return (
    <div>
      <Card>library</Card>
      <ProductCard title="x" body="y" />
    </div>
  );
}
`,
  });
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, true, res.error);
  const page = read(root, "src/Page.tsx");
  assert.match(page, /import \{ Card as Card2 \} from "\.\/components\/Card";/, page);
  assert.match(page, /<Card2 title="x" body="y" variant="product" \/>/, page);
  // The library Card is untouched.
  assert.match(page, /import \{ Card \} from "some-ui-kit";/, page);
  assert.match(page, /<Card>library<\/Card>/, page);
  assert.ok(res.warnings.some((w) => /already binds/.test(w)), res.warnings.join());
  fs.rmSync(root, { recursive: true, force: true });
});

test("a default-exported member is rewritten through its default import", () => {
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": `export default function ProductCard({ title }) {
  return <div className="rounded-lg border p-6 shadow-md"><h3>{title}</h3></div>;
}
`,
    "src/Home.tsx": `import { Card } from "./components/Card";
import Product from "./components/ProductCard";

export function Home() {
  return <main><Card title="a" body="b" /><Product title="c" /></main>;
}
`,
  });
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, true, res.error);
  const home = read(root, "src/Home.tsx");
  assert.match(home, /<Card title="c" variant="product" \/>/, home);
  assert.ok(!/import Product/.test(home), home);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a shared file is left in place with a reason, never surgically gutted", () => {
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": `export const PRODUCT_GAP = 8;

${PRODUCT_CARD}`,
    "src/Home.tsx": HOME,
  });
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.trashed, []);
  assert.equal(res.leftBehind[0].name, "ProductCard");
  assert.ok(fs.existsSync(path.join(root, "src/components/ProductCard.tsx")));
  assert.match(read(root, "src/components/ProductCard.tsx"), /PRODUCT_GAP/);
  assert.ok(res.warnings.some((w) => /PRODUCT_GAP/.test(w)), res.warnings.join());
  // Call sites still moved onto the canonical component.
  assert.ok(!read(root, "src/Home.tsx").includes("<ProductCard"));
  fs.rmSync(root, { recursive: true, force: true });
});

// --- refusals ----------------------------------------------------------------

test("a canonical component that does not parse is refused, nothing written", () => {
  const root = baseProject();
  const before = read(root, "src/Home.tsx");
  const res = run({
    cmd: "apply",
    root,
    canonical: {
      name: "Card",
      file: "src/components/Card.tsx",
      source: "export function Card() { return <div>oops</div; }",
    },
    mapping: MAPPING,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /does not parse/);
  assert.equal(read(root, "src/Home.tsx"), before);
  assert.equal(read(root, "src/components/Card.tsx"), CARD);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a canonical component that doesn't export the promised name is refused", () => {
  const root = baseProject();
  const res = run({
    cmd: "apply",
    root,
    canonical: {
      name: "Card",
      file: "src/components/Card.tsx",
      source: "export function Panel() { return <div />; }",
    },
    mapping: MAPPING,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /does not export/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("merging into a file whose other exports would vanish is refused", () => {
  const root = fixture({
    "src/components/Card.tsx": `export const CARD_RADIUS = 8;\n${CARD}`,
    "src/components/ProductCard.tsx": PRODUCT_CARD,
    "src/Home.tsx": HOME,
    "src/Uses.tsx": `import { CARD_RADIUS } from "./components/Card";
export const r = CARD_RADIUS;
`,
  });
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /drops exports/);
  assert.match(res.error, /CARD_RADIUS/);
  assert.match(read(root, "src/components/Card.tsx"), /CARD_RADIUS/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a re-exporting barrel blocks the merge instead of dangling", () => {
  const root = fixture({
    "src/components/Card.tsx": CARD,
    "src/components/ProductCard.tsx": PRODUCT_CARD,
    "src/components/index.ts": `export { Card } from "./Card";
export { ProductCard } from "./ProductCard";
`,
    "src/Home.tsx": HOME,
  });
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /re-exported/);
  assert.equal(read(root, "src/Home.tsx"), HOME);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a member that moved out of its file is refused, not guessed at", () => {
  const root = baseProject();
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: [
      ...MAPPING,
      { file: "src/components/Card.tsx", name: "Ghost", props: {} },
    ],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /no longer declared/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an unsafe prop value is refused before it can reach a file", () => {
  const root = baseProject();
  const res = run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: [
      { file: "src/components/Card.tsx", name: "Card", props: {} },
      {
        file: "src/components/ProductCard.tsx",
        name: "ProductCard",
        props: { variant: 'x" onClick={steal()} data-y="' },
      },
    ],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unsafe prop value/);
  assert.equal(read(root, "src/Home.tsx"), HOME);
  fs.rmSync(root, { recursive: true, force: true });
});

// --- trash lifecycle (FR-5.5) -------------------------------------------------

test("staged files list, restore, and only empty on confirmation", () => {
  const root = baseProject();
  run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });

  const listed = run({ cmd: "listTrash", root });
  assert.deepEqual(
    listed.files.map((f) => f.path),
    ["src/components/ProductCard.tsx"],
  );

  const restored = run({ cmd: "restoreTrash", root });
  assert.deepEqual(restored.restored, ["src/components/ProductCard.tsx"]);
  assert.equal(read(root, "src/components/ProductCard.tsx"), PRODUCT_CARD);
  assert.deepEqual(run({ cmd: "listTrash", root }).files, []);

  // Re-stage, then empty for real.
  run({
    cmd: "apply",
    root,
    canonical: { name: "Card", file: "src/components/Card.tsx", source: CANONICAL },
    mapping: MAPPING,
  });
  const emptied = run({ cmd: "emptyTrash", root });
  assert.equal(emptied.deleted, 1);
  assert.ok(!fs.existsSync(path.join(root, ".dedup-trash")));
  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\n${passed} passed`);
