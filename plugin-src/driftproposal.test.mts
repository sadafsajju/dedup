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
  parseExtractReply,
} from "../src/lib/driftProposal.ts";
import type { DriftCandidate, DriftOccurrence } from "../src/lib/types.ts";

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

console.log(`\n${passed} passed`);
