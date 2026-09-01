// Smoke tests for the extract sidecar. Run: pnpm test:extract
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
  "../src-tauri/assets/dedup-extract.mjs",
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

function runExtract(root, opts = {}) {
  const out = execFileSync("node", [BUNDLE], {
    input: JSON.stringify({ cmd: "extract", root, ...opts }),
    maxBuffer: 32 * 1024 * 1024,
  });
  const lines = out.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

function fixtureProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-extract-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const page = (name, buttons) =>
  `export function ${name}() {
  return (
    <div>
${buttons.map((b) => `      ${b}`).join("\n")}
    </div>
  );
}
`;

const BTN = (label, extra = "") =>
  `<button className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white${
    extra ? ` ${extra}` : ""
  }">${label}</button>`;

// --- the case this feature exists for ---------------------------------------

test("finds the same inline button pasted across files", () => {
  const root = fixtureProject({
    "src/Home.jsx": page("Home", [BTN("Save"), BTN("Cancel")]),
    "src/Settings.jsx": page("Settings", [BTN("Apply")]),
  });
  const r = runExtract(root);
  assert.equal(r.ok, true);
  assert.equal(r.candidates.length, 1, JSON.stringify(r.candidates, null, 1));
  const c = r.candidates[0];
  assert.equal(c.tag, "button");
  assert.equal(c.occurrences.length, 3);
  assert.equal(c.fileCount, 2);
  assert.equal(c.elementsRemoved, 2);
  // The label is what varies, and it is reported as text, not as a class.
  assert.deepEqual(
    c.varies.texts[0].values.sort(),
    ["Apply", "Cancel", "Save"],
  );
  assert.equal(c.varies.classes.length, 0);
});

test("two copies is a coincidence, three is duplication", () => {
  const root = fixtureProject({
    "src/Home.jsx": page("Home", [BTN("Save"), BTN("Cancel")]),
  });
  assert.equal(runExtract(root).candidates.length, 0);
});

// --- the rule that decides whether the output is trustworthy -----------------

test("a varying visual knob is a variant; a varying layout knob is not", () => {
  const root = fixtureProject({
    "src/A.jsx": page("A", [BTN("One"), BTN("Two", "mt-4")]),
    "src/B.jsx": `export function B() {
  return (
    <div>
      <button className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white">Three</button>
    </div>
  );
}
`,
  });
  const c = runExtract(root).candidates[0];
  const bg = c.varies.classes.find((v) => v.knob === "bg-color");
  const mt = c.varies.classes.find((v) => v.knob === "mt");
  assert.ok(bg, "expected the background colour to be reported as varying");
  assert.equal(bg.layout, false, "bg-* is a variant, not a position");
  assert.ok(mt, "expected the margin to be reported as varying");
  assert.equal(mt.layout, true, "mt-* belongs at the call site");
  // The copy without the margin reports null for it, not a made-up default.
  assert.equal(mt.values.filter((v) => v === null).length, 2);
});

// --- refusals ----------------------------------------------------------------

test("a spread attribute is refused, with its reason, not dropped", () => {
  const spread = `<button {...rest} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white">Extra</button>`;
  const root = fixtureProject({
    "src/A.jsx": page("A", [BTN("One"), BTN("Two")]),
    "src/B.jsx": page("B", [BTN("Three"), spread]),
  });
  const c = runExtract(root).candidates[0];
  assert.equal(c.occurrences.length, 3);
  assert.equal(c.refused.length, 1);
  assert.match(c.refused[0].reason, /spread/);
  assert.equal(c.refused[0].file, "src/B.jsx");
});

test("a computed className is refused — the classes can't be read", () => {
  const dyn = `<button className={cn("rounded-md px-4 py-2", tone)}>Dyn</button>`;
  const root = fixtureProject({
    "src/A.jsx": page("A", [BTN("One"), BTN("Two"), BTN("Three")]),
    "src/B.jsx": page("B", [dyn]),
  });
  const r = runExtract(root);
  const c = r.candidates.find((x) => x.tag === "button");
  assert.equal(c.occurrences.length, 3);
  assert.ok(
    !c.occurrences.some((o) => o.source.includes("cn(")),
    "a computed className must never be counted as an occurrence",
  );
});

test("markup too plain to name is not a candidate however often it repeats", () => {
  const root = fixtureProject({
    "src/A.jsx": page(
      "A",
      Array.from({ length: 10 }, () => `<div className="flex">x</div>`),
    ),
  });
  assert.equal(runExtract(root).candidates.length, 0);
});

test("an existing component is not markup — capitalized roots are skipped", () => {
  const root = fixtureProject({
    "src/A.jsx": page(
      "A",
      Array.from(
        { length: 4 },
        () => `<Button size="sm" tone="primary" rounded label="Go" />`,
      ),
    ),
  });
  assert.equal(runExtract(root).candidates.length, 0);
});

// --- nesting -----------------------------------------------------------------

test("the outer candidate claims its range; copies inside it don't re-count", () => {
  const card = (label) => `<div className="rounded-lg border p-4 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-900">${label}</h3>
        ${BTN(label)}
      </div>`;
  const root = fixtureProject({
    "src/A.jsx": page("A", [card("One"), card("Two")]),
    "src/B.jsx": page("B", [card("Three")]),
  });
  const r = runExtract(root);
  assert.equal(r.candidates.length, 1, JSON.stringify(r.candidates.map((c) => c.shape)));
  assert.equal(r.candidates[0].tag, "div");
  assert.equal(r.candidates[0].elements, 3);
});

// --- the best possible answer ------------------------------------------------

test("says when the canonical component already exists", () => {
  const root = fixtureProject({
    "src/Button.jsx": `export function PrimaryButton({ children }) {
  return ${BTN("{children}")};
}
`,
    "src/A.jsx": page("A", [BTN("One"), BTN("Two")]),
  });
  const c = runExtract(root).candidates[0];
  assert.ok(c.existing, "expected the existing component to be reported");
  assert.equal(c.existing.name, "PrimaryButton");
  assert.equal(c.existing.file, "src/Button.jsx");
});

test("varying attributes become props, and name the occurrence's component", () => {
  const link = (href, label) =>
    `<a href="${href}" className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white">${label}</a>`;
  const root = fixtureProject({
    "src/A.jsx": page("A", [link("/a", "A"), link("/b", "B")]),
    "src/C.jsx": page("C", [link("/c", "C")]),
  });
  const c = runExtract(root).candidates[0];
  const href = c.varies.attrs.find((a) => a.name === "href");
  assert.ok(href);
  assert.deepEqual(href.values.sort(), ['"/a"', '"/b"', '"/c"']);
  assert.deepEqual(
    [...new Set(c.occurrences.map((o) => o.component))].sort(),
    ["A", "C"],
  );
});

test("scope limits which files contribute occurrences", () => {
  const root = fixtureProject({
    "src/A.jsx": page("A", [BTN("One"), BTN("Two")]),
    "src/B.jsx": page("B", [BTN("Three")]),
  });
  assert.equal(runExtract(root).candidates.length, 1);
  assert.equal(runExtract(root, { files: ["src/A.jsx"] }).candidates.length, 0);
});

console.log(`\n${passed} passed`);
