// dedup tagger — Vite plugin stamping every JSX element with
// `data-dedup-id="<file>@<ordinal>"` plus the enclosing component name and
// what may safely be done to the node (FR-2.1), and injecting/serving the
// canvas overlay script (FR-2.2).
//
// This file is bundled (with @babel/parser + magic-string inlined) into a
// single self-contained module that dedup writes into the user's project at
// node_modules/.dedup/ — it must not require anything from their tree.
//
// Tags live only in the served JS, never in the user's source files.

import { tagCode } from "./tagcode.mjs";
import { buildBootScript } from "./boot.mjs";
import { discoverRoutes } from "./routes.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { tagCode };
export { buildBootScript, HOLD_FLAG, OFFLINE_FLAG } from "./boot.mjs";
export { discoverRoutes } from "./routes.mjs";

const JSX_FILE_RE = /\.[jt]sx$/;
const OVERLAY_ROUTE = "/__dedup/overlay.js";
const HARNESS_ROUTE = "/__dedup/harness";
const ROUTES_ROUTE = "/__dedup/routes";
const SNIPPET_ROUTE = "/__dedup/snippet";
const SESSION_ROUTE = "/__dedup/session.js";
const HARNESS_ID = "virtual:dedup-harness";
const SNIPPET_ID = "virtual:dedup-snippet";


/** Candidate global stylesheets so harness-rendered components get the
 * project's Tailwind theme. Best-effort — missing files are skipped. */
const CSS_CANDIDATES = [
  "src/index.css",
  "src/main.css",
  "src/App.css",
  "src/app.css",
  "src/styles.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "app/globals.css",
];

export default function dedupTagger(options = {}) {
  const projectRoot = options.root || process.cwd();
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const overlayFile = options.overlayFile || path.join(selfDir, "dedup-overlay.js");

  return {
    name: "dedup:tagger",
    enforce: "pre",

    transform(code, id) {
      const [file, query] = id.split("?", 2);
      if (!JSX_FILE_RE.test(file) || file.includes("node_modules")) return null;
      const rel = path.relative(projectRoot, file);
      if (rel.startsWith("..")) return null;
      // Harness-only virtual export: `?dedup-export=Name` appends an export
      // for a file-local component so it can be previewed in isolation. The
      // query makes this a separate module — the app's own import of the
      // file is untouched.
      const exportName = new URLSearchParams(query ?? "").get("dedup-export");
      return tagCode(code, rel, exportName);
    },

    transformIndexHtml() {
      return [
        // The boot script (see boot.mjs): a classic, synchronous script at
        // the very top of <head>, because everything it carries has to be in
        // place before the app's module entry runs — the seed's storage
        // writes before the app reads them, the offline cut before the app's
        // first request. Inert unless a seed is active or a frame flag asks
        // for something; self-gated to framed canvas pages regardless.
        {
          tag: "script",
          attrs: { src: SESSION_ROUTE },
          injectTo: "head-prepend",
        },
        {
          tag: "script",
          attrs: { src: OVERLAY_ROUTE, defer: true },
          injectTo: "body",
        },
      ];
    },

    // Component render harness (FR-5.2): /__dedup/harness?file=…&name=…
    // renders one component in isolation for the editor's canvas artboards.
    resolveId(id) {
      if (id === HARNESS_ID) return HARNESS_ID;
      if (id === SNIPPET_ID) return SNIPPET_ID;
      return null;
    },

    load(id) {
      if (id === HARNESS_ID) return harnessModule(projectRoot);
      if (id === SNIPPET_ID) return snippetModule(projectRoot);
      return null;
    },

    configureServer(server) {
      server.middlewares.use(OVERLAY_ROUTE, (_req, res) => {
        res.setHeader("content-type", "text/javascript");
        try {
          res.end(fs.readFileSync(overlayFile, "utf8"));
        } catch (e) {
          res.statusCode = 404;
          res.end(`// dedup overlay missing: ${e}`);
        }
      });
      server.middlewares.use(ROUTES_ROUTE, (_req, res) => {
        // Pages-as-artboards (editor canvas): every discovered route renders
        // as its own frame. CORS is explicit — the editor webview fetches
        // this cross-origin.
        res.setHeader("content-type", "application/json");
        res.setHeader("access-control-allow-origin", "*");
        try {
          res.end(JSON.stringify({ routes: discoverRoutes(projectRoot) }));
        } catch {
          res.end(JSON.stringify({ routes: ["/"] }));
        }
      });
      server.middlewares.use(SESSION_ROUTE, (_req, res) => {
        // Read the seed fresh per request so saving from the editor takes
        // effect on the next frame reload — no dev-server restart. Missing or
        // unreadable file → empty no-op script (never a 500 that would block
        // the app's <head>).
        res.setHeader("content-type", "text/javascript");
        let seed = null;
        try {
          const raw = fs.readFileSync(
            path.join(projectRoot, "node_modules/.dedup/session.json"),
            "utf8",
          );
          seed = JSON.parse(raw);
        } catch {
          // No seed configured — serve the empty script below.
        }
        res.end(buildBootScript(seed));
      });
      server.middlewares.use(SNIPPET_ROUTE, (req, res) => {
        // Same pipeline as the harness for the same reason (the react plugin's
        // preamble), even though this page mounts no components: it still
        // loads a module Vite has to transform.
        server
          .transformIndexHtml(req.originalUrl || SNIPPET_ROUTE, SNIPPET_HTML)
          .then((html) => {
            res.setHeader("content-type", "text/html");
            res.end(html);
          })
          .catch((e) => {
            res.statusCode = 500;
            res.end(`dedup snippet: ${e}`);
          });
      });
      server.middlewares.use(HARNESS_ROUTE, (req, res) => {
        // Through the HTML transform pipeline, not raw: @vitejs/plugin-react
        // injects its react-refresh preamble there, and component modules
        // refuse to load without it ("can't detect preamble").
        server
          .transformIndexHtml(req.originalUrl || HARNESS_ROUTE, HARNESS_HTML)
          .then((html) => {
            res.setHeader("content-type", "text/html");
            res.end(html);
          })
          .catch((e) => {
            res.statusCode = 500;
            res.end(`dedup harness: ${e}`);
          });
      });
    },
  };
}

/**
 * Static route discovery for pages-as-artboards: a regex-level scan of the
 * project's source for react-router path literals. Deliberately conservative —
 * absolute, static paths only (dynamic segments like /orders/:id need data we
 * can't invent), qualified to files that actually touch a router. "/" is
 * always included; capped so a route-heavy app can't spawn 100 live frames.
 */
// The shell is static; the module reads ?file=&name= from location at runtime.
const HARNESS_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; background: #fff; }
      #root { display: inline-block; padding: 16px; min-width: 40px; min-height: 24px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${HARNESS_ID}"></script>
  </body>
</html>
`;

const SNIPPET_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; background: #fff; }
      #root { display: inline-block; min-width: 8px; min-height: 8px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${SNIPPET_ID}"></script>
  </body>
</html>
`;

/**
 * Source of the snippet module: drops a fragment of markup into a page that
 * carries the project's own stylesheets, and reports what size it came out.
 *
 * This exists because a *drift occurrence* has no name and no export — it is
 * `<button className="…">Save</button>` sitting inside a page — so the
 * component harness below, which imports a module and mounts an export, has
 * nothing to import. The markup is all there is, and with the project's own
 * Tailwind build behind it that is enough for the preview to be the real
 * pixels rather than an approximation.
 *
 * It renders inert markup and nothing else: no React, no user modules, no
 * handlers. The snippet arrives in the query string already stripped of
 * anything dynamic (see `previewHtml` in plugin-src/extract.mjs).
 */
export function snippetModule(root) {
  const cssImports = CSS_CANDIDATES.filter((f) => fs.existsSync(path.join(root, f)))
    .map((f) => `import "/${f}";`)
    .join("\n");

  return `${cssImports}
const q = new URLSearchParams(location.search);
const rootEl = document.getElementById("root");
const id = q.get("id") || "";
const fixedW = parseInt(q.get("w") || "", 10) || 0;
if (fixedW > 0) { rootEl.style.display = "block"; rootEl.style.width = fixedW + "px"; }
rootEl.innerHTML = q.get("html") || "";
// Stylesheets land asynchronously, so measure after a paint or the report is
// the unstyled size — which for Tailwind markup is wildly wrong.
requestAnimationFrame(() => requestAnimationFrame(() => {
  const r = rootEl.getBoundingClientRect();
  parent.postMessage({
    __dedup: true,
    type: "snippet-size",
    id,
    width: Math.ceil(r.width),
    height: Math.ceil(r.height),
  }, "*");
}));
`;
}

/**
 * Source of the harness module, generated per project so it can import the
 * project's own global stylesheets (Tailwind theme + utilities). Renders the
 * requested export with neutral props inside an error boundary and reports
 * its natural size — or the failure — to the editor via postMessage.
 */
export function harnessModule(root) {
  const cssImports = CSS_CANDIDATES.filter((f) => fs.existsSync(path.join(root, f)))
    .map((f) => `import "/${f}";`)
    .join("\n");
  // Router context is decided here, not in the browser: only import what the
  // project actually has installed, so Vite never resolves a missing package.
  const routerPkg = ["react-router-dom", "react-router"].find((p) =>
    fs.existsSync(path.join(root, "node_modules", p)),
  );
  const routerImport = routerPkg
    ? `const routerMod = await import(${JSON.stringify(routerPkg)});`
    : "const routerMod = {};";

  return `${cssImports}
import React from "react";
import { createRoot } from "react-dom/client";

const q = new URLSearchParams(location.search);
const file = q.get("file") || "";
const name = q.get("name") || "default";
// AI-generated mock props (JSON) — realistic previews instead of empty ones.
let mockProps = {};
try { mockProps = JSON.parse(q.get("props") || "{}") || {}; } catch {}
// Rendered-size lock: when the editor knows the component's on-page width,
// lay out at exactly that width (no probe padding) so the preview matches
// how the component actually renders on the site.
const fixedW = parseInt(q.get("w") || "", 10) || 0;
if (fixedW > 0) {
  const rootEl = document.getElementById("root");
  rootEl.style.padding = "0";
  rootEl.style.display = "block";
  rootEl.style.width = fixedW + "px";
  rootEl.style.minWidth = "0";
}
const report = (data) => parent.postMessage({ __dedup: true, file, name, ...data }, "*");
let settled = false;
// React dev rethrows boundary-caught render errors globally — those must not
// settle the harness while the router retry is still pending.
let attempting = true;

// Harness pages are render probes, not the user's app: React logs several
// console lines per failed attempt per artboard, and Vite's client log
// forwarding would flood the editor console with them. The artboard
// placeholder already shows the real failure — keep the probes quiet.
console.error = console.warn = function () {};

window.addEventListener("error", (e) => { e.preventDefault(); if (!attempting) fail(String(e.message)); });
window.addEventListener("unhandledrejection", (e) => { e.preventDefault(); if (!attempting) fail(String(e.reason && e.reason.message || e.reason)); });

function fail(error) {
  if (settled) return;
  settled = true;
  report({ type: "harness-error", error });
}

function succeed() {
  if (settled) return;
  settled = true;
  const r = document.getElementById("root").getBoundingClientRect();
  report({ type: "harness-size", width: Math.ceil(r.width), height: Math.ceil(r.height) });
}

const ROUTERISH = /router|navigate|location|params|outlet|link/i;

/** Render once into a fresh container; resolves the render error or null. */
function attempt(Comp, wrappers) {
  return new Promise((resolve) => {
    const host = document.getElementById("root");
    host.textContent = "";
    const el = document.createElement("div");
    host.appendChild(el);
    let caught = null;
    class Boundary extends React.Component {
      constructor(p) { super(p); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(err) { caught = err; }
      render() { return this.state.failed ? null : this.props.children; }
    }
    let tree = React.createElement(Boundary, null,
      React.createElement(Comp, { children: "Aa", ...mockProps }));
    for (const W of wrappers) tree = React.createElement(W, null, tree);
    createRoot(el).render(tree);
    requestAnimationFrame(() => setTimeout(() => resolve(caught), 200));
  });
}

// Context-hook failures ("useTheme must be used within a ThemeProvider") name
// their remedy in the stack: the app module the hook threw from usually also
// exports the *Provider component. Import that module and return an unused
// Provider export, or null when the error isn't shaped that way.
async function providerFromStack(err, used) {
  const stack = String(err && err.stack || "");
  for (const m of stack.matchAll(/https?:\\/\\/[^\\s)]+?(?=:\\d+:\\d+)/g)) {
    if (m[0].includes("/node_modules/")) continue;
    try {
      const mod = await import(/* @vite-ignore */ new URL(m[0]).pathname);
      for (const k of Object.keys(mod)) {
        if (/Provider$/.test(k) && typeof mod[k] === "function" && !used.has(k)) {
          used.add(k);
          return mod[k];
        }
      }
    } catch {}
  }
  return null;
}

async function main() {
  try {
    // Allows a ?dedup-export=Name query for previewing file-local components.
    if (!/^[\\w@./?=&-]+$/.test(file)) throw new Error("bad file param");
    const mod = await import(/* @vite-ignore */ "/" + file);
    const Comp = (name === "default" ? mod.default : mod[name]) ?? mod.default;
    if (!Comp) throw new Error("export " + name + " not found in " + file);

    // Render ladder: bare first (components owning a Router or providers must
    // not be double-wrapped), then accumulate wrappers one failure at a time —
    // a MemoryRouter for router-shaped errors, then app providers discovered
    // from the throwing module (a page can need both, so wrappers compose).
    const wrappers = [];
    const used = new Set();
    let routerTried = false;
    let err = await attempt(Comp, wrappers);
    for (let i = 0; err && i < 3; i++) {
      let next = null;
      if (!routerTried && ROUTERISH.test(String(err && err.message || err))) {
        routerTried = true;
        ${routerImport}
        next = routerMod.MemoryRouter || null;
      }
      if (!next) next = await providerFromStack(err, used);
      if (!next) break;
      wrappers.push(next);
      err = await attempt(Comp, wrappers);
    }
    attempting = false;
    if (err) fail(String(err && err.message || err));
    else succeed();
  } catch (e) {
    attempting = false;
    fail(String(e && e.message || e));
  }
}
main();
`;
}

