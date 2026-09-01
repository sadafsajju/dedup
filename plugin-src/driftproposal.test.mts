// Extraction-proposal prompt + parsing. Run: pnpm test:drift
//
// This is the boundary the model's reply crosses on the drift path. Nothing
// here writes to the user's project — the extraction codemod does not exist —
// but a proposal the user cannot trust is worse than no proposal, and the
// parser is the only thing standing between a drifted reply and a component
// the user is about to copy into their codebase.
import assert from "node:assert/strict";
import {
  buildExtractPrompt,
  covaryingGroups,
  isColourKnob,
  parseExtractReply,
} from "../src/lib/driftProposal.ts";
import type { DriftCandidate, DriftOccurrence } from "../src/lib/types.ts";
import { clampZoom, zoomToward, ZOOM_MAX, ZOOM_MIN } from "../src/lib/panZoom.ts";

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

const occ = (file: string, line: number, start: number): DriftOccurrence => ({
  file,
  line,
  col: 0,
  start,
  end: start + 40,
  component: "Page",
  source: `<button className="px-3">Save</button>`,
  html: `<button class="px-3">Save</button>`,
});

const CANDIDATE: DriftCandidate = {
  id: "abc",
  tag: "button",
  shape: "button()",
  elements: 1,
  weight: 8,
  fileCount: 2,
  bytes: 120,
  elementsRemoved: 2,
  skeleton: "button .bg-indigo-600",
  existing: null,
  occurrences: [occ("a.tsx", 1, 10), occ("b.tsx", 2, 20), occ("c.tsx", 3, 30)],
  varies: {
    classes: [
      { node: 0, knob: "px", layout: false, values: ["px-3", "px-4", "px-3"] },
      { node: 0, knob: "mt", layout: true, values: [null, "mt-4", null] },
    ],
    attrs: [{ node: 0, name: "href", values: ['"/a"', '"/b"', null] }],
    texts: [{ node: 0, values: ["Save", "Send", "Go"] }],
  },
  refused: [],
};

const GOOD = `FILE: src/components/Button.tsx
NAME: Button
SUMMARY: One button with a className passthrough.
\`\`\`tsx
export function Button({ children, className = "" }) {
  return <button className={\`px-3 \${className}\`}>{children}</button>;
}
\`\`\`
NOTES:
- Picked px-3; px-4 appeared once and was not deliberate.`;

// --- the prompt --------------------------------------------------------------

test("the prompt marks layout knobs so they stay at the call site", () => {
  const p = buildExtractPrompt(CANDIDATE, CANDIDATE.occurrences);
  assert.match(p, /LAYOUT mt: /);
  assert.ok(!/LAYOUT px:/.test(p), "px is visual and must not be marked layout");
});

test("variance columns follow the selection, not the full candidate", () => {
  // Only the middle copy is selected — the values shown must be its column,
  // or the model is told about spread the user deliberately excluded.
  const p = buildExtractPrompt(CANDIDATE, [CANDIDATE.occurrences[1]]);
  assert.match(p, /px: px-4$/m);
  assert.match(p, /LAYOUT mt: mt-4$/m);
  assert.match(p, /href: "\/b"$/m);
});

test("an absent value is reported as absent, not as an empty string", () => {
  const p = buildExtractPrompt(CANDIDATE, [CANDIDATE.occurrences[2]]);
  assert.match(p, /href: \(absent\)/);
});

test("an existing component is pointed at rather than duplicated", () => {
  const p = buildExtractPrompt(
    { ...CANDIDATE, existing: { file: "src/Button.tsx", name: "Button" } },
    CANDIDATE.occurrences,
  );
  assert.match(p, /already one of these copies/);
  assert.match(p, /src\/Button\.tsx/);
});

// --- semantic colour, and co-variance -----------------------------------------
//
// These exist because of a real failure: a badge with three tones — neutral,
// success, warning — came back from the model as one emerald pill. The two
// colour knobs moved in perfect lockstep across seven copies and the prompt
// showed them as two unrelated rows next to an instruction to normalise.

const TONED: DriftCandidate = {
  ...CANDIDATE,
  occurrences: [
    occ("a.tsx", 1, 10),
    occ("b.tsx", 2, 20),
    occ("c.tsx", 3, 30),
    occ("d.tsx", 4, 40),
  ],
  varies: {
    classes: [
      {
        node: 0,
        knob: "bg-color",
        layout: false,
        values: ["bg-slate-100", "bg-emerald-50", "bg-emerald-50", "bg-amber-50"],
      },
      {
        node: 0,
        knob: "text-color",
        layout: false,
        values: ["text-slate-600", "text-emerald-700", "text-emerald-700", "text-amber-700"],
      },
      { node: 0, knob: "px", layout: false, values: ["px-2", "px-2.5", "px-2", "px-2"] },
    ],
    attrs: [],
    texts: [],
  },
};

test("a base colour is semantic; a state colour is just a missing state", () => {
  assert.equal(isColourKnob("bg-color"), true);
  assert.equal(isColourKnob("text-color"), true);
  // Three buttons that forgot a hover is drift, not a variant to preserve.
  assert.equal(isColourKnob("hover:bg-color"), false);
  assert.equal(isColourKnob("focus:ring-color"), false);
  assert.equal(isColourKnob("px"), false);
});

test("colour knobs are marked SEMANTIC, spacing is not", () => {
  const p = buildExtractPrompt(TONED, TONED.occurrences);
  assert.match(p, /SEMANTIC bg-color:/);
  assert.match(p, /SEMANTIC text-color:/);
  assert.match(p, /^px: /m, "padding must stay unmarked — it is drift");
});

test("knobs that vary in lockstep are reported as one prop with its members", () => {
  const p = buildExtractPrompt(TONED, TONED.occurrences);
  assert.match(p, /MOVE TOGETHER: bg-color \+ text-color — one prop, not 2\./);
  assert.match(p, /bg-slate-100 \+ text-slate-600 {2}\(1 copy\)/);
  assert.match(p, /bg-emerald-50 \+ text-emerald-700 {2}\(2 copies\)/);
  assert.match(p, /bg-amber-50 \+ text-amber-700 {2}\(1 copy\)/);
});

test("knobs that merely both vary are not called co-varying", () => {
  // px changes on a different copy than the colours do — reporting that as
  // one prop would invent a variant nobody wrote.
  const groups = covaryingGroups(TONED.varies.classes);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((g) => g.knob), ["bg-color", "text-color"]);
});

test("a knob that differs in every copy partitions nothing", () => {
  // Fifteen distinct labels are not fifteen variants; only a knob that groups
  // the copies is evidence of a state.
  const groups = covaryingGroups([
    { knob: "a", values: ["1", "2", "3", "4"] },
    { knob: "b", values: ["w", "x", "y", "z"] },
  ]);
  assert.equal(groups.length, 0);
});

test("co-variance is judged on the selection, not the whole candidate", () => {
  // Copies 1 and 2 are both emerald: across just those two, neither colour
  // knob varies at all, so there is no variant to propose.
  const p = buildExtractPrompt(TONED, [TONED.occurrences[1], TONED.occurrences[2]]);
  assert.ok(!/MOVE TOGETHER/.test(p), "a uniform selection has nothing moving");
});

// --- the parse ---------------------------------------------------------------

test("a well-formed proposal parses", () => {
  const r = parseExtractReply(GOOD);
  assert.equal(r.file, "src/components/Button.tsx");
  assert.equal(r.name, "Button");
  assert.match(r.source, /export function Button/);
  assert.match(r.notes, /px-3/);
  assert.ok(!r.source.includes("```"), "the fence must not survive the parse");
});

// --- refusals ----------------------------------------------------------------

test("a proposal with no FILE is refused", () => {
  assert.throws(
    () => parseExtractReply(GOOD.replace(/^FILE:.*$/m, "")),
    /named no FILE/,
  );
});

test("a path escaping the project is refused", () => {
  assert.throws(
    () => parseExtractReply(GOOD.replace("src/components/Button.tsx", "../../etc/x.tsx")),
    /outside the project/,
  );
  assert.throws(
    () => parseExtractReply(GOOD.replace("src/components/Button.tsx", "/etc/x.tsx")),
    /outside the project/,
  );
});

test("a name that isn't a component name is refused", () => {
  assert.throws(() => parseExtractReply(GOOD.replace("NAME: Button", "NAME: button")), /not a valid/);
  assert.throws(
    () => parseExtractReply(GOOD.replace("NAME: Button", "NAME: rm -rf /")),
    /not a valid/,
  );
});

test("a proposal with no source is refused", () => {
  assert.throws(
    () => parseExtractReply(GOOD.replace(/```tsx[\s\S]*?```/, "")),
    /no component source/,
  );
});

test("a source that never mentions the name it promised is refused", () => {
  // The cheapest catch for a reply whose header and body disagree — the user
  // would otherwise copy in a file that exports something else entirely.
  assert.throws(
    () => parseExtractReply(GOOD.replace(/NAME: Button/, "NAME: PrimaryAction")),
    /never mentions/,
  );
});

// --- pan/zoom ----------------------------------------------------------------
//
// Shared by the artboard canvas and the drift view. Both surfaces must feel
// identical, so the arithmetic is pinned here rather than trusted twice.

test("zoom keeps the point under the cursor exactly where it is", () => {
  const before = { zoom: 1, pan: { x: 40, y: 20 } };
  // Content coordinate under the cursor, before and after.
  const contentAt = (t: typeof before, cx: number, cy: number) => [
    (cx - t.pan.x) / t.zoom,
    (cy - t.pan.y) / t.zoom,
  ];
  const [bx, by] = contentAt(before, 300, 200);
  const after = zoomToward(before, 300, 200, 1.5)!;
  const [ax, ay] = contentAt(after, 300, 200);
  assert.ok(Math.abs(ax - bx) < 1e-9, `x drifted: ${bx} -> ${ax}`);
  assert.ok(Math.abs(ay - by) < 1e-9, `y drifted: ${by} -> ${ay}`);
});

test("zoom is clamped, and a clamped no-op reports itself as one", () => {
  assert.equal(clampZoom(99), ZOOM_MAX);
  assert.equal(clampZoom(0.01), ZOOM_MIN);
  // Already at the ceiling: returning a transform anyway would write a
  // pan built from a zoom that never changed, sliding the view on every tick.
  assert.equal(zoomToward({ zoom: ZOOM_MAX, pan: { x: 0, y: 0 } }, 10, 10, 2), null);
  assert.equal(zoomToward({ zoom: ZOOM_MIN, pan: { x: 0, y: 0 } }, 10, 10, 0.5), null);
});

test("a partial zoom into the clamp still anchors on the cursor", () => {
  const t = { zoom: 1.8, pan: { x: 0, y: 0 } };
  const next = zoomToward(t, 100, 100, 4)!;
  assert.equal(next.zoom, ZOOM_MAX);
  assert.equal(next.pan.x, 100 - 100 * (ZOOM_MAX / 1.8));
});

console.log(`\n${passed} passed`);
