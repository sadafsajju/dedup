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
    // Hit testing: the drag gestures ask what is under the pointer, and the
    // stub has no layout to answer from. A test says so directly.
    elementFromPoint: () => documentStub.hitEl ?? null,
    hitEl: null,
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
    // Layout the stub cannot compute, declared per node by whichever test
    // cares (`node.computed = { display: "flex" }`).
    getComputedStyle: (el) => ({
      overflowY: "visible",
      overflowX: "visible",
      ...(el?.computed ?? {}),
    }),
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

  /** What `document.elementFromPoint` should answer for the next gesture. */
  const hit = (el) => void (documentStub.hitEl = el);

  return {
    sandbox,
    posted,
    fire,
    send,
    hit,
    nodes: { html, body, root, title, item },
  };
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


// --- drag to re-parent: the grab cursor and the drop ghost -------------------
//
// The gesture used to be drawn as a 2px line, which says where the insertion
// point is but not what lands there — and nothing at all said the element
// could be picked up in the first place. Both answers are drawn now, and both
// are easy to lose: the cursor is a stylesheet that has to be cleared on every
// way a drag can end, and the ghost is geometry with a direction to get wrong.

/** Give a stub node a rect, since the stub has no layout of its own. */
const rect = (el, x, y, width, height) => {
  el.getBoundingClientRect = () => ({ x, y, top: y, left: x, width, height });
};

const chrome = (nodes, pred) => nodes.html.children.filter(pred);
const ghostOf = (nodes) =>
  chrome(nodes, (c) => c.style.boxShadow && c.style.position === "fixed")[0];
const cursorSheetOf = (nodes) =>
  chrome(nodes, (c) => c.tagName === "STYLE").map((c) => c.textContent);
const cursorRule = (nodes) =>
  cursorSheetOf(nodes).find((t) => t.includes("cursor")) ?? "";

const ev = (x, y) => ({
  button: 0,
  clientX: x,
  clientY: y,
  target: null,
  preventDefault() {},
  stopPropagation() {},
  stopImmediatePropagation() {},
});

/** Arm dragging, pick `from` up and move the pointer to (x, y) over `over`.
 *  Selected first: only the selection can be picked up — a drag anywhere
 *  else in the select tool draws a marquee (see the marquee tests). */
function beginDrag({ send, fire, hit }, from, over, x, y) {
  send({ type: "set-edit-mode", drag: true });
  send({ type: "select-id", id: from.getAttribute("data-dedup-id") });
  hit(over);
  fire("pointerdown", { ...ev(0, 0), target: from });
  fire("pointermove", { ...ev(x, y), target: over });
}

test("hovering something draggable offers a grab cursor — and only there", () => {
  const { send, fire, nodes } = loadOverlay();
  fire("mousemove", { target: nodes.title });
  assert.equal(cursorRule(nodes), "", "no cursor until dragging is armed");

  send({ type: "set-edit-mode", drag: true });
  fire("mousemove", { target: nodes.title });
  assert.equal(
    cursorRule(nodes),
    "",
    "armed but not selected: a drag here draws a marquee, so no grab is promised",
  );

  send({ type: "select-id", id: "src/App.tsx@1" });
  fire("mousemove", { target: nodes.title });
  assert.match(cursorRule(nodes), /cursor:grab/);
  assert.match(
    cursorRule(nodes),
    /src\/App\.tsx@1/,
    "the rule is keyed by dedup id, so nothing is written into the page",
  );

  // Off the selection there is nothing to pick up.
  fire("mousemove", { target: nodes.item });
  assert.equal(cursorRule(nodes), "");

  // The tagger's own verdict decides: the list item is dynamic, so a drag
  // would be refused — promising one with a cursor is worse than saying no.
  send({ type: "select-id", id: "src/App.tsx@2" });
  fire("mousemove", { target: nodes.item });
  assert.equal(cursorRule(nodes), "");

  send({ type: "select-id", id: "src/App.tsx@1" });
  fire("mousemove", { target: nodes.title });
  assert.match(cursorRule(nodes), /cursor:grab/);
  send({ type: "set-edit-mode", drag: false });
  assert.equal(
    cursorRule(nodes),
    "",
    "disarming the gesture must take its cursor with it",
  );
});

test("a drag draws the element's footprint where the release would put it", () => {
  const h = loadOverlay();
  const { nodes } = h;
  rect(nodes.title, 0, 0, 100, 40); // what is being dragged
  rect(nodes.item, 0, 100, 300, 60); // what it is being dropped near

  // Low in the target: after it, so the ghost sits below.
  beginDrag(h, nodes.title, nodes.item, 10, 155);
  const ghost = ghostOf(nodes);
  assert.equal(ghost.style.display, "block", "no ghost drawn");
  assert.equal(ghost.style.top, "160px", "after → below the target");
  assert.equal(ghost.style.left, "0px");
  assert.equal(ghost.style.height, "40px", "the element's own height");
  assert.equal(ghost.style.width, "100px");
  assert.match(cursorRule(nodes), /cursor:grabbing/);
  assert.equal(
    nodes.title.style.opacity,
    "0.4",
    "the element in flight fades, so the ghost is the one going somewhere",
  );

  // High in the target: before it, so the ghost sits above.
  h.fire("pointermove", { ...ev(10, 105), target: nodes.item });
  assert.equal(ghost.style.top, "60px", "before → above the target");

  // A ghost wider than the column it is landing in would be a lie about the
  // layout: the cross axis belongs to the container.
  rect(nodes.title, 0, 0, 900, 40);
  h.fire("pointermove", { ...ev(10, 155), target: nodes.item });
  assert.equal(ghost.style.width, "300px");
});

test("in a row, the ghost lands beside the target rather than under it", () => {
  const h = loadOverlay();
  const { nodes } = h;
  nodes.root.computed = { display: "flex", flexDirection: "row" };
  rect(nodes.title, 0, 0, 100, 40);
  rect(nodes.item, 200, 0, 60, 40);

  beginDrag(h, nodes.title, nodes.item, 255, 30);
  const ghost = ghostOf(nodes);
  assert.equal(ghost.style.left, "260px", "after → to the right of the target");
  assert.equal(ghost.style.top, "0px");

  // row-reverse: the pointer at the right edge is still the right edge — the
  // DOM's `before` there — so the ghost stays where the pointer is.
  nodes.root.computed = { display: "flex", flexDirection: "row-reverse" };
  h.fire("pointermove", { ...ev(255, 30), target: nodes.item });
  assert.equal(ghost.style.left, "260px");
  // …and the left edge is the DOM's `after`, rendered on the left.
  h.fire("pointermove", { ...ev(205, 30), target: nodes.item });
  assert.equal(ghost.style.left, "100px");
});

/** Ask the overlay where a drop at (x, y) would land, the way the editor
 * does for a drag coming from elsewhere: the same `dropTargetAt` an in-page
 * drag uses, without having to stage a whole gesture per point. */
const landing = (h, x, y) => {
  h.send({ type: "probe-drop", x, y, seq: x * 1000 + y });
  return h.posted.filter((m) => m.type === "probe-result").pop().position;
};
const shownLine = (nodes) =>
  chrome(nodes, (c) => c.style.display === "block" && c.style.width === "2px")[0];

test("in a row, the side of the target decides before/after — not its height", () => {
  // The bug this pins: a row of chips, dragged sideways, nested the chip
  // inside its neighbour, because the before/after bands were read off y and
  // a sideways drag spends its whole life in the middle band.
  const h = loadOverlay();
  const { nodes } = h;
  nodes.root.computed = { display: "flex", flexDirection: "row" };
  rect(nodes.item, 200, 0, 60, 40);
  h.hit(nodes.item);

  assert.equal(landing(h, 205, 20), "before", "left edge, half-way down");
  assert.equal(landing(h, 255, 20), "after", "right edge, half-way down");
  assert.equal(landing(h, 230, 2), "inside", "the middle of a container is still inside, at any height");

  landing(h, 205, 20);
  const line = shownLine(nodes);
  assert.ok(line, "the insertion point is a vertical line, beside the target");
  assert.equal(line.style.left, "199px");
  assert.equal(line.style.top, "0px");
  assert.equal(line.style.height, "40px");

  landing(h, 255, 20);
  assert.equal(shownLine(nodes).style.left, "259px", "after → on the right edge");

  // row-reverse: the DOM's `before` renders on the right, so the right edge
  // means before — the element goes to whichever side the pointer is on.
  nodes.root.computed = { display: "flex", flexDirection: "row-reverse" };
  assert.equal(landing(h, 255, 20), "before");
  assert.equal(shownLine(nodes).style.left, "259px", "drawn where the pointer is");
  assert.equal(landing(h, 205, 20), "after");
  assert.equal(shownLine(nodes).style.left, "199px");
});

test("in a column, height still decides, and the line runs across the target", () => {
  const h = loadOverlay();
  const { nodes } = h;
  rect(nodes.item, 0, 100, 300, 60);
  h.hit(nodes.item);

  assert.equal(landing(h, 10, 105), "before");
  assert.equal(landing(h, 10, 130), "inside");
  assert.equal(landing(h, 290, 155), "after", "x plays no part outside a row");

  landing(h, 10, 105);
  const line = chrome(nodes, (c) => c.style.display === "block" && c.style.height === "2px")[0];
  assert.ok(line, "a horizontal line");
  assert.equal(line.style.width, "300px");
  assert.equal(line.style.top, "99px");
});

test("dropping inside a container previews the element as its last child", () => {
  const h = loadOverlay();
  const { nodes } = h;
  rect(nodes.title, 0, 0, 100, 40);
  rect(nodes.item, 0, 100, 300, 200);

  // The middle of the target is "inside" — where the write-back appends.
  beginDrag(h, nodes.title, nodes.item, 10, 200);
  const ghost = ghostOf(nodes);
  assert.equal(ghost.style.display, "block");
  assert.equal(ghost.style.top, "260px", "inside → last child, at the bottom");
});

// --- dragging off the page ---------------------------------------------------
//
// An element can leave its artboard: onto the empty canvas (parked) or into
// another artboard. Only this frame hears the pointer, so it must keep hearing
// it past its own edge (pointer capture) and say where it is — and a release
// out there must never also be read as an in-page drop.

test("a drag keeps the pointer past the frame's edge and says where it went", () => {
  const h = loadOverlay();
  const { nodes, posted } = h;
  rect(nodes.title, 0, 0, 100, 40);
  rect(nodes.item, 0, 100, 300, 60);
  let captured = null;
  nodes.html.setPointerCapture = (id) => void (captured = id);

  h.send({ type: "set-edit-mode", drag: true });
  h.send({ type: "select-id", id: "src/App.tsx@1" });
  h.hit(nodes.item);
  h.fire("pointerdown", { ...ev(0, 0), pointerId: 7, target: nodes.title });
  h.fire("pointermove", { ...ev(10, 155), pointerId: 7, target: nodes.item });
  assert.equal(captured, 7, "the drag captures its pointer once it starts");

  // Off the right edge of a 1200px-wide page.
  h.fire("pointermove", { ...ev(1350, 155), pointerId: 7, target: nodes.item });
  const out = posted.filter((m) => m.type === "drag-outside").pop();
  assert.deepEqual([out.x, out.y], [1350, 155], "frame-local coordinates");
  assert.equal(out.id, "src/App.tsx@1");
  assert.equal(out.label, "App · h1", "named, so the editor's ghost can say what is moving");
  assert.equal(ghostOf(nodes).style.display, "none", "no in-page slot while outside");

  // Back over the page: the editor is told the pointer is home again.
  h.fire("pointermove", { ...ev(10, 155), pointerId: 7, target: nodes.item });
  const back = posted.filter((m) => m.type === "drag-outside").pop();
  assert.equal(back.x, null);
  assert.equal(ghostOf(nodes).style.display, "block");
});

test("released off the page, it is a drop-outside and never an in-page drop", () => {
  const h = loadOverlay();
  const { nodes, posted } = h;
  rect(nodes.title, 0, 0, 100, 40);
  rect(nodes.item, 0, 100, 300, 60);
  beginDrag(h, nodes.title, nodes.item, 10, 155);
  h.fire("pointermove", { ...ev(-40, 300), target: nodes.item });
  h.fire("pointerup", { ...ev(-40, 300), target: nodes.item });

  const drop = posted.find((m) => m.type === "drop-outside");
  assert.ok(drop, "a drop-outside was posted");
  assert.equal(drop.id, "src/App.tsx@1");
  assert.deepEqual([drop.x, drop.y], [-40, 300]);
  assert.equal(drop.element.dedupId, "src/App.tsx@1", "the element travels with it");
  assert.equal(posted.filter((m) => m.type === "drop").length, 0, "not also a move");
  assert.ok(posted.some((m) => m.type === "drag-end"), "the drag still ends");
  assert.notEqual(nodes.title.style.opacity, "0.4", "the faded element is restored");
});

test("the editor can ask where a drag from elsewhere would land, and take it back", () => {
  const h = loadOverlay();
  const { nodes, posted } = h;
  rect(nodes.title, 0, 0, 300, 60);
  const shown = () => chrome(nodes, (c) => c.style.display === "block").length;
  const before = shown();

  h.hit(nodes.title);
  h.send({ type: "probe-drop", x: 10, y: 55, seq: 3 });
  const answer = posted.filter((m) => m.type === "probe-result").pop();
  assert.equal(answer.seq, 3, "the answer names the question it answers");
  assert.equal(answer.id, "src/App.tsx@1");
  assert.equal(answer.position, "after");
  assert.ok(shown() > before, "the slot is drawn on this page, like an in-page drag");

  h.send({ type: "probe-clear" });
  assert.equal(shown(), before, "and taken back off it");

  // Nothing under the point: an honest null, not a guess.
  h.hit(null);
  h.send({ type: "probe-drop", x: 5000, y: 5000, seq: 4 });
  const none = posted.filter((m) => m.type === "probe-result").pop();
  assert.equal(none.seq, 4);
  assert.equal(none.id, null);
  assert.equal(none.position, null);
});

test("every way a drag can end puts the cursor and the ghost away", () => {
  const ends = {
    "the pointer coming up": (h, over) =>
      h.fire("pointerup", { ...ev(10, 155), target: over }),
    Escape: (h) => h.fire("keydown", { key: "Escape", ...ev(0, 0) }),
    "the frame losing focus": (h) => h.fire("blur", {}),
  };
  for (const [how, end] of Object.entries(ends)) {
    const h = loadOverlay();
    const { nodes } = h;
    rect(nodes.title, 0, 0, 100, 40);
    rect(nodes.item, 0, 100, 300, 60);
    beginDrag(h, nodes.title, nodes.item, 10, 155);
    assert.equal(ghostOf(nodes).style.display, "block", how);

    end(h, nodes.item);
    assert.equal(ghostOf(nodes).style.display, "none", how);
    assert.equal(cursorRule(nodes), "", how);
    assert.equal(
      nodes.title.style.opacity,
      "",
      `${how}: the element must be handed back exactly as it was found`,
    );
    assert.equal(h.sandbox.consoleCalls.length, 0, how);
  }
});

test("a drop still reports the move it previewed", () => {
  const h = loadOverlay();
  const { nodes, posted } = h;
  rect(nodes.title, 0, 0, 100, 40);
  rect(nodes.item, 0, 100, 300, 60);
  beginDrag(h, nodes.title, nodes.item, 10, 155);
  h.fire("pointerup", { ...ev(10, 155), target: nodes.item });

  const drop = posted.find((m) => m.type === "drop");
  assert.ok(drop, "no drop reported");
  assert.equal(drop.id, "src/App.tsx@1");
  assert.equal(drop.to, "src/App.tsx@2");
  assert.equal(drop.position, "after");
});

// --- marquee and multi-selection ---------------------------------------------
//
// In the select tool a drag is one of two gestures, and which one is decided
// at the press: inside the single selected element it picks that element up;
// anywhere else it draws a marquee. A page has no empty space to start a
// marquee from — every pixel is inside some element — so "drag anything to
// move it" and "drag across to select" cannot both be the unselected default.

/** A page with real geometry: the root around a title and an item. */
function loadPage() {
  const h = loadOverlay();
  const { nodes } = h;
  rect(nodes.root, 0, 0, 1000, 600);
  rect(nodes.title, 50, 50, 300, 40);
  rect(nodes.item, 50, 150, 300, 40);
  h.send({ type: "set-edit-mode", drag: true });
  return h;
}

const marqueeBoxOf = (nodes) =>
  chrome(nodes, (c) => c.style.background === "rgba(76,127,255,0.10)")[0];
/** Outlines drawn for a multi-selection (the pool grown in paintMulti). */
const outlinesOf = (nodes) =>
  chrome(nodes, (c) => c.hasAttribute("data-dedup-multi") && c.style.display === "block");
const types = (posted) => posted.map((m) => m.type);
const idsOf = (msg) => Array.from(msg.payloads, (p) => p.dedupId);

/** Press at (x0,y0) on `from`, drag to (x1,y1). No release. */
function drawMarquee(h, from, x0, y0, x1, y1, extra = {}) {
  h.fire("pointerdown", { ...ev(x0, y0), pointerId: 3, target: from, ...extra });
  h.fire("pointermove", { ...ev(x1, y1), pointerId: 3, target: from, ...extra });
}

test("a drag on an unselected element draws a marquee, not a re-parent drag", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  let captured = null;
  nodes.html.setPointerCapture = (id) => void (captured = id);

  // A press alone is not a marquee yet: a click must stay a click.
  h.fire("pointerdown", { ...ev(20, 20), pointerId: 3, target: nodes.title });
  h.fire("pointermove", { ...ev(21, 21), pointerId: 3, target: nodes.title });
  assert.equal(marqueeBoxOf(nodes).style.display, "none", "under the threshold");

  h.fire("pointermove", { ...ev(200, 120), pointerId: 3, target: nodes.title });
  const box = marqueeBoxOf(nodes);
  assert.equal(box.style.display, "block");
  assert.deepEqual(
    [box.style.left, box.style.top, box.style.width, box.style.height],
    ["20px", "20px", "180px", "100px"],
  );
  assert.equal(captured, 3, "captured, so it survives leaving the frame");
  assert.equal(types(posted).includes("drag-start"), false, "nothing was picked up");
  assert.equal(ghostOf(nodes).style.display, "none");
  assert.equal(nodes.title.style.opacity, "", "nothing fades");
  assert.equal(cursorRule(nodes), "");
});

test("the marquee is drawn whichever way it is dragged, and only on the page", () => {
  const h = loadPage();
  const { nodes } = h;
  // Up and to the left, past the frame's top-left corner.
  drawMarquee(h, nodes.root, 400, 300, -50, -80);
  const box = marqueeBoxOf(nodes);
  assert.deepEqual(
    [box.style.left, box.style.top, box.style.width, box.style.height],
    ["0px", "0px", "400px", "300px"],
  );
});

test("releasing a marquee selects what it touched — outermost, not the container", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  // Starts in the root's padding and crosses both children. The root encloses
  // the marquee, so it is looked through rather than selected.
  drawMarquee(h, nodes.root, 20, 20, 200, 180);
  assert.equal(outlinesOf(nodes).length, 2, "what it would select is shown while dragging");
  h.fire("pointerup", { ...ev(200, 180), pointerId: 3, target: nodes.root });

  const many = posted.filter((m) => m.type === "selected-many").pop();
  assert.ok(many, `no selected-many in ${JSON.stringify(types(posted))}`);
  assert.deepEqual(idsOf(many), ["src/App.tsx@1", "src/App.tsx@2"]);
  assert.ok(many.payloads[0].ancestry, "each element travels with its full payload");
  assert.equal(marqueeBoxOf(nodes).style.display, "none");
  assert.equal(outlinesOf(nodes).length, 2, "every selected element keeps an outline");
});

test("a marquee over one element is an ordinary selection", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  drawMarquee(h, nodes.root, 20, 20, 200, 80);
  h.fire("pointerup", { ...ev(200, 80), pointerId: 3, target: nodes.root });
  const selected = posted.filter((m) => m.type === "selected").pop();
  assert.equal(selected.payload.dedupId, "src/App.tsx@1");
  assert.equal(types(posted).includes("selected-many"), false);
  assert.equal(outlinesOf(nodes).length, 0, "one element wears the single selection box");
});

test("a marquee that catches nothing clears the selection", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  h.send({ type: "select-ids", ids: ["src/App.tsx@1", "src/App.tsx@2"] });
  assert.equal(outlinesOf(nodes).length, 2);
  drawMarquee(h, nodes.root, 500, 300, 700, 500);
  h.fire("pointerup", { ...ev(700, 500), pointerId: 3, target: nodes.root });
  assert.equal(types(posted).pop(), "deselected");
  assert.equal(outlinesOf(nodes).length, 0);
});

test("a marquee release is never also a click, a drop or a drag", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  drawMarquee(h, nodes.root, 20, 20, 200, 180);
  let stopped = false;
  h.fire("pointerup", {
    ...ev(200, 180),
    pointerId: 3,
    target: nodes.title,
    stopImmediatePropagation: () => void (stopped = true),
  });
  assert.ok(stopped, "the page never sees the release");
  const before = posted.length;
  // The click the browser fires after the pointer comes up, over the title.
  h.fire("click", { ...ev(200, 180), target: nodes.title });
  assert.equal(posted.length, before, "the trailing click selected nothing");
  assert.equal(outlinesOf(nodes).length, 2, "and the marquee's selection stands");
  for (const type of ["drop", "drop-outside", "drag-start", "drag-end", "drag-outside"]) {
    assert.equal(types(posted).includes(type), false, type);
  }
  // Only that one click is swallowed: the next is a click again.
  h.fire("pointerdown", { ...ev(60, 60), pointerId: 4, target: nodes.title });
  h.fire("pointerup", { ...ev(60, 60), pointerId: 4, target: nodes.title });
  h.fire("click", { ...ev(60, 60), target: nodes.title });
  assert.equal(posted.pop().payload.dedupId, "src/App.tsx@1");
});

test("Escape and losing focus put a marquee away without touching the selection", () => {
  const ends = {
    Escape: (h) => h.fire("keydown", { key: "Escape", ...ev(0, 0) }),
    "the frame losing focus": (h) => h.fire("blur", {}),
  };
  for (const [how, end] of Object.entries(ends)) {
    const h = loadPage();
    const { nodes, posted } = h;
    h.send({ type: "select-id", id: "src/App.tsx@2" });
    // Shift, so the press on the page is a marquee whatever is selected.
    drawMarquee(h, nodes.root, 20, 20, 200, 80);
    assert.equal(marqueeBoxOf(nodes).style.display, "block", how);
    const before = posted.length;

    end(h);
    assert.equal(marqueeBoxOf(nodes).style.display, "none", how);
    assert.equal(outlinesOf(nodes).length, 0, `${how}: the would-be selection is gone`);
    // The pointer comes up later, and the browser clicks: neither selects.
    h.fire("pointerup", { ...ev(200, 80), pointerId: 3, target: nodes.title });
    h.fire("click", { ...ev(200, 80), target: nodes.title });
    assert.deepEqual(
      types(posted.slice(before)),
      [],
      `${how}: nothing reported — not a selection, and Escape is not forwarded as "deselect"`,
    );
    assert.equal(h.sandbox.consoleCalls.length, 0, how);
  }
});

test("a drag that starts inside the selection is still the re-parent drag", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  h.send({ type: "select-id", id: "src/App.tsx@1" });
  h.hit(nodes.item);
  h.fire("pointerdown", { ...ev(60, 60), pointerId: 3, target: nodes.title });
  h.fire("pointermove", { ...ev(60, 185), pointerId: 3, target: nodes.item });
  assert.ok(types(posted).includes("drag-start"));
  assert.equal(marqueeBoxOf(nodes).style.display, "none", "no marquee");
  h.fire("pointerup", { ...ev(60, 185), pointerId: 3, target: nodes.item });
  const drop = posted.find((m) => m.type === "drop");
  assert.equal(drop.id, "src/App.tsx@1");
  assert.equal(drop.to, "src/App.tsx@2");
});

test("with several selected, or with Shift, a drag is a marquee even on the selection", () => {
  // Several selected: the re-parent drag belongs to a single selection.
  const many = loadPage();
  many.send({ type: "select-ids", ids: ["src/App.tsx@1", "src/App.tsx@2"] });
  drawMarquee(many, many.nodes.title, 60, 60, 200, 120);
  assert.equal(marqueeBoxOf(many.nodes).style.display, "block");
  assert.equal(types(many.posted).includes("drag-start"), false);

  // Shift on the selected element: add to the selection, never move it.
  const h = loadPage();
  const { nodes, posted } = h;
  h.send({ type: "select-id", id: "src/App.tsx@1" });
  drawMarquee(h, nodes.title, 60, 160, 200, 180, { shiftKey: true });
  h.fire("pointerup", { ...ev(200, 180), pointerId: 3, target: nodes.item, shiftKey: true });
  assert.equal(types(posted).includes("drag-start"), false);
  assert.deepEqual(
    idsOf(posted.filter((m) => m.type === "selected-many").pop()),
    ["src/App.tsx@1", "src/App.tsx@2"],
    "the marquee caught only the item; Shift kept the title",
  );
});

test("shift-click adds an element to the selection and takes it back out", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  h.fire("click", { ...ev(60, 60), target: nodes.title });
  h.fire("click", { ...ev(60, 160), target: nodes.item, shiftKey: true });
  assert.deepEqual(
    idsOf(posted.filter((m) => m.type === "selected-many").pop()),
    ["src/App.tsx@1", "src/App.tsx@2"],
  );
  assert.equal(outlinesOf(nodes).length, 2);

  // Out again: one left, which is an ordinary selection once more.
  h.fire("click", { ...ev(60, 60), target: nodes.title, shiftKey: true });
  const last = posted.pop();
  assert.equal(last.type, "selected");
  assert.equal(last.payload.dedupId, "src/App.tsx@2");
  assert.equal(outlinesOf(nodes).length, 0);

  // And the last one out leaves nothing.
  h.fire("click", { ...ev(60, 160), target: nodes.item, shiftKey: true });
  assert.equal(posted.pop().type, "deselected");
});

test("a plain click still selects exactly one, and ends a multi-selection", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  h.send({ type: "select-ids", ids: ["src/App.tsx@1", "src/App.tsx@2"] });
  h.fire("pointerdown", { ...ev(60, 160), pointerId: 3, target: nodes.item });
  h.fire("pointerup", { ...ev(60, 160), pointerId: 3, target: nodes.item });
  h.fire("click", { ...ev(60, 160), target: nodes.item });
  const last = posted.pop();
  assert.equal(last.type, "selected");
  assert.equal(last.payload.dedupId, "src/App.tsx@2");
  assert.equal(outlinesOf(nodes).length, 0);
});

test("clicking the page's own empty space selects nothing", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  h.send({ type: "select-id", id: "src/App.tsx@1" });
  // <body> is not tagged: nothing of the project's is under the pointer.
  h.fire("click", { ...ev(900, 700), target: nodes.body });
  assert.equal(posted.pop().type, "deselected");
});

test("the editor can mirror a multi-selection in, and ask for it back", () => {
  const h = loadPage();
  const { nodes, posted } = h;
  const before = posted.length;
  h.send({ type: "select-ids", ids: ["src/App.tsx@2", "src/App.tsx@1", "nope@9"] });
  assert.equal(outlinesOf(nodes).length, 2);
  assert.equal(posted.length, before, "mirroring alone reports nothing back");

  h.send({ type: "select-ids", ids: ["src/App.tsx@2", "src/App.tsx@1"], report: true });
  assert.deepEqual(
    idsOf(posted.pop()),
    ["src/App.tsx@1", "src/App.tsx@2"],
    "reported in page order, whatever order they were asked for in",
  );

  // A frame holding none of them stays silent rather than racing a null back.
  h.send({ type: "select-ids", ids: ["other@1", "other@2"], report: true });
  assert.equal(posted.length, before, "nothing further posted (the answer above was popped)");
  assert.equal(outlinesOf(nodes).length, 0, "and drops what it was showing");

  h.send({ type: "select-ids", ids: ["src/App.tsx@1", "src/App.tsx@2"] });
  h.send({ type: "clear" });
  assert.equal(outlinesOf(nodes).length, 0, "clear takes every outline");
});

test("the marquee belongs to the select tool, and no grips come with several", () => {
  // Not armed (text, hand, annotate): a drag draws nothing.
  const off = loadOverlay();
  drawMarquee(off, off.nodes.root, 20, 20, 200, 180);
  assert.equal(marqueeBoxOf(off.nodes).style.display, "none");

  // Browse mode hands the page back, selection and all.
  const h = loadPage();
  const { nodes } = h;
  h.send({ type: "set-resizable", id: "src/App.tsx@1", enabled: true });
  h.send({ type: "select-ids", ids: ["src/App.tsx@1", "src/App.tsx@2"] });
  const grips = nodes.html.children.filter(
    (c) => c.hasAttribute("data-dedup-handle") && c.style.display === "block",
  );
  assert.equal(grips.length, 0, "resize is single-selection only");
  h.send({ type: "set-mode", mode: "browse" });
  assert.equal(outlinesOf(nodes).length, 0);
});

// --- viewport-height freeze --------------------------------------------------
// The base loadOverlay() harness stubs setTimeout as a no-op, since most
// tests don't care whether the debounced height report ever fires. This one
// does: it drives the freeze that runs inside that debounce.

test("a raw-vh full-height header (no Tailwind classname to hardcode) is pinned to the device viewport, and stays pinned across a re-render", () => {
  const html = makeEl("html");
  const body = makeEl("body");
  html.appendChild(body);
  const header = makeEl("header");
  header.style.setProperty("min-height", "100vh");
  header.setAttribute("style", "min-height: 100vh"); // reflects onto the attribute, like a real browser does

  const posted = [];
  const listeners = new Map();
  const addListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const fire = (type, event) => {
    for (const fn of listeners.get(type) ?? []) fn(event);
  };
  let timerFn = null;
  const documentStub = {
    documentElement: html,
    body,
    readyState: "interactive",
    createElement: (tag) => makeEl(tag),
    addEventListener: addListener,
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
    createRange: () => ({ selectNodeContents() {} }),
    elementFromPoint: () => null,
    title: "Test page",
  };
  const windowStub = {
    innerHeight: 800,
    innerWidth: 1200,
    addEventListener: addListener,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    parent: { postMessage: (msg) => posted.push(msg) },
  };
  const sandbox = {
    window: windowStub,
    document: documentStub,
    location: {
      pathname: "/",
      search: "",
      get href() {
        return "http://localhost:5173/";
      },
      reload() {},
      replace() {},
    },
    CSS: { escape: (v) => v },
    MutationObserver: class {
      observe() {}
    },
    setInterval: () => 0,
    // Height reporting is debounced through setTimeout; run it synchronously
    // so the test can drive it tick by tick instead of racing a real clock.
    setTimeout: (fn) => {
      timerFn = fn;
      return 1;
    },
    clearTimeout: () => {
      timerFn = null;
    },
    consoleCalls: [],
    getComputedStyle: (el) => ({
      overflowY: "visible",
      overflowX: "visible",
      ...(el?.computed ?? {}),
    }),
  };
  sandbox.console = { error() {}, warn() {}, log() {} };
  sandbox.globalThis = sandbox;
  Object.assign(sandbox, {
    URL,
    URLSearchParams,
    PopStateEvent: class {},
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLElement: class {},
  });
  body.appendChild(header);

  vm.runInNewContext(fs.readFileSync(OVERLAY, "utf8"), sandbox, {
    filename: "dedup-overlay.js",
  });
  const runTimer = () => {
    const fn = timerFn;
    timerFn = null;
    assert.ok(fn, "reportHeight never scheduled its debounced tick");
    fn();
  };

  // observeBody() ran a first tick already during evaluation (readyState is
  // "interactive"). Run it, then assert the header's raw vh was overridden
  // rather than left to re-resolve against whatever height the editor next
  // grows the frame to.
  runTimer();
  assert.equal(
    header.style.getPropertyValue("min-height"),
    "800px",
    "a min-height in vh units must be pinned to the device viewport even without a recognized Tailwind classname",
  );

  // A React re-render replaces the whole style attribute, putting the raw vh
  // value straight back — exactly what would otherwise let this header
  // re-resolve against a grown frame on the very next measurement.
  header.style.setProperty("min-height", "100vh");
  fire("load", {});
  runTimer();
  assert.equal(
    header.style.getPropertyValue("min-height"),
    "800px",
    "the pin must be reasserted every pass, or one re-render undoes it",
  );
});

console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
