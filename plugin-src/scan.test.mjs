// Smoke tests for the scan sidecar. Run: pnpm test:scan
// Tests the BUILT bundle (what actually ships), run as a child process the
// same way the Rust core runs it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/assets/dedup-scan.mjs",
);

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

function runScan(root, files = null) {
  const out = execFileSync("node", [BUNDLE], {
    input: JSON.stringify({ cmd: "scan", root, files }),
  });
  // Last stdout line is the result; earlier lines are progress events.
  const lines = out.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

function fixtureProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-scan-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

// Two near-duplicate cards (p-4 vs p-6, text-gray vs text-slate) and one
// structurally unrelated table.
const CARD_A = `export function CardA({ title, body }) {
  return (
    <div className="rounded-lg border p-4 shadow-sm">
      <h3 className="text-lg font-semibold text-gray-900">{title}</h3>
      <p className="text-sm text-gray-600">{body}</p>
      <button className="mt-4 rounded bg-blue-600 px-3 py-1 text-white">Go</button>
    </div>
  );
}
`;
const CARD_B = `export function CardB({ heading, text }) {
  return (
    <div className="rounded-lg border p-6 shadow-md">
      <h3 className="text-lg font-bold text-slate-900">{heading}</h3>
      <p className="text-sm text-slate-600">{text}</p>
      <button className="mt-4 rounded bg-blue-500 px-3 py-1 text-white">Open</button>
    </div>
  );
}
`;
const TABLE = `export function DataTable({ rows }) {
  return (
    <table className="w-full text-left">
      <thead>
        <tr><th className="px-2">Name</th><th className="px-2">Value</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}><td className="px-2">{r.name}</td><td className="px-2">{r.value}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
`;
const USAGE = `import { CardA } from "./CardA";
import { CardB } from "./CardB";
export function Page() {
  return (
    <main className="p-8">
      <CardA title="a" body="b" />
      <CardA title="c" body="d" />
      <CardB heading="e" text="f" />
    </main>
  );
}
`;

test("clusters near-duplicates, leaves unrelated components alone", () => {
  const root = fixtureProject({
    "src/CardA.tsx": CARD_A,
    "src/CardB.tsx": CARD_B,
    "src/DataTable.tsx": TABLE,
    "src/Page.tsx": USAGE,
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.schema, 2); // persisted-restore gate (store SCAN_SCHEMA)
  assert.equal(r.files, 4);
  assert.ok(r.components >= 4, `expected ≥4 components, got ${r.components}`);
  assert.equal(r.clusters.length, 1, JSON.stringify(r.clusters, null, 2));

  const cluster = r.clusters[0];
  const names = cluster.members.map((m) => m.name).sort();
  assert.deepEqual(names, ["CardA", "CardB"]);
  assert.ok(
    cluster.confidence >= 0.8,
    `confidence ${cluster.confidence} < 0.8`,
  );
  // Call sites counted from Page.tsx usage.
  const cardA = cluster.members.find((m) => m.name === "CardA");
  assert.equal(cardA.callSites, 2);
  assert.equal(cluster.totalCallSites, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("canvas scope: only scoped files cluster, call sites stay project-wide", () => {
  // CardC is a third near-duplicate that is NOT on the "canvas".
  const root = fixtureProject({
    "src/CardA.tsx": CARD_A,
    "src/CardB.tsx": CARD_B,
    "src/CardC.tsx": CARD_A.replace(/CardA/g, "CardC"),
    "src/Page.tsx": USAGE,
  });
  const r = runScan(root, ["src/CardA.tsx", "src/CardB.tsx"]);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.scopedFiles, 2);
  assert.equal(r.components, 2); // CardC and Page are out of scope
  assert.equal(r.clusters.length, 1);
  assert.deepEqual(
    r.clusters[0].members.map((m) => m.name).sort(),
    ["CardA", "CardB"], // CardC never clusters despite being a near-dup
  );
  // Page.tsx is out of scope but its usages still count.
  const cardA = r.clusters[0].members.find((m) => m.name === "CardA");
  assert.equal(cardA.callSites, 2);

  // Unscoped run over the same tree clusters all three.
  const full = runScan(root);
  assert.equal(full.scopedFiles, null);
  assert.equal(full.clusters[0].members.length, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("identical structure with different class values still clusters", () => {
  const root = fixtureProject({
    "src/A.tsx": `export const Badge = () => (
  <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-1 text-xs text-green-800">
    <svg className="mr-1 h-3 w-3" /> ok
  </span>
);
`,
    "src/B.tsx": `export const Pill = () => (
  <span className="inline-flex items-center rounded-full bg-red-100 px-3 py-1.5 text-sm text-red-800">
    <svg className="mr-2 h-4 w-4" /> no
  </span>
);
`,
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.clusters.length, 1, JSON.stringify(r.clusters));
  assert.deepEqual(
    r.clusters[0].members.map((m) => m.name).sort(),
    ["Badge", "Pill"],
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("trivial one-element components are not clustered", () => {
  const root = fixtureProject({
    "src/Sp.tsx": `export const Spacer = () => <div className="h-4" />;\n`,
    "src/Dv.tsx": `export const Divider = () => <hr className="h-4" />;\n`,
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.clusters.length, 0, JSON.stringify(r.clusters));
  fs.rmSync(root, { recursive: true, force: true });
});

test("skips node_modules and unparseable files without dying", () => {
  const root = fixtureProject({
    "node_modules/pkg/Fake.tsx": CARD_A,
    "src/Bad.tsx": "const = <<<>>;;;",
    "src/Card.tsx": CARD_A.replace(/CardA/g, "Card"),
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.files, 2); // node_modules never discovered
  assert.equal(r.components, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("gallery keeps structural + interactive, drops text and icons", () => {
  const root = fixtureProject({
    "src/Card.tsx": CARD_A.replace(/CardA/g, "Card"),
    "src/Btn.tsx": `export const Btn = () => <button className="rounded bg-blue-600 px-3 py-1 text-white">Go</button>;\n`,
    "src/Title.tsx": `export const Title = ({ children }) => <h2 className="text-xl font-bold"><span className="text-accent">{children}</span></h2>;\n`,
    "src/Icon.tsx": `export const ArrowIcon = () => <svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg>;\n`,
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  const names = r.gallery.map((g) => g.name).sort();
  // Card (structural) and Btn (interactive, single element) qualify;
  // Title (text wrapper) and ArrowIcon (svg-only) don't.
  assert.deepEqual(names, ["Btn", "Card"], JSON.stringify(r.gallery));
  fs.rmSync(root, { recursive: true, force: true });
});

test("gallery excludes app shells (App, *Routes, *Provider, *Layout)", () => {
  const root = fixtureProject({
    "src/App.tsx": `export default function App() { return <div className="min-h-screen"><main className="p-4"><section>x</section></main></div>; }
export function AppRoutes() { return <div className="p-2"><nav>n</nav><main>m</main></div>; }
`,
    "src/Card.tsx": CARD_A.replace(/CardA/g, "Card"),
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.gallery.map((g) => g.name), ["Card"], JSON.stringify(r.gallery));
  fs.rmSync(root, { recursive: true, force: true });
});

test("gallery entries carry their cluster id", () => {
  const root = fixtureProject({
    "src/CardA.tsx": CARD_A,
    "src/CardB.tsx": CARD_B,
    "src/DataTable.tsx": TABLE,
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  const byName = Object.fromEntries(r.gallery.map((g) => [g.name, g]));
  assert.equal(byName.CardA.clusterId, r.clusters[0].id);
  assert.equal(byName.CardB.clusterId, r.clusters[0].id);
  assert.equal(byName.DataTable.clusterId, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test("memo/forwardRef-wrapped components are inventoried", () => {
  const root = fixtureProject({
    "src/M.tsx": `import { memo, forwardRef } from "react";
export const Fancy = memo(forwardRef(({ label }, ref) => (
  <div ref={ref} className="flex items-center gap-2 p-2">
    <span className="font-medium">{label}</span>
  </div>
)));
`,
  });
  const r = runScan(root);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.components, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("emits progress events on stdout before the result", () => {
  const files = {};
  for (let i = 0; i < 30; i++) {
    files[`src/C${i}.tsx`] = `export const C${i} = () => <div className="x-${i}"><span>s</span><p>p</p></div>;\n`;
  }
  const root = fixtureProject(files);
  const out = execFileSync("node", [BUNDLE], {
    input: JSON.stringify({ cmd: "scan", root }),
  }).toString();
  const lines = out.trim().split("\n");
  assert.ok(lines.length > 1, "expected progress lines before the result");
  const progress = JSON.parse(lines[0]);
  assert.equal(progress.event, "progress");
  assert.equal(progress.stage, "inventory");
  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
