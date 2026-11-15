// Tests for the Tailwind class ⇄ knob mapping layer.
// Run: pnpm test:tw  (node --experimental-strip-types)
import assert from "node:assert/strict";
import {
  pageColor,
  KNOBS,
  cssColor,
  fromTokens,
  mergeClasses,
  readKnob,
  readSpacing,
  setKnob,
  sizeClass,
  stepSpacing,
  toTokens,
  writeSpacing,
} from "../src/lib/tailwind.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e: any) {
    console.error(`  FAIL — ${name}\n${e.message}`);
    process.exitCode = 1;
  }
}

test("readKnob: last base token wins, variants ignored", () => {
  const t = toTokens("flex hover:grid text-sm md:text-lg text-base");
  assert.equal(readKnob(t, KNOBS.display), "flex");
  assert.equal(readKnob(t, KNOBS.fontSize), "base");
});

test("setKnob replaces in place and dedupes", () => {
  const t = toTokens("p-4 flex text-sm text-lg gap-2");
  assert.equal(
    fromTokens(setKnob(t, KNOBS.fontSize, "text-xl")),
    "p-4 flex text-xl gap-2",
  );
  assert.equal(fromTokens(setKnob(t, KNOBS.fontSize, null)), "p-4 flex gap-2");
  assert.equal(
    fromTokens(setKnob(t, KNOBS.justify, "justify-center")),
    "p-4 flex text-sm text-lg gap-2 justify-center",
  );
});

test("fontSize vs textColor vs textAlign disambiguation", () => {
  const t = toTokens("text-sm text-red-500 text-center text-[13px] text-[#fff]");
  assert.equal(readKnob(t, KNOBS.fontSize), "[13px]");
  assert.equal(readKnob(t, KNOBS.textColor), "[#fff]");
  assert.equal(readKnob(t, KNOBS.textAlign), "center");
});

test("borderWidth vs borderColor", () => {
  const t = toTokens("border-2 border-red-300 border-t");
  assert.equal(readKnob(t, KNOBS.borderWidth), "2");
  assert.equal(readKnob(t, KNOBS.borderColor), "red-300");
  const bare = toTokens("border rounded-lg");
  assert.equal(readKnob(bare, KNOBS.borderWidth), bare[0]); // matched, no group
  assert.equal(readKnob(bare, KNOBS.radius), "lg");
});

test("readSpacing: individual beats axis beats all, any order", () => {
  const t = toTokens("pt-8 p-4 px-2");
  assert.deepEqual(readSpacing(t, "p"), { t: "8", r: "2", b: "4", l: "2" });
});

test("readSpacing: negative margins", () => {
  const t = toTokens("-mt-2 mx-4");
  assert.deepEqual(readSpacing(t, "m"), { t: "-2", r: "4", b: null, l: "4" });
});

test("writeSpacing collapses to minimal form in place", () => {
  const t = toTokens("flex p-2 pt-4 text-sm");
  assert.equal(
    fromTokens(writeSpacing(t, "p", { t: "6", r: "6", b: "6", l: "6" })),
    "flex p-6 text-sm",
  );
  assert.equal(
    fromTokens(writeSpacing(t, "p", { t: "1", r: "2", b: "1", l: "2" })),
    "flex py-1 px-2 text-sm",
  );
  assert.equal(
    fromTokens(writeSpacing(t, "p", { t: "1", r: null, b: null, l: null })),
    "flex pt-1 text-sm",
  );
});

test("writeSpacing leaves variant spacing untouched", () => {
  const t = toTokens("p-2 hover:p-8");
  assert.equal(
    fromTokens(writeSpacing(t, "p", { t: "4", r: "4", b: "4", l: "4" })),
    "p-4 hover:p-8",
  );
});

test("writeSpacing emits negative classes", () => {
  const t = toTokens("m-2");
  assert.equal(
    fromTokens(writeSpacing(t, "m", { t: "-2", r: "4", b: "-2", l: "4" })),
    "-my-2 mx-4",
  );
});

test("stepSpacing walks the scale and clamps", () => {
  assert.equal(stepSpacing("4", 1), "5");
  assert.equal(stepSpacing("4", -1), "3.5");
  assert.equal(stepSpacing("0", -1), "0");
  assert.equal(stepSpacing(null, 1), "1");
  assert.equal(stepSpacing("[13px]", 1), "[13px]");
});

test("cssColor resolves palette tokens through theme vars", () => {
  assert.equal(cssColor("zinc-400"), "var(--color-zinc-400, transparent)");
  assert.equal(cssColor("red-50"), "var(--color-red-50, transparent)");
  assert.equal(cssColor("black"), "black");
  assert.equal(cssColor("transparent"), "transparent");
});

test("cssColor passes through arbitrary colour values", () => {
  assert.equal(cssColor("[#ff0055]"), "#ff0055");
  assert.equal(cssColor("[rgb(1_2_3)]"), "rgb(1 2 3)");
  assert.equal(cssColor("[oklch(0.7_0.1_200)]"), "oklch(0.7 0.1 200)");
});

test("cssColor refuses what it cannot resolve", () => {
  assert.equal(cssColor(null), null);
  assert.equal(cssColor(""), null);
  assert.equal(cssColor("brand"), null); // project-defined token, not ours
  assert.equal(cssColor("zinc-425"), null); // off-scale shade
  assert.equal(cssColor("[--my-var]"), null);
});

// --- mergeClasses (conflict resolution for whole class strings) -------------

test("mergeClasses keeps the last of each conflicting utility", () => {
  assert.equal(mergeClasses("p-4 p-6"), "p-6");
  assert.equal(mergeClasses("flex grid"), "grid");
  assert.equal(mergeClasses("text-sm text-lg"), "text-lg");
  assert.equal(mergeClasses("px-2 p-4"), "p-4");
});

test("mergeClasses treats background properties as independent", () => {
  // The reason for the extra pass over tailwind-merge: these are different
  // CSS properties that merely share the `bg-` prefix.
  const out = mergeClasses("bg-red-500 bg-cover bg-no-repeat bg-center");
  for (const token of ["bg-red-500", "bg-cover", "bg-no-repeat", "bg-center"]) {
    assert.ok(out.split(" ").includes(token), `${token} missing from "${out}"`);
  }
  // Same property still collapses.
  assert.equal(mergeClasses("bg-red-500 bg-blue-500"), "bg-blue-500");
  assert.equal(mergeClasses("bg-cover bg-contain"), "bg-contain");
});

test("mergeClasses leaves variants and unknown classes alone", () => {
  assert.equal(mergeClasses("p-2 hover:p-4"), "p-2 hover:p-4");
  assert.equal(mergeClasses("my-own-class p-2"), "my-own-class p-2");
  assert.equal(mergeClasses(""), "");
});

// --- resize gesture → classes ------------------------------------------------
//
// A canvas resize is a class edit, so the only question that matters is
// whether the class it produces is exactly the size that was dragged. It never
// snaps to the spacing scale: `w-64` is 256px only while `--spacing` is its
// default, and a project that redefines it would get a silently different size
// than the one under the pointer.

test("a dragged size becomes an exact arbitrary value", () => {
  assert.equal(sizeClass("w", 437), "w-[437px]");
  assert.equal(sizeClass("h", 180), "h-[180px]");
  assert.equal(
    sizeClass("w", 256),
    "w-[256px]",
    "a scale-sized drag must not snap to w-64 — the scale moves with --spacing",
  );
  assert.equal(sizeClass("w", 12.6), "w-[13px]", "sub-pixel drags round");
  assert.equal(sizeClass("w", -5), "w-[0px]", "never a negative size");
});

test("resizing replaces the existing width, whatever form it had", () => {
  for (const before of ["w-full", "w-64", "w-[100px]", "w-1/2"]) {
    const after = fromTokens(
      setKnob(toTokens(`${before} p-4 flex`), KNOBS.width, sizeClass("w", 437)),
    );
    assert.equal(after.includes(before), false, `${before} should be replaced`);
    assert.match(after, /w-\[437px\]/);
    assert.match(after, /p-4/, "unrelated classes must survive");
    assert.match(after, /flex/);
  }
});

test("a side grip sets one axis and leaves the other alone", () => {
  // The overlay sends null for the axis it did not drag; pinning a
  // content-sized height because the user dragged sideways would be a bug the
  // user could not see until the content changed.
  const tokens = setKnob(toTokens("p-4"), KNOBS.width, sizeClass("w", 300));
  const out = fromTokens(tokens);
  assert.match(out, /w-\[300px\]/);
  assert.equal(/\bh-/.test(out), false, "height must not appear");
});

test("a corner grip sets both axes", () => {
  let tokens = toTokens("rounded p-4");
  tokens = setKnob(tokens, KNOBS.width, sizeClass("w", 300));
  tokens = setKnob(tokens, KNOBS.height, sizeClass("h", 180));
  const out = fromTokens(tokens);
  assert.match(out, /w-\[300px\]/);
  assert.match(out, /h-\[180px\]/);
  assert.match(out, /rounded/);
});

test("a project token's colour comes from the page, for the class it was read with", () => {
  const el = {
    domClassName: "flex bg-primary text-muted-foreground/80 border-border",
    colors: { background: "rgb(37, 99, 235)", text: "oklch(0.5 0 0 / 0.8)", border: "rgb(1, 2, 3)" },
  };
  assert.equal(pageColor("primary", "bg", el), "rgb(37, 99, 235)");
  assert.equal(pageColor("muted-foreground/80", "text", el), "oklch(0.5 0 0 / 0.8)");
  assert.equal(pageColor("border", "border", el), "rgb(1, 2, 3)");
  // The user staged a different fill: the snapshot is about the old one.
  assert.equal(pageColor("secondary", "bg", el), null);
  // A prefix is not a match (`bg-primary` is not `bg-primary-foreground`).
  assert.equal(pageColor("primary-foreground", "bg", el), null);
  // No fill, no selection, or an overlay that predates the report.
  assert.equal(pageColor(null, "bg", el), null);
  assert.equal(pageColor("primary", "bg", null), null);
  assert.equal(pageColor("primary", "bg", { domClassName: "bg-primary" }), null);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
