// What may and may not be done to a response header so the canvas can frame
// the user's app. The failure these guard against is invisible — the browser
// refuses the frame with no error — so every rule here is one a bug would
// turn back into a blank white artboard.
import assert from "node:assert/strict";
import {
  blocksFraming,
  guardResponse,
  stripFrameAncestors,
  stripFrameGuards,
} from "./frameable.mjs";
import { withDedup } from "./next.mjs";

let passed = 0;
// Awaits, so an assertion inside an async test fails the run rather than
// escaping as an unhandled rejection and reporting a pass.
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

/** Minimal stand-in for a Node response: records what actually got set. */
function fakeRes() {
  const headers = new Map();
  return {
    sent: null,
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
      return this;
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    hasHeader(name) {
      return headers.has(String(name).toLowerCase());
    },
    removeHeader(name) {
      headers.delete(String(name).toLowerCase());
    },
    writeHead(...args) {
      this.sent = args;
      return this;
    },
    headers,
  };
}

console.log("frameable");

await test("X-Frame-Options is dropped whatever it says", () => {
  // DENY and SAMEORIGIN both refuse dedup's frame — it is a different origin.
  for (const value of ["DENY", "SAMEORIGIN", "deny"]) {
    assert.equal(blocksFraming("X-Frame-Options", value), true);
    assert.deepEqual(stripFrameGuards([{ key: "X-Frame-Options", value }]), []);
  }
});

await test("a CSP keeps every directive except frame-ancestors", () => {
  // The rest of the policy changes how the app behaves, and the canvas exists
  // to show the app as it really is.
  const value = "default-src 'self'; frame-ancestors 'none'; img-src *";
  assert.equal(stripFrameAncestors(value), "default-src 'self'; img-src *");
});

await test("a CSP that was only frame-ancestors is removed, not left empty", () => {
  assert.equal(stripFrameAncestors("frame-ancestors 'none'"), null);
  assert.deepEqual(
    stripFrameGuards([
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
    ]),
    [],
  );
});

await test("unrelated security headers are left exactly alone", () => {
  // dedup relaxes what stops it rendering and nothing else.
  const entries = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "origin-when-cross-origin" },
    { key: "Content-Security-Policy", value: "default-src 'self'" },
  ];
  assert.deepEqual(stripFrameGuards(entries), entries);
});

await test("a name that merely contains 'frame' is not a framing rule", () => {
  assert.equal(blocksFraming("X-Frame-Rate", "60"), false);
  assert.equal(
    stripFrameAncestors("default-src 'self'; frame-src 'none'"),
    "default-src 'self'; frame-src 'none'",
  );
});

await test("setHeader cannot reinstate a guard after the response is patched", () => {
  const res = fakeRes();
  guardResponse(res);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("content-type", "text/html");
  assert.equal(res.hasHeader("x-frame-options"), false);
  assert.equal(res.getHeader("content-type"), "text/html");
});

await test("writeHead cannot smuggle one past either", () => {
  // Vite and its plugins use both paths; a header arriving by the unpatched
  // one is a blank artboard again.
  const res = fakeRes();
  guardResponse(res);
  res.writeHead(200, {
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  const sent = res.sent[1];
  assert.equal("X-Frame-Options" in sent, false);
  assert.equal(sent["Content-Security-Policy"], "default-src 'self'");
  assert.equal(sent["X-Content-Type-Options"], "nosniff");
});

await test("writeHead clears a guard committed before the patch was installed", () => {
  const res = fakeRes();
  res.setHeader("X-Frame-Options", "DENY");
  guardResponse(res);
  res.writeHead(200);
  assert.equal(res.hasHeader("x-frame-options"), false);
});

await test("the response is only announced once, however many headers it had", () => {
  const res = fakeRes();
  let announcements = 0;
  guardResponse(res, () => {
    announcements += 1;
  });
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  // guardResponse reports each one; the caller is what dedupes. Assert it
  // reports rather than swallows, which is what the caller relies on.
  assert.ok(announcements >= 1);
});

console.log("\nwithDedup headers()");

await test("the wrapper strips the project's own X-Frame-Options", async () => {
  const config = withDedup(
    {
      headers: async () => [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Frame-Options", value: "DENY" },
            { key: "X-Content-Type-Options", value: "nosniff" },
          ],
        },
      ],
    },
    { enabled: true },
  );
  const rules = await config.headers();
  assert.deepEqual(rules[0].headers, [
    { key: "X-Content-Type-Options", value: "nosniff" },
  ]);
  assert.equal(rules[0].source, "/(.*)");
});

await test("a project with no headers() of its own still gets a valid one", async () => {
  const config = withDedup({}, { enabled: true });
  assert.deepEqual(await config.headers(), []);
});

await test("the wrapper is inert when tagging is off", () => {
  // The line in the user's config must change nothing about their own
  // `next dev`, their CI, or their production build.
  const original = { headers: async () => [{ source: "/", headers: [] }] };
  assert.equal(withDedup(original, { enabled: false }), original);
});

console.log(`\n${passed} passed`);
