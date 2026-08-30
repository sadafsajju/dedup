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
    // Element-level listeners are recorded, not swallowed: the resize grips
    // are the first chrome to attach their own, and a test has to be able to
    // fire one. Everything else in the overlay listens on document/window.
    listeners: {},
    addEventListener(type, fn) {
      (node.listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = node.listeners[type];
      if (list) node.listeners[type] = list.filter((f) => f !== fn);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
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
    // Enough of a clone + serializer for the copy path, which hands the
    // editor a subtree's markup to preview a paste with.
    get attributes() {
      return Object.keys(node.attrs).map((name) => ({ name, value: node.attrs[name] }));
    },
    cloneNode() {
      const copy = makeEl(tag, node.attrs);
      copy.textContent = node.textContent;
      for (const child of node.children) copy.appendChild(child.cloneNode(true));
      return copy;
    },
    get outerHTML() {
      const attrs = Object.entries(node.attrs)
        .map(([k, v]) => ` ${k}="${v}"`)
        .join("");
      const name = tag.toLowerCase();
      const inner =
        node.children.length > 0
          ? node.children.map((c) => c.outerHTML).join("")
          : node.textContent;
      return `<${name}${attrs}>${inner}</${name}>`;
    },
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

/**
 * A stand-in for CSSStyleDeclaration.
 *
 * A Proxy, because the previous plain object kept direct assignment
 * (`style.width = "60px"`) and `removeProperty("width")` in two different
 * places — so a removal silently did nothing and any test asserting that a
 * style was cleared would have passed no matter what the overlay did. Real
 * style objects back both with the same storage; so does this.
 */
function makeStyle() {
  const store = {};
  const api = {
    setProperty: (k, v) => void (store[k] = String(v)),
    removeProperty: (k) => void delete store[k],
    getPropertyValue: (k) => store[k] ?? "",
  };
  return new Proxy(store, {
    get: (target, key) =>
      key in api ? api[key] : typeof key === "string" ? (target[key] ?? "") : undefined,
    set: (target, key, value) => {
      target[key] = String(value);
      return true;
    },
    deleteProperty: (target, key) => delete target[key],
    has: (target, key) => key in api || key in target,
  });
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
      // The frame's own flags live here (the hold, the offline cut) — the
      // overlay has to carry them across any navigation it drives.
      search: "",
      get href() {
        return `http://localhost:5173${sandbox.location.pathname}${sandbox.location.search}`;
      },
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
  // The overlay asks `e.target instanceof HTMLInputElement` before forwarding
  // a keystroke as an editor shortcut. A real page has these constructors; the
  // stub's plain-object nodes are never instances of them, which is the right
  // answer for every node this harness builds.
  // A fresh vm realm gets the JS built-ins but none of Node's globals, and
  // URL/URLSearchParams are Node's rather than the language's. Every browser
  // the overlay runs in has them, so the stub does too.
  Object.assign(sandbox, {
    URL,
    URLSearchParams,
    PopStateEvent: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLElement: class {},
  });

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

test("two inserts at one anchor preview in the order the save will write", () => {
  const { send, nodes } = loadOverlay();
  // What pasting twice stages: two inserts placed `after` the same element.
  // The write-back appends them one behind the other, so the preview has to
  // as well — replayed naively each new node would push the previous one down.
  send({
    type: "stage",
    classes: {},
    texts: {},
    structural: [
      { op: "insert", id: "src/App.tsx@1", pendingId: "pending:a", position: "after", html: "<p>one</p>" },
      { op: "insert", id: "src/App.tsx@1", pendingId: "pending:b", position: "after", html: "<p>two</p>" },
    ],
  });
  assert.deepEqual(
    nodes.root.children.map((c) => c.getAttribute("data-dedup-id")),
    ["src/App.tsx@1", "pending:a", "pending:b", "src/App.tsx@2"],
  );
});

test("the AI-working grid covers the element, and stops when told to", () => {
  const { sandbox, send, nodes } = loadOverlay();
  // The stub's elements are 20×10, which correctly collapses to a single
  // square — a tiny button cannot hold a grid. A section-sized one can.
  nodes.title.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, width: 320, height: 200,
  });
  const busy = () =>
    nodes.html.children.find((c) => c.hasAttribute("data-dedup-busy"));
  assert.ok(busy(), "the busy layer is mounted with the rest of the chrome");
  assert.equal(busy().style.display, "none", "and is invisible until asked for");

  send({ type: "set-busy", id: "src/App.tsx@1" });
  assert.equal(busy().style.display, "grid");
  assert.ok(busy().children.length > 1, "squares are laid out over the element");
  // Neighbours are a beat apart, so the wave travels rather than blinking.
  const delays = busy().children.map((c) => c.style.animationDelay);
  assert.ok(new Set(delays).size > 1, `every square shares a delay: ${delays[0]}`);

  // An element the frame doesn't have is not an error — every artboard hears
  // the same broadcast, and only the one holding it draws anything.
  send({ type: "set-busy", id: "src/Other.tsx@9" });
  assert.equal(busy().style.display, "none");

  send({ type: "set-busy", id: "src/App.tsx@1" });
  assert.equal(busy().style.display, "grid");
  send({ type: "set-busy", id: null });
  assert.equal(busy().style.display, "none", "the turn ended; so does the grid");
  assert.equal(sandbox.consoleCalls.length, 0);
});

test("copy-element reports the subtree's markup with dedup's stamps stripped", () => {
  const { posted, send, nodes } = loadOverlay();
  send({ type: "copy-element", id: "src/App.tsx@0" });
  const answer = posted.find((m) => m.type === "element-html");
  assert.ok(answer, "no element-html reported");
  assert.equal(answer.id, "src/App.tsx@0");

  const html = answer.html;
  // The page's own markup survives — it is what the paste previews as.
  assert.match(html, /^<div>/);
  assert.match(html, /<h1 class="text-lg">Hello<\/h1>/);
  // dedup's own stamps do not. `data-dedup-id` above all: left in, the pasted
  // copy would answer to the same id as the element it came from, and every
  // lookup in the overlay would start hitting whichever the DOM returned
  // first — select, hover, staged class patches, the layer tree.
  assert.doesNotMatch(html, /data-dedup-/, html);

  // Reporting is by id and silent when a frame doesn't hold it: every
  // artboard hears the broadcast, and only the one with the element answers.
  const before = posted.length;
  send({ type: "copy-element", id: "src/Other.tsx@9" });
  assert.equal(posted.length, before, "a frame without the element stays quiet");
  assert.ok(nodes.root.getAttribute("data-dedup-id"), "the original keeps its id");
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

test("the overlay reports when a caret lands on, and leaves, the canvas", () => {
  // The editor shows a text mode while one is on screen, and it cannot see the
  // caret: only this side knows, because Escape, Enter, a click elsewhere and
  // a re-render all end an edit without the editor being asked.
  const { posted, fire, send, nodes } = loadOverlay();
  const editing = () => posted.filter((m) => m.type === "text-editing");

  send({ type: "text-edit-begin", id: "src/App.tsx@1" });
  assert.equal(editing().pop()?.id, "src/App.tsx@1");

  // A repeat begin on the element already being typed into is a no-op: ending
  // and restarting would reselect all its text and lose the caret position.
  const before = editing().length;
  send({ type: "text-edit-begin", id: "src/App.tsx@1" });
  assert.equal(editing().length, before, "a repeat begin must not restart the edit");

  fire("keydown", { target: nodes.title, key: "Enter", shiftKey: false, preventDefault() {} });
  assert.equal(editing().pop()?.id, null);
  assert.equal(nodes.title.getAttribute("contenteditable"), null);
});

test("the editor can take the caret back off the canvas", () => {
  // Leaving the text tool: a caret still blinking in a page the user is now
  // panning would be a lie about the mode.
  const { posted, send, nodes } = loadOverlay();
  send({ type: "text-edit-begin", id: "src/App.tsx@1" });
  assert.equal(nodes.title.getAttribute("contenteditable"), "plaintext-only");
  send({ type: "text-edit-end" });
  assert.equal(nodes.title.getAttribute("contenteditable"), null);
  assert.equal(posted.filter((m) => m.type === "text-editing").pop()?.id, null);
});

test("the text tool's shortcut is forwarded, but never while typing", () => {
  const { posted, fire, send, nodes } = loadOverlay();
  const keys = () => posted.filter((m) => m.type === "key").map((m) => m.key);

  fire("keydown", { target: nodes.body, key: "t", preventDefault() {} });
  assert.ok(keys().includes("t"), "T reaches the editor's one keyboard handler");

  // With a caret in an element, letters are text — forwarding them would let
  // typing "the" switch tools and delete the selection.
  send({ type: "text-edit-begin", id: "src/App.tsx@1" });
  const before = keys().length;
  for (const key of ["t", "v", "b", "h", "Backspace"]) {
    fire("keydown", { target: nodes.title, key, preventDefault() {} });
  }
  assert.equal(keys().length, before, "typing must not reach the tool shortcuts");
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

test("a driven navigation keeps the frame's dedup flags", () => {
  // The flags that change how a frame behaves ride in its query string,
  // because they must reach the page before the app boots. Sending the frame
  // to a bare path would drop them — an offline artboard would quietly come
  // back online and the editor, drawing its label from its own state, would
  // still say "offline". Matched by prefix, so a new flag needs no change here.
  const bounced = loadOverlay();
  bounced.sandbox.location.pathname = "/login";
  bounced.sandbox.location.search = "?__dedup_offline=1&__dedup_hold=1&tab=two";
  bounced.send({ type: "reload", path: "/settings" });
  assert.equal(
    bounced.sandbox.location.replaced,
    "/settings?__dedup_offline=1&__dedup_hold=1",
    "the app's own query does not follow, but dedup's flags do",
  );

  // A frame with no flags navigates to exactly what it was given.
  const plain = loadOverlay();
  plain.sandbox.location.pathname = "/login";
  plain.send({ type: "reload", path: "/settings" });
  assert.equal(plain.sandbox.location.replaced, "/settings");
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

// --- resize grips -----------------------------------------------------------
//
// The gesture itself needs real hit-testing and stays manual, but three things
// about the grips are pure state and belong here: that they never appear on an
// element the write-back would refuse, that they track the canvas zoom (a 4px
// target at 50% is not a target), and that they are the one piece of chrome
// that must be clickable.

const handlesOf = (nodes) =>
  nodes.html.children.filter((c) => c.hasAttribute("data-dedup-handle"));

const shownHandles = (nodes) =>
  handlesOf(nodes).filter((h) => h.style.display === "block");

test("there are eight grips, and they are the only clickable chrome", () => {
  const { nodes } = loadOverlay();
  const handles = handlesOf(nodes);
  assert.equal(handles.length, 8);
  assert.deepEqual(
    handles.map((h) => h.getAttribute("data-dedup-handle")).sort(),
    ["e", "n", "ne", "nw", "s", "se", "sw", "w"],
  );
  // Every other overlay surface must stay transparent to elementFromPoint.
  assert.ok(
    handles.every((h) => h.style.pointerEvents === "auto"),
    "a grip you cannot grab is not a grip",
  );
  const others = nodes.html.children.filter(
    (c) => c.hasAttribute("data-dedup-ui") && !c.hasAttribute("data-dedup-handle"),
  );
  assert.ok(
    others.every((c) => c.style.pointerEvents !== "auto"),
    "only the grips may capture the pointer",
  );
});

test("no grips until the editor says the element's classes are editable", () => {
  const { send, nodes } = loadOverlay();
  send({ type: "select-id", id: "src/App.tsx@1" });
  assert.equal(
    shownHandles(nodes).length,
    0,
    "a selection alone must not offer resize — className may be dynamic",
  );

  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });
  assert.equal(shownHandles(nodes).length, 8, "grips should be up");

  // The write-back's verdict changing is the same as it never being given.
  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: false });
  assert.equal(shownHandles(nodes).length, 0, "grips must retract");
});

test("grips belong to the selected element, not a stale one", () => {
  const { send, nodes } = loadOverlay();
  send({ type: "select-id", id: "src/App.tsx@1" });
  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });
  assert.equal(shownHandles(nodes).length, 8);

  // Selecting elsewhere leaves the permission pointing at the old id.
  send({ type: "select-id", id: "src/App.tsx@2" });
  assert.equal(
    shownHandles(nodes).length,
    0,
    "grips must not linger on a different element than the one they were granted for",
  );
});

test("grips keep a constant on-screen size as the canvas zooms", () => {
  const { send, nodes } = loadOverlay();
  send({ type: "select-id", id: "src/App.tsx@1" });
  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });

  const sizeAt = (zoom) => {
    send({ type: "set-zoom", zoom });
    return parseFloat(shownHandles(nodes)[0].style.width);
  };
  const full = sizeAt(1);
  const half = sizeAt(0.5);
  const double = sizeAt(2);
  assert.ok(full > 0, "grips should have a size");
  assert.ok(
    Math.abs(half - full * 2) < 0.01,
    `at 50% zoom a grip must be drawn twice as large in page units (got ${half} vs ${full})`,
  );
  assert.ok(
    Math.abs(double - full / 2) < 0.01,
    `at 200% it must be half (got ${double} vs ${full})`,
  );
  // A nonsense zoom must not collapse the grips to nothing.
  send({ type: "set-zoom", zoom: 0 });
  assert.equal(parseFloat(shownHandles(nodes)[0].style.width), full);
});

test("dragging a grip reports the dragged size, and never drops the last move", () => {
  const { send, fire, posted, nodes } = loadOverlay();
  send({ type: "select-id", id: "src/App.tsx@1" });
  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });
  send({ type: "set-zoom", zoom: 1 });

  // The stub's rects are 100×20 at (0,0) — see makeEl.
  const start = nodes.title.getBoundingClientRect();
  const se = nodes.html.children.find(
    (c) => c.getAttribute("data-dedup-handle") === "se",
  );
  const ev = (x, y) => ({
    button: 0,
    clientX: x,
    clientY: y,
    target: se,
    pointerId: 1,
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  });

  se.listeners.pointerdown.forEach((fn) => fn(ev(start.width, start.height)));
  assert.equal(
    posted.filter((m) => m.type === "resize-start").length,
    1,
    "the gesture should announce itself",
  );

  // Drag the south-east grip 40px right and 10px down.
  fire("pointermove", ev(start.width + 40, start.height + 10));
  fire("pointerup", ev(start.width + 40, start.height + 10));

  const sizes = posted.filter((m) => m.type === "resize");
  assert.ok(sizes.length >= 1, "no size was reported");
  const last = sizes[sizes.length - 1];
  assert.equal(last.width, start.width + 40, "width should follow the pointer");
  assert.equal(last.height, start.height + 10, "height should follow too");
  assert.ok(last.group, "every report needs a group id to fold undo into one step");
  assert.ok(
    sizes.every((m) => m.group === last.group),
    "one gesture is one undo step",
  );
  assert.equal(
    posted.filter((m) => m.type === "resize-end").length,
    1,
    "the gesture should end exactly once",
  );

  // The inline size used for live feedback must be handed back afterwards, or
  // it would mask whatever the staged class actually resolves to.
  assert.equal(nodes.title.style.width, "", "inline width must be released");
  assert.equal(nodes.title.style.height, "", "inline height must be released");
});

test("a side grip never reports the axis it did not drag", () => {
  const { send, fire, posted, nodes } = loadOverlay();
  send({ type: "select-id", id: "src/App.tsx@1" });
  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });

  const start = nodes.title.getBoundingClientRect();
  const east = nodes.html.children.find(
    (c) => c.getAttribute("data-dedup-handle") === "e",
  );
  const ev = (x, y) => ({
    button: 0, clientX: x, clientY: y, target: east, pointerId: 1,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
  });
  east.listeners.pointerdown.forEach((fn) => fn(ev(start.width, 10)));
  // Move diagonally: the vertical component must be ignored entirely.
  fire("pointermove", ev(start.width + 25, 90));
  fire("pointerup", ev(start.width + 25, 90));

  const last = posted.filter((m) => m.type === "resize").pop();
  assert.equal(last.width, start.width + 25);
  assert.equal(
    last.height,
    null,
    "a side grip must leave the other axis unset — pinning a content-sized height is a bug the user can't see until the content changes",
  );
});

test("a grip cannot drag an element smaller than nothing", () => {
  const { send, fire, posted, nodes } = loadOverlay();
  send({ type: "select-id", id: "src/App.tsx@1" });
  send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });

  const start = nodes.title.getBoundingClientRect();
  const se = nodes.html.children.find(
    (c) => c.getAttribute("data-dedup-handle") === "se",
  );
  const ev = (x, y) => ({
    button: 0, clientX: x, clientY: y, target: se, pointerId: 1,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
  });
  se.listeners.pointerdown.forEach((fn) => fn(ev(start.width, start.height)));
  fire("pointermove", ev(-9999, -9999));
  fire("pointerup", ev(-9999, -9999));

  const last = posted.filter((m) => m.type === "resize").pop();
  assert.ok(last.width > 0 && last.height > 0, `got ${last.width}x${last.height}`);
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
