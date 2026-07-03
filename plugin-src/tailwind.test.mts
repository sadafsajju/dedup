// Tests for the Tailwind class ⇄ knob mapping layer.
// Run: pnpm test:tw  (node --experimental-strip-types)
import assert from "node:assert/strict";
import {
  toTokens,
  fromTokens,
  readKnob,
  setKnob,
  readSpacing,
  writeSpacing,
  KNOBS,
  stepSpacing,
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

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
