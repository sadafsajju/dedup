// Who a keystroke belongs to: tool shortcuts, or the field being typed in
// (src/lib/keys).
// Run: pnpm test:keys
//
// The failure this pins is invisible until it bites: letters typed into the
// chat composer reaching the canvas tool shortcuts, so the tool changed under
// the user mid-sentence. A keystroke the canvas forwards is replayed on
// `window`, so the event's target never looks like a field — the focused
// element has to be asked too.
import assert from "node:assert/strict";
import { isTextEntry, typingInEditor } from "../src/lib/keys.ts";

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

const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });
const windowTarget = {}; // what a replayed, forwarded keystroke targets
const composer = el("TEXTAREA");
const canvasFrame = el("IFRAME");
const body = el("BODY");

test("inputs, textareas and editable elements take text; nothing else does", () => {
  assert.equal(isTextEntry(el("INPUT")), true);
  assert.equal(isTextEntry(el("textarea")), true, "tag case does not matter");
  assert.equal(isTextEntry(el("DIV", { isContentEditable: true })), true);
  assert.equal(isTextEntry(el("DIV")), false);
  assert.equal(isTextEntry(canvasFrame), false);
  assert.equal(isTextEntry(null), false);
  assert.equal(isTextEntry(windowTarget), false);
});

test("a key aimed at a field is the field's", () => {
  assert.equal(typingInEditor(composer, composer), true);
});

test("a forwarded key while the composer has focus is still the composer's", () => {
  // The bug: target is `window`, so a target-only check called this a
  // shortcut and `a` switched the tool to Annotate.
  assert.equal(typingInEditor(windowTarget, composer), true);
});

test("a forwarded key while the canvas has focus is a shortcut", () => {
  assert.equal(typingInEditor(windowTarget, canvasFrame), false);
});

test("with nothing focused, a bare key is a shortcut", () => {
  assert.equal(typingInEditor(body, body), false);
  assert.equal(typingInEditor(windowTarget, null), false);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
