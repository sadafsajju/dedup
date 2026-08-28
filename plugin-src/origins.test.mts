// Which origin a page artboard loads from (src/lib/origins).
// Run: pnpm test:origins
//
// This decides whether a frame renders with the user's session or without it,
// which is what lets a welcome page (guarded *against* signed-in users) and a
// dashboard (guarded *for* them) sit side by side on the same canvas. Getting
// the precedence wrong means an artboard silently showing the wrong thing, so
// the rules are pinned here.
import assert from "node:assert/strict";
import { HOLD_FLAG, frameUrl, resolveOrigin } from "../src/lib/origins.ts";
import type { OriginInputs } from "../src/lib/origins.ts";
// @ts-expect-error — the built plugin bundle ships no type declarations.
import { HOLD_FLAG as TAGGER_HOLD_FLAG } from "../src-tauri/assets/dedup-tagger.mjs";

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

const SHARED = "http://localhost:5173";
const GUEST = "http://127.0.0.1:5173";

const inputs = (over: Partial<OriginInputs> = {}): OriginInputs => ({
  sessionModes: {},
  frameOrigins: {},
  devUrl: SHARED,
  devAltUrl: GUEST,
  ...over,
});

test("with no opinion either way, a frame uses the live session", () => {
  assert.equal(resolveOrigin("/welcome", inputs()), SHARED);
});

test("the redirect fallback moves an untouched frame to the guest origin", () => {
  const s = inputs({ frameOrigins: { "/welcome": "alt" } });
  assert.equal(resolveOrigin("/welcome", s), GUEST);
  // Only the frame it applies to.
  assert.equal(resolveOrigin("/dashboard", s), SHARED);
});

test("an explicit choice beats whatever the fallback guessed", () => {
  // The case that motivated this: signed in, so the app bounces /welcome to
  // /dashboard. Pinning it "signed out" must hold it on the welcome page…
  const out = inputs({
    sessionModes: { "/welcome": "out" },
    frameOrigins: { "/welcome": "shared" },
  });
  assert.equal(resolveOrigin("/welcome", out), GUEST);

  // …and the reverse: a frame the fallback pushed to guest, dragged back by
  // hand, must stay on the real session.
  const back = inputs({
    sessionModes: { "/dashboard": "in" },
    frameOrigins: { "/dashboard": "alt" },
  });
  assert.equal(resolveOrigin("/dashboard", back), SHARED);
});

test("both artboards can be live at once, each under its own session", () => {
  const s = inputs({ sessionModes: { "/welcome": "out", "/dashboard": "in" } });
  assert.equal(resolveOrigin("/welcome", s), GUEST);
  assert.equal(resolveOrigin("/dashboard", s), SHARED);
});

test("with no second origin, signed-out degrades instead of breaking", () => {
  // Nowhere to be signed out — the frame must still load (the Pages tab
  // disables the control and says why), never resolve to null or undefined.
  const s = inputs({ devAltUrl: null, sessionModes: { "/welcome": "out" } });
  assert.equal(resolveOrigin("/welcome", s), SHARED);

  // Same for a stale "alt" left behind when the alt origin went away.
  const stale = inputs({ devAltUrl: null, frameOrigins: { "/welcome": "alt" } });
  assert.equal(resolveOrigin("/welcome", stale), SHARED);
});

test("before the dev server is up there is no origin to give", () => {
  const s = inputs({ devUrl: null, devAltUrl: null });
  assert.equal(resolveOrigin("/", s), null);
});

test("the editor and the tagger agree on the hold flag", () => {
  // The flag travels on the frame's URL because it must reach the page before
  // the app boots. The editor writes it and the injected boot script reads
  // it, from two separately bundled worlds — if they ever disagree, holding
  // silently stops working, with nothing to see anywhere.
  assert.equal(HOLD_FLAG, TAGGER_HOLD_FLAG);
});

test("the hold flag rides on the frame URL, and only when asked", () => {
  assert.equal(frameUrl("/splash", "http://localhost:5173", false), "http://localhost:5173/splash");
  assert.equal(
    frameUrl("/splash", "http://localhost:5173", true),
    `http://localhost:5173/splash?${HOLD_FLAG}=1`,
  );
  // A route carrying its own query keeps it.
  assert.equal(
    frameUrl("/p?tab=two", "http://localhost:5173", true),
    `http://localhost:5173/p?tab=two&${HOLD_FLAG}=1`,
  );
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
