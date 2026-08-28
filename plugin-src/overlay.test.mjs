// Overlay tests — run the BUILT overlay bundle against a stub DOM.
// Run: pnpm test:overlay
//
// The overlay is one IIFE injected into the user's page: if anything in it
// throws while the script evaluates, every listener after the throw is never
// installed and the canvas goes quietly dead — no selection, no staged
// preview, no error anywhere the user can see. (That is exactly what a
// `const` declared below the call to `mount()` did on 2026-08-23.) So the
// first thing worth asserting is simply "it loads and says hello".
//
// The stub is deliberately small: enough DOM for the load path plus the
// select / stage / structural paths. It is not a browser, and it is not
// trying to be — the gestures that need real hit-testing and layout stay
// manual (see PROGRESS.md).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const OVERLAY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/assets/dedup-overlay.js",
);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (e) {
    console.error(`  FAIL — ${name}\n${e.stack ?? e.message}`);
    process.exitCode = 1;
  }
}

// --- the stub DOM -----------------------------------------------------------

function parseSelector(sel) {
  const m = sel.match(/^\[([\w-]+)(?:="(.*)")?\]$/);
  if (m) return { attr: m[1], value: m[2] };
  if (sel === "*") return { all: true };
  throw new Error(`stub DOM: unsupported selector ${sel}`);
}

function makeEl(tag, attrs = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    nodeType: 1,
    attrs: { ...attrs },
    children: [],
    parentElement: null,
    parentNode: null,
    isConnected: true,
    textContent: "",
    style: makeStyle(),
    getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null),
    setAttribute: (k, v) => void (node.attrs[k] = String(v)),
    removeAttribute: (k) => void delete node.attrs[k],
    hasAttribute: (k) => k in node.attrs,
    addEventListener() {},
    focus() {},
    blur() {},
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, width: 20, height: 10 }),
    appendChild(child) {
      child.remove();
      child.parentElement = node;
      child.parentNode = node;
      child.isConnected = true;
      node.children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.remove();
      child.parentElement = node;
      child.parentNode = node;
      child.isConnected = true;
      const at = ref ? node.children.indexOf(ref) : -1;
      if (at === -1) node.children.push(child);
      else node.children.splice(at, 0, child);
      return child;
    },
    remove() {
      const parent = node.parentNode;
      if (!parent) return;
      parent.children.splice(parent.children.indexOf(node), 1);
      node.parentElement = null;
      node.parentNode = null;
      node.isConnected = false;
    },
    contains: (other) => {
      for (let cur = other; cur; cur = cur.parentElement) if (cur === node) return true;
      return false;
    },
    closest(sel) {
      const want = parseSelector(sel);
      for (let cur = node; cur; cur = cur.parentElement) {
        if (matches(cur, want)) return cur;
      }
      return null;
    },
    querySelectorAll: (sel) => descendants(node).filter((n) => matches(n, parseSelector(sel))),
    querySelector: (sel) => node.querySelectorAll(sel)[0] ?? null,
    get nextSibling() {
      const kids = node.parentNode?.children ?? [];
      return kids[kids.indexOf(node) + 1] ?? null;
    },
    get firstElementChild() {
      return node.children[0] ?? null;
    },
    set innerHTML(html) {
      // Only ever fed the palette's preview markup: one element, one attribute
      // pair per token, optional text. Enough to place a staged insert.
      const m = html.match(/^<(\w+)([^>]*?)\/?>(?:(.*?)<\/\w+>)?$/s);
      if (!m) throw new Error(`stub DOM: cannot parse ${html}`);
      const child = makeEl(m[1]);
      for (const a of m[2].matchAll(/([\w-]+)="([^"]*)"/g)) child.setAttribute(a[1], a[2]);
      child.textContent = m[3] ?? "";
      node.children = [];
      node.appendChild(child);
    },
  };
  return node;
}

function makeStyle() {
  const store = {};
  return {
    setProperty: (k, v) => void (store[k] = v),
    removeProperty: (k) => void delete store[k],
    getPropertyValue: (k) => store[k] ?? "",
    ...store,
  };
}

function matches(node, want) {
  if (want.all) return true;
  const v = node.getAttribute?.(want.attr);
  if (v === null || v === undefined) return false;
  return want.value === undefined || v === want.value;
}

function descendants(node) {
  const out = [];
  for (const child of node.children) {
    out.push(child, ...descendants(child));
  }
  return out;
}

/**
 * A page with a header and two paragraphs, tagged the way the tagger would.
 * Returns the sandbox the overlay ran in plus handles for the test.
 */
function loadOverlay() {
  const html = makeEl("html");
  const body = makeEl("body");
  html.appendChild(body);

  const root = makeEl("div", { "data-dedup-id": "src/App.tsx@0", "data-dedup-component": "App", "data-dedup-core": "root" });
  const title = makeEl("h1", { "data-dedup-id": "src/App.tsx@1", "data-dedup-component": "App", class: "text-lg" });
  title.textContent = "Hello";
  const item = makeEl("li", { "data-dedup-id": "src/App.tsx@2", "data-dedup-component": "App", "data-dedup-dyn": "array" });
  body.appendChild(root);
  root.appendChild(title);
  root.appendChild(item);

  const posted = [];
  const listeners = new Map();
  const addListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };

  const documentStub = {
    documentElement: html,
    body,
    readyState: "interactive", // what a `defer` script actually sees
    createElement: (tag) => makeEl(tag),
    addEventListener: addListener,
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    createRange: () => ({ selectNodeContents() {} }),
    title: "Test page",
  };

  const windowStub = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener: addListener,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    parent: { postMessage: (msg) => posted.push(msg) },
  };
  windowStub.parent = { postMessage: (msg) => posted.push(msg) };

  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: {
      pathname: "/",
      reloaded: 0,
      replaced: null,
      reload() {
        sandbox.location.reloaded++;
      },
      replace(to) {
        sandbox.location.replaced = to;
      },
    },
    CSS: { escape: (v) => v },
    MutationObserver: class {
      observe() {}
    },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
    // The overlay wraps these; the stub records what the page's own console
    // still received, so a test can prove forwarding doesn't swallow it.
    consoleCalls: [],
    getComputedStyle: () => ({ overflowY: "visible", overflowX: "visible" }),
  };
  sandbox.console = {
    error: (...a) => sandbox.consoleCalls.push(["error", ...a]),
    warn: (...a) => sandbox.consoleCalls.push(["warn", ...a]),
    log: (...a) => sandbox.consoleCalls.push(["log", ...a]),
  };
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, { PopStateEvent: class {} });

  vm.runInNewContext(fs.readFileSync(OVERLAY, "utf8"), sandbox, {
    filename: "dedup-overlay.js",
  });

  /** Invoke the overlay's own listener for `type`. */
  const fire = (type, event) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  const send = (msg) => fire("message", { data: { __dedup: true, ...msg } });

  return { sandbox, posted, fire, send, nodes: { html, body, root, title, item } };
}

// --- tests ------------------------------------------------------------------

test("the overlay evaluates and announces itself", () => {
  // The regression guard: a throw anywhere during evaluation silently kills
  // every listener declared after it.
  const { posted } = loadOverlay();
  assert.ok(
    posted.some((m) => m.type === "overlay-ready"),
    `no overlay-ready in ${JSON.stringify(posted.map((m) => m.type))}`,
  );
});

test("clicking a tagged element reports a selection with its markers", () => {
  const { posted, fire, nodes } = loadOverlay();
  fire("click", {
    target: nodes.title,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  const selected = posted.find((m) => m.type === "selected");
  assert.ok(selected, "no selection reported");
  assert.equal(selected.payload.dedupId, "src/App.tsx@1");
  assert.equal(selected.payload.component, "App");
  assert.equal(selected.payload.tag, "h1");
  assert.ok(selected.payload.domId, "every selection carries a per-node id");
  // Ancestry is innermost-first and includes the element itself. Array.from
  // re-homes the value: the overlay runs in its own vm realm, and deepEqual
  // refuses cross-realm arrays.
  assert.deepEqual(
    Array.from(selected.payload.ancestry, (a) => a.dedupId),
    ["src/App.tsx@1", "src/App.tsx@0"],
  );
});

test("a click inside an untagged child selects the nearest tagged ancestor", () => {
  const { posted, fire, nodes } = loadOverlay();
  const inner = makeEl("span");
  nodes.title.appendChild(inner);
  fire("click", { target: inner, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(posted.find((m) => m.type === "selected").payload.dedupId, "src/App.tsx@1");
});

test("browse mode hands clicks back to the app", () => {
  const { posted, fire, send, nodes } = loadOverlay();
  send({ type: "set-mode", mode: "browse" });
  fire("click", { target: nodes.title, preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(posted.filter((m) => m.type === "selected").length, 0);
});

test("a staged class patch is applied and then rolled back", () => {
  const { send, nodes } = loadOverlay();
  send({
    type: "stage",
    classes: { "src/App.tsx@1": { from: "text-lg", to: "text-lg p-4" } },
    texts: {},
    structural: [],
  });
  assert.equal(nodes.title.getAttribute("class"), "text-lg p-4");

  send({ type: "stage", classes: {}, texts: {}, structural: [] });
  assert.equal(
    nodes.title.getAttribute("class"),
    "text-lg",
    "dropping an edit must restore what the source said",
  );
});

test("staged structural ops apply, and undo restores the exact position", () => {
  const { send, nodes } = loadOverlay();
  const before = Array.from(nodes.root.children, (c) => c.getAttribute("data-dedup-id"));

  send({
    type: "stage",
    classes: {},
    texts: {},
    structural: [{ op: "remove", id: "src/App.tsx@1" }],
  });
  assert.equal(nodes.title.isConnected, false, "removed element still on the page");

  send({
    type: "stage",
    classes: {},
    texts: {},
    structural: [{ op: "move", id: "src/App.tsx@1", to: "src/App.tsx@2", position: "inside" }],
  });
  assert.equal(nodes.title.parentElement, nodes.item, "move did not re-parent");

  // Reverting the whole program puts the page back exactly as it was — this
  // is the path undo, redo and mid-list revert all share.
  send({ type: "stage", classes: {}, texts: {}, structural: [] });
  assert.deepEqual(
    Array.from(nodes.root.children, (c) => c.getAttribute("data-dedup-id")),
    before,
  );
});

test("a staged insert is addressable, so it can be selected and typed into", () => {
  const { posted, fire, send, nodes } = loadOverlay();
  send({
    type: "stage",
    classes: {},
    texts: {},
    structural: [
      {
        op: "insert",
        id: "src/App.tsx@1",
        pendingId: "pending:abc",
        position: "after",
        html: '<p class="text-base">Text</p>',
      },
    ],
  });
  const inserted = nodes.root.children[1];
  assert.equal(inserted.getAttribute("data-dedup-id"), "pending:abc");

  // Clicking it selects it like any other element — without an id it would
  // resolve to its parent instead, and the inspector would edit the wrong node.
  fire("click", { target: inserted, preventDefault() {}, stopImmediatePropagation() {} });
  const selected = posted.filter((m) => m.type === "selected").pop();
  assert.equal(selected.payload.dedupId, "pending:abc");

  // And staged text reaches it, which is what typing into it produces.
  send({
    type: "stage",
    classes: {},
    texts: { "pending:abc": { from: "Text", to: "Hello" } },
    structural: [
      {
        op: "insert",
        id: "src/App.tsx@1",
        pendingId: "pending:abc",
        position: "after",
        html: '<p class="text-base">Text</p>',
      },
    ],
  });
  assert.equal(nodes.root.children[1].textContent, "Hello");
  assert.equal(
    nodes.root.children[1],
    inserted,
    "an unchanged structural program must not rebuild the node being typed into",
  );
});

test("double-click asks the editor before putting a caret anywhere", () => {
  const { posted, fire, send, nodes } = loadOverlay();
  fire("dblclick", { target: nodes.title, preventDefault() {}, stopImmediatePropagation() {} });
  const request = posted.find((m) => m.type === "text-edit-request");
  assert.ok(request, "double-click must ask, not assume");
  assert.equal(request.id, "src/App.tsx@1");
  assert.equal(
    nodes.title.getAttribute("contenteditable"),
    null,
    "editing must not begin until the editor allows it",
  );

  send({ type: "text-edit-begin", id: "src/App.tsx@1" });
  assert.equal(nodes.title.getAttribute("contenteditable"), "plaintext-only");

  // Typing reports the new text; Escape puts the original back and ends.
  nodes.title.textContent = "Typed";
  fire("input", { target: nodes.title });
  assert.equal(posted.filter((m) => m.type === "text-input").pop().text, "Typed");

  fire("keydown", { target: nodes.title, key: "Escape", preventDefault() {} });
  assert.equal(posted.filter((m) => m.type === "text-input").pop().text, "Hello");
  assert.equal(nodes.title.getAttribute("contenteditable"), null);
});

test("a staged insert places the palette's preview markup", () => {
  const { send, nodes } = loadOverlay();
  send({
    type: "stage",
    classes: {},
    texts: {},
    structural: [
      {
        op: "insert",
        id: "src/App.tsx@1",
        position: "after",
        html: '<p class="text-base">Text</p>',
      },
    ],
  });
  const inserted = nodes.root.children[1];
  assert.equal(inserted.tagName, "P");
  assert.equal(inserted.getAttribute("class"), "text-base");
  assert.equal(
    inserted.getAttribute("data-dedup-staged"),
    "insert",
    "a preview-only element must be marked as such",
  );
  send({ type: "stage", classes: {}, texts: {}, structural: [] });
  assert.equal(nodes.root.children.length, 2, "insert not withdrawn");
});

test("list-layers reports the tagged tree, nested and labeled", () => {
  const { posted, send, nodes } = loadOverlay();
  // An untagged wrapper between tagged elements must not break the chain —
  // its tagged descendants belong to the tagged ancestor above it.
  const wrapper = makeEl("section");
  const inner = makeEl("p", { "data-dedup-id": "src/App.tsx@3", "data-dedup-component": "App" });
  nodes.root.appendChild(wrapper);
  wrapper.appendChild(inner);

  send({ type: "list-layers" });
  const msg = posted.filter((m) => m.type === "layers").pop();
  assert.ok(msg, "no layers report");
  // JSON round-trip re-homes the vm-realm arrays for deepEqual.
  const layers = JSON.parse(JSON.stringify(msg.layers));
  assert.deepEqual(layers, [
    {
      id: "src/App.tsx@0",
      tag: "div",
      component: "App",
      dynamic: null,
      core: "root",
      staged: false,
      text: null,
      children: [
        {
          id: "src/App.tsx@1",
          tag: "h1",
          component: "App",
          dynamic: null,
          core: null,
          staged: false,
          text: "Hello",
          children: [],
        },
        {
          id: "src/App.tsx@2",
          tag: "li",
          component: "App",
          dynamic: "array",
          core: null,
          staged: false,
          text: null,
          children: [],
        },
        {
          id: "src/App.tsx@3",
          tag: "p",
          component: "App",
          dynamic: null,
          core: null,
          staged: false,
          text: null,
          children: [],
        },
      ],
    },
  ]);
});

test("a staged insert appears in the layer tree, marked as such", () => {
  const { posted, send } = loadOverlay();
  send({
    type: "stage",
    classes: {},
    texts: {},
    structural: [
      {
        op: "insert",
        id: "src/App.tsx@1",
        pendingId: "pending:abc",
        position: "after",
        html: '<p class="text-base">Text</p>',
      },
    ],
  });
  send({ type: "list-layers" });
  const layers = JSON.parse(
    JSON.stringify(posted.filter((m) => m.type === "layers").pop().layers),
  );
  const inserted = layers[0].children.find((n) => n.id === "pending:abc");
  assert.ok(inserted, "staged insert missing from the tree");
  assert.equal(inserted.staged, true, "a preview-only row must say so");
});

test("page console errors reach the editor without swallowing the page's own", () => {
  const { sandbox, posted } = loadOverlay();
  // What an auth SDK refusing a domain actually looks like from in here.
  sandbox.console.error("FirebaseError:", { code: "auth/unauthorized-domain" });

  const log = posted.filter((m) => m.type === "page-log").pop();
  assert.ok(log, "runtime errors must reach the editor's console");
  assert.equal(log.level, "error");
  assert.match(log.text, /FirebaseError/);
  assert.match(log.text, /auth\/unauthorized-domain/, "objects must serialize");

  // The app's own console still fires — forwarding observes, never replaces.
  assert.deepEqual(sandbox.consoleCalls.pop()[0], "error");

  // An unserializable argument must not throw out of the page's console call.
  const cyclic = {};
  cyclic.self = cyclic;
  sandbox.console.warn(cyclic);
  assert.equal(
    posted.filter((m) => m.type === "page-log").pop().level,
    "warn",
    "a cyclic argument must still produce a line",
  );
});

test("reload refreshes in place, but reloads AT a path when given one", () => {
  // Plain reload (after an AI chat edit): refresh wherever the frame sits.
  const plain = loadOverlay();
  plain.send({ type: "reload" });
  assert.equal(plain.sandbox.location.reloaded, 1);
  assert.equal(plain.sandbox.location.replaced, null);

  // A frame the app bounced to /login: enabling a mock session must bring it
  // back to its pinned route, not refresh the login page it landed on.
  const bounced = loadOverlay();
  bounced.sandbox.location.pathname = "/login";
  bounced.send({ type: "reload", path: "/settings" });
  assert.equal(bounced.sandbox.location.replaced, "/settings");
  assert.equal(bounced.sandbox.location.reloaded, 0, "must be one load, not two");

  // Already on the pinned route: a plain refresh is enough (and keeps the
  // frame's history from growing an entry per save).
  const athome = loadOverlay();
  athome.send({ type: "reload", path: "/" });
  assert.equal(athome.sandbox.location.reloaded, 1);
  assert.equal(athome.sandbox.location.replaced, null);
});

test("hover-id draws and clears the hover box without a pointer", () => {
  const { send, nodes } = loadOverlay();
  const chrome = nodes.html.children.filter((c) => c.hasAttribute("data-dedup-ui"));
  send({ type: "hover-id", id: "src/App.tsx@1" });
  assert.ok(
    chrome.some((c) => c.style.display === "block"),
    "no hover chrome shown",
  );
  send({ type: "hover-id", id: null });
  assert.ok(
    !chrome.some((c) => c.style.display === "block"),
    "hover chrome not cleared",
  );
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
