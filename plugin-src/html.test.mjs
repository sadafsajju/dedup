// Static-site pipeline tests: the HTML stamper, the HTML write-back, and the
// static dev server. Run: pnpm test:html
//
// Tests the BUILT bundles (what actually ships inside the app) — the stamper
// through the server that serves it, and the write-back through the same
// stdin/stdout protocol the Rust sidecar speaks.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(here, "..", "src-tauri", "assets");
const WRITEBACK = path.join(ASSETS, "dedup-writeback.mjs");
const SERVER = path.join(ASSETS, "dedup-serve.mjs");
const OVERLAY = path.join(ASSETS, "dedup-overlay.js");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`  FAIL — ${name}\n${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
}

/** One sidecar round-trip, exactly as sidecar.rs makes it. */
function sidecar(request) {
  const out = spawnSync(process.execPath, [WRITEBACK], {
    input: JSON.stringify(request),
    encoding: "utf8",
  });
  if (out.status !== 0) throw new Error(`sidecar exited ${out.status}: ${out.stderr}`);
  return JSON.parse(out.stdout);
}

let seq = 0;
function tempProject(files) {
  const dir = path.join(os.tmpdir(), `dedup-html-${process.pid}-${seq++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return dir;
}

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Site</title>
  </head>
  <body class="bg-white">
    <header class="flex gap-2">
      <h1 class="text-xl">Hello</h1>
      <img src="logo.png" alt="" />
    </header>
    <main>
      <p>Some copy.</p>
    </main>
  </body>
</html>
`;

// --- inspect ------------------------------------------------------------------

await test("inspect reads an element's class, tag and live position", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  // 0 html, 1 head, 2 meta, 3 title, 4 body, 5 header, 6 h1, 7 img, 8 main, 9 p
  const h1 = sidecar({ cmd: "inspect", file, index: 6 });
  assert.equal(h1.ok, true, h1.error);
  assert.equal(h1.tag, "h1");
  assert.equal(h1.className, "text-xl");
  assert.equal(h1.editable, true);
  assert.equal(h1.text, "Hello");
  assert.equal(h1.canEditText, true);
  assert.equal(h1.line, 9, "position is derived live, never carried in the id");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("the document skeleton refuses to be moved or deleted", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const body = sidecar({ cmd: "inspect", file, index: 4 });
  assert.equal(body.tag, "body");
  assert.equal(body.core, "body");
  assert.equal(body.canRemove, false);
  assert.equal(body.canMove, false);
  assert.match(body.structuralReason, /document skeleton/);

  const header = sidecar({ cmd: "inspect", file, index: 5 });
  assert.equal(header.canRemove, true, "ordinary content is editable");
  assert.equal(header.canMove, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a void element takes no children and no text", () => {
  const dir = tempProject({ "index.html": PAGE });
  const img = sidecar({ cmd: "inspect", file: path.join(dir, "index.html"), index: 7 });
  assert.equal(img.tag, "img");
  assert.equal(img.canAcceptChildren, false);
  assert.equal(img.canEditText, false);
  assert.match(img.textReason, /void element/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("an element with child elements is not text-editable", () => {
  const dir = tempProject({ "index.html": PAGE });
  const header = sidecar({ cmd: "inspect", file: path.join(dir, "index.html"), index: 5 });
  assert.equal(header.canEditText, false);
  assert.match(header.textReason, /child elements/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- class / text -------------------------------------------------------------

await test("a class edit rewrites the value and nothing else in the file", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "class", index: 6, className: "text-2xl font-bold" }],
  });
  assert.equal(res.ok, true, res.error);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.includes('<h1 class="text-2xl font-bold">Hello</h1>'), after);
  assert.equal(
    after.replace('text-2xl font-bold', 'text-xl'),
    PAGE,
    "the rest of the file is byte-identical",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("an element with no class attribute gets one", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "class", index: 8, className: "mx-auto" }],
  });
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.readFileSync(file, "utf8").includes('<main class="mx-auto">'));
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("an unquoted class attribute is edited in place", () => {
  const dir = tempProject({ "index.html": "<div class=card>x</div>\n" });
  const file = path.join(dir, "index.html");
  const info = sidecar({ cmd: "inspect", file, index: 0 });
  assert.equal(info.className, "card");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "class", index: 0, className: "card wide" }],
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.readFileSync(file, "utf8"), "<div class=card wide>x</div>\n");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("text edits replace only the text node", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "text", index: 9, text: "Rewritten copy." }],
  });
  assert.equal(res.ok, true, res.error);
  assert.ok(fs.readFileSync(file, "utf8").includes("<p>Rewritten copy.</p>"));
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the trust gate -----------------------------------------------------------

await test("a class or text value that could open a tag is refused", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  for (const op of [
    { op: "class", index: 6, className: 'x"><script>alert(1)</script>' },
    { op: "class", index: 6, className: "a<b" },
    { op: "text", index: 9, text: "<img src=x onerror=alert(1)>" },
  ]) {
    const res = sidecar({ cmd: "apply", file, ops: [op] });
    assert.equal(res.ok, false, `should refuse ${JSON.stringify(op)}`);
    assert.match(res.error, /unsafe/);
  }
  assert.equal(fs.readFileSync(file, "utf8"), PAGE, "a refused program writes nothing");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a snippet that never closes its element is refused", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  // Dropped in as-is this would swallow every following sibling — and an HTML5
  // parser would report no error at all.
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "insert", target: 8, position: "inside", snippet: "<div>" }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /never closed/);
  assert.equal(fs.readFileSync(file, "utf8"), PAGE);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a program with any refused op writes nothing at all", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [
      { op: "class", index: 6, className: "text-3xl" }, // fine on its own
      { op: "remove", index: 4 }, // <body> — refused
    ],
  });
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), PAGE, "no partial application");
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("removing an element inside another removal is refused, not double-counted", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "remove", index: 5 }, { op: "remove", index: 6 }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /inside another element being removed/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- structure ----------------------------------------------------------------

await test("remove takes the whole line the element owns", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({ cmd: "apply", file, ops: [{ op: "remove", index: 7 }] });
  assert.equal(res.ok, true, res.error);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(!after.includes("logo.png"));
  assert.ok(!/\n\s*\n\s*<\/header>/.test(after), "no blank line left behind:\n" + after);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("insert lands inside the target, indented one level deeper", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [
      { op: "insert", target: 8, position: "inside", snippet: '<a class="btn">Go</a>' },
    ],
  });
  assert.equal(res.ok, true, res.error);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(after.includes('      <a class="btn">Go</a>\n    </main>'), after);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("the shapes the insert palette produces all land", async () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  // The HTML spelling of the four palette entries (see src/lib/palette.ts and
  // its toHtmlSnippet translation): a paired container, a text element, a
  // button, and a void image.
  for (const snippet of [
    '<div class="flex min-h-16 min-w-16 flex-col gap-2 rounded border p-4"></div>',
    '<p class="text-base">Text</p>',
    '<button type="button" class="rounded px-3 py-2 text-sm">Button</button>',
    '<img src="" alt="" class="h-32 w-32 rounded object-cover" />',
  ]) {
    const res = sidecar({
      cmd: "apply",
      file,
      ops: [{ op: "insert", target: 8, position: "inside", snippet }],
    });
    assert.equal(res.ok, true, `${snippet}: ${res.error}`);
  }
  const after = fs.readFileSync(file, "utf8");
  for (const tag of ["div", "p", "button", "img"]) {
    assert.ok(after.includes(`<${tag} `), `${tag} landed:\n${after}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("copy hands back an element's own markup, and insert takes it back", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const r = sidecar({ cmd: "copy", file, index: 5 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.lang, "html");
  assert.equal(r.tag, "header");
  assert.equal(
    r.snippet,
    '<header class="flex gap-2">\n  <h1 class="text-xl">Hello</h1>\n  <img src="logo.png" alt="" />\n</header>',
    r.snippet,
  );
  // <header>, <h1>, <img> — what the copy swallowed.
  assert.deepEqual(r.contains, [5, 6, 7]);
  // Markup carries nothing but itself; only a JSX snippet has names to lose.
  assert.deepEqual(r.refs, []);

  const back = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "insert", target: 8, position: "inside", snippet: r.snippet }],
  });
  assert.equal(back.ok, true, back.error);
  const after = fs.readFileSync(file, "utf8");
  assert.equal(after.match(/<h1 class="text-xl">Hello<\/h1>/g).length, 2, after);
  // Re-indented for its new home, three levels deep inside <main>.
  assert.ok(after.includes('      <header class="flex gap-2">\n        <h1'), after);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("the document skeleton cannot be copied", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const r = sidecar({ cmd: "copy", file, index: 4 });
  assert.equal(r.ok, false, "<body> is not a section anyone can paste");
  assert.match(r.error, /document skeleton/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a paste is refused when what it is placed against is being deleted", () => {
  // Cut-then-paste is one program. Appending onto a chunk the same program
  // removes drops the content silently, so it is refused instead.
  for (const position of ["before", "after", "inside"]) {
    const dir = tempProject({ "index.html": PAGE });
    const file = path.join(dir, "index.html");
    const r = sidecar({
      cmd: "apply",
      file,
      ops: [
        { op: "remove", index: 5 },
        { op: "insert", target: 5, position, snippet: "<p>moved</p>" },
      ],
    });
    assert.equal(r.ok, false, `${position} should be refused`);
    assert.match(r.error, /being deleted/);
    assert.equal(fs.readFileSync(file, "utf8"), PAGE, "and nothing was written");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Somewhere else in the same program is a real move, and lands.
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const ok = sidecar({
    cmd: "apply",
    file,
    ops: [
      { op: "remove", index: 5 },
      { op: "insert", target: 8, position: "inside", snippet: "<p>moved</p>" },
    ],
  });
  assert.equal(ok.ok, true, ok.error);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(!after.includes("<header"), after);
  assert.ok(after.includes("<p>moved</p>"), after);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("move reparents and re-indents, and edits inside the moved block survive", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [
      { op: "move", index: 6, target: 8, position: "inside" },
      { op: "class", index: 6, className: "text-4xl" },
    ],
  });
  assert.equal(res.ok, true, res.error);
  const after = fs.readFileSync(file, "utf8");
  assert.ok(
    after.includes('      <h1 class="text-4xl">Hello</h1>\n    </main>'),
    "moved, re-indented, and carrying its class edit:\n" + after,
  );
  assert.equal(
    (after.match(/<h1/g) ?? []).length,
    1,
    "moved once, not copied",
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("an element cannot be moved into itself", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "apply",
    file,
    ops: [{ op: "move", index: 5, target: 6, position: "inside" }],
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /inside itself/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- whole-file writes (AI chat) ----------------------------------------------

await test("a malformed HTML replacement is refused", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const res = sidecar({
    cmd: "writeFile",
    file,
    content: '<!doctype html><html><body><div class="a><p>hi</p></body></html>',
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /malformed HTML/);
  assert.equal(fs.readFileSync(file, "utf8"), PAGE);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a clean HTML replacement is written", () => {
  const dir = tempProject({ "index.html": PAGE });
  const file = path.join(dir, "index.html");
  const next = "<!doctype html>\n<html><body><h1>New</h1></body></html>\n";
  const res = sidecar({ cmd: "writeFile", file, content: next });
  assert.equal(res.ok, true, res.error);
  assert.equal(fs.readFileSync(file, "utf8"), next);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a stylesheet with unbalanced braces is refused", () => {
  const dir = tempProject({ "style.css": "body { color: red; }\n" });
  const file = path.join(dir, "style.css");
  const bad = sidecar({ cmd: "writeFile", file, content: "body { color: red;\n" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /unbalanced braces/);
  const truncated = sidecar({ cmd: "writeFile", file, content: "/* note\nbody{}" });
  assert.equal(truncated.ok, false);
  assert.match(truncated.error, /unclosed comment/);
  const good = sidecar({ cmd: "writeFile", file, content: "body { color: blue; }\n" });
  assert.equal(good.ok, true, good.error);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test("a file type dedup cannot parse is refused by name", () => {
  const dir = tempProject({ "notes.md": "# hi\n" });
  const res = sidecar({
    cmd: "writeFile",
    file: path.join(dir, "notes.md"),
    content: "# bye\n",
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /unsupported file type/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- routes -------------------------------------------------------------------

await test("every .html file in a static site is a route", () => {
  const dir = tempProject({
    "index.html": PAGE,
    "about.html": PAGE,
    "docs/index.html": PAGE,
    "docs/api.html": PAGE,
    "node_modules/pkg/index.html": PAGE,
  });
  // The framework comes from the caller — detection already answered it, and
  // a Next project's app/ tree must not be able to answer as a static site.
  const res = sidecar({ cmd: "routes", root: dir, framework: "static" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.routes.sort(), ["/", "/about.html", "/docs/", "/docs/api.html"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the static dev server ----------------------------------------------------

/** Start the server bundle, resolve with its port and a stop() handle. */
function startServer(root, base = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // eslint-disable-next-line prettier/prettier
      [SERVER, "--root", root, "--base", base, "--overlay", OVERLAY, "--port", "0"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server never announced a URL. output:\n${out}`));
    }, 10_000);
    child.stdout.on("data", (d) => {
      out += d;
      const m = /http:\/\/localhost:(\d+)\//.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), stop: () => child.kill("SIGKILL") });
      }
    });
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}. output:\n${out}`));
    });
  });
}

await test("the static server stamps pages and injects the canvas scripts", async () => {
  const dir = tempProject({ "index.html": PAGE, "style.css": "body{color:red}\n" });
  const server = await startServer(dir);
  try {
    const html = await (await fetch(`http://localhost:${server.port}/`)).text();
    // Same id scheme the JSX tagger stamps, so the canvas has one model.
    assert.match(html, /<h1 class="text-xl" data-dedup-id="index\.html@6">/);
    assert.match(html, /<body class="bg-white" data-dedup-id="index\.html@4" data-dedup-core="body">/);
    assert.match(html, /<script src="\/__dedup\/overlay\.js" defer><\/script>/);
    // Served, not inlined: a seed containing "</script>" would otherwise
    // close the tag and spill the rest of the boot script into the page.
    assert.match(html, /<script src="\/__dedup\/session\.js"><\/script>/);
    assert.doesNotMatch(html, /<script>[\s\S]*dedup boot script/);
    const boot = await fetch(`http://localhost:${server.port}/__dedup/session.js`);
    assert.equal(boot.headers.get("content-type"), "text/javascript");
    assert.match(await boot.text(), /dedup boot script/);
    assert.match(html, /EventSource\("\/__dedup\/reload"\)/, "live reload client");

    const css = await fetch(`http://localhost:${server.port}/style.css`);
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal((await css.text()).trim(), "body{color:red}");

    const routes = await (await fetch(`http://localhost:${server.port}/__dedup/routes`)).json();
    assert.deepEqual(routes.routes, ["/"]);

    const overlay = await fetch(`http://localhost:${server.port}/__dedup/overlay.js`);
    assert.equal(overlay.status, 200);
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test("the static server serves nothing outside the project folder", async () => {
  const dir = tempProject({ "index.html": PAGE });
  fs.writeFileSync(path.join(path.dirname(dir), "dedup-secret.txt"), "nope");
  const server = await startServer(dir);
  try {
    for (const attempt of [
      "/../dedup-secret.txt",
      "/%2e%2e/dedup-secret.txt",
      "/./../../etc/hosts",
      "/etc/hosts",
    ]) {
      const res = await fetch(`http://localhost:${server.port}${attempt}`);
      assert.equal(res.status, 404, `${attempt} must not resolve`);
    }
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The one invariant that spans both bundles: the id the *server* stamps into
 * the page must resolve, in the *write-back*, to the element it was stamped
 * onto. They are separately bundled and only agree because they share
 * htmlwalk.mjs — so this asserts the agreement rather than trusting it.
 *
 * Run against a site whose pages sit in a subfolder, which is where the two
 * could most easily disagree: the server serves `site/`, but ids stay relative
 * to the project root, because that is the path the write-back opens.
 */
await test("an id stamped by the server resolves in the write-back", async () => {
  const dir = tempProject({ "site/index.html": PAGE });
  const server = await startServer(path.join(dir, "site"), dir);
  try {
    const html = await (await fetch(`http://localhost:${server.port}/`)).text();
    // Find the id the server put on the <h1> — the element under test.
    const m = /<h1 class="text-xl" data-dedup-id="([^"]+)"/.exec(html);
    assert.ok(m, `the page was not stamped:\n${html.slice(0, 400)}`);

    const at = m[1].lastIndexOf("@");
    const relFile = m[1].slice(0, at);
    const index = Number(m[1].slice(at + 1));
    assert.equal(relFile, "site/index.html", "ids are relative to the project root");

    // Resolved exactly the way the Rust sidecar resolves it: root + relFile.
    const file = path.join(dir, relFile);
    const info = sidecar({ cmd: "inspect", file, index });
    assert.equal(info.ok, true, info.error);
    assert.equal(info.tag, "h1", "the id points at the element it was stamped on");
    assert.equal(info.className, "text-xl");

    // And the edit lands on that element and nothing else.
    const res = sidecar({
      cmd: "apply",
      file,
      ops: [{ op: "class", index, className: "text-5xl" }],
    });
    assert.equal(res.ok, true, res.error);
    assert.ok(
      fs.readFileSync(file, "utf8").includes('<h1 class="text-5xl">Hello</h1>'),
    );
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} failed` : ""}`);
