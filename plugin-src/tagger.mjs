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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { tagCode };

const JSX_FILE_RE = /\.[jt]sx$/;
const OVERLAY_ROUTE = "/__dedup/overlay.js";
const HARNESS_ROUTE = "/__dedup/harness";
const ROUTES_ROUTE = "/__dedup/routes";
const SESSION_ROUTE = "/__dedup/session.js";
const HARNESS_ID = "virtual:dedup-harness";

/** Query flag on a frame's URL asking it to freeze on its first screen. */
export const HOLD_FLAG = "__dedup_hold";

/**
 * The script served into the top of every canvas page's <head>, carrying the
 * two things that must run *before the app boots*: the mock-session seed
 * (zero-login editing) and the hold (freezing a transient screen).
 *
 * Both are gated on being framed, so the user's own browsing of their dev
 * server is never affected, and both are wrapped so a failure warns instead
 * of killing the page in <head>. `seed` is the persisted `session.json`
 * (`{enabled, script}`) or null; with no seed and no hold flag this is still
 * a valid, inert script.
 */
export function buildBootScript(seed) {
  const body = seed && seed.enabled && seed.script && seed.script.trim()
    ? `  try {
${seed.script}
  } catch (e) {
    console.warn("dedup: mock-session seed failed", e);
  }`
    : "  /* no active mock session */";
  return `// dedup boot script — injected only into the editor canvas.
(function () {
  "use strict";
  // Framed gate: never touch the app when it's opened directly in a browser.
  if (window.top === window.self) return;
${body}

  // --- hold ---------------------------------------------------------------
  // Splash screens, interstitials and "redirecting…" states are gone before
  // anyone can look at them, so they can never be inspected or edited. When
  // this frame is flagged, freeze it on its first screen.
  //
  // Long timers are how those screens advance, so queue them. Short ones must
  // still run: React's scheduler falls back to setTimeout, and stalling that
  // hangs the page instead of pausing it. 400ms cleanly separates the two —
  // no framework schedules rendering that far out, and no splash is that
  // brief. Timer-driven navigation is covered twice over, since history is
  // frozen as well. Releasing restores everything and flushes what was held,
  // so the app continues rather than having lost the work.
  if (location.search.indexOf("${HOLD_FLAG}=1") === -1) return;
  try {
    var MIN_HELD_DELAY = 400;
    var queued = [];
    var seq = 0;
    var nSetTimeout = window.setTimeout.bind(window);
    var nSetInterval = window.setInterval.bind(window);
    var nClearTimeout = window.clearTimeout.bind(window);
    var nClearInterval = window.clearInterval.bind(window);

    var hold = function (fn, args, resume) {
      var id = "dedup-held-" + ++seq;
      queued.push({
        id: id,
        run: function () {
          if (resume) resume();
          fn.apply(null, args);
        },
      });
      return id;
    };
    window.setTimeout = function (fn, delay) {
      if (typeof fn === "function" && (+delay || 0) >= MIN_HELD_DELAY) {
        return hold(fn, [].slice.call(arguments, 2), null);
      }
      return nSetTimeout.apply(null, arguments);
    };
    window.setInterval = function (fn, delay) {
      var d = +delay || 0;
      if (typeof fn === "function" && d >= MIN_HELD_DELAY) {
        // On release the interval resumes ticking, not just fires once.
        return hold(fn, [].slice.call(arguments, 2), function () {
          nSetInterval(fn, d);
        });
      }
      return nSetInterval.apply(null, arguments);
    };
    var drop = function (id) {
      for (var i = 0; i < queued.length; i++) {
        if (queued[i].id === id) {
          queued.splice(i, 1);
          return true;
        }
      }
      return false;
    };
    // The app may cancel a held timer before it ever runs — honour that.
    window.clearTimeout = function (id) {
      if (!drop(id)) nClearTimeout(id);
    };
    window.clearInterval = function (id) {
      if (!drop(id)) nClearInterval(id);
    };

    var pushState = history.pushState;
    var replaceState = history.replaceState;
    history.pushState = function () {};
    history.replaceState = function () {};

    window.__dedupHeld = true;
    window.__dedupRelease = function () {
      if (!window.__dedupHeld) return;
      window.__dedupHeld = false;
      window.setTimeout = nSetTimeout;
      window.setInterval = nSetInterval;
      window.clearTimeout = nClearTimeout;
      window.clearInterval = nClearInterval;
      history.pushState = pushState;
      history.replaceState = replaceState;
      var pending = queued.slice();
      queued.length = 0;
      for (var i = 0; i < pending.length; i++) {
        try {
          pending[i].run();
        } catch (e) {
          console.warn("dedup: a held timer failed on release", e);
        }
      }
    };
  } catch (e) {
    console.warn("dedup: hold failed to install", e);
  }
})();
`;
}

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
        // Mock-session seed (zero-login editing): a classic, synchronous
        // script at the very top of <head>, so its storage writes land before
        // the app's module entry runs and reads them. Empty/no-op unless the
        // user has an active seed (served per request); self-gated to framed
        // canvas pages regardless.
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
      return null;
    },

    load(id) {
      if (id === HARNESS_ID) return harnessModule(projectRoot);
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
/**
 * Next.js file-based routes, read straight off the filesystem: `app/**\/page.*`
 * and `pages/**` (minus its API dir and its underscore-prefixed specials).
 * Dynamic segments (`[id]`, `[...slug]`) are skipped — an artboard needs a
 * URL that actually resolves, and we have no parameter to put there.
 */
export function discoverNextRoutes(root) {
  const routes = new Set();
  const bases = [
    ["app", (rel) => /(^|\/)page\.[jt]sx?$/.test(rel)],
    ["src/app", (rel) => /(^|\/)page\.[jt]sx?$/.test(rel)],
    ["pages", (rel) => /\.[jt]sx?$/.test(rel)],
    ["src/pages", (rel) => /\.[jt]sx?$/.test(rel)],
  ];

  for (const [base, isRouteFile] of bases) {
    const dir = path.join(root, base);
    if (!fs.existsSync(dir)) continue;
    const isPages = base.endsWith("pages");
    const stack = [""];
    while (stack.length) {
      const sub = stack.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(dir, sub), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const rel = sub ? `${sub}/${e.name}` : e.name;
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        if (isPages && (e.name === "api" || e.name.startsWith("_"))) continue;
        if (e.isDirectory()) {
          stack.push(rel);
          continue;
        }
        if (!isRouteFile(rel)) continue;
        // app/(marketing)/about/page.tsx → /about: route groups are naming,
        // not URL segments.
        let route = isPages
          ? "/" + rel.replace(/\.[jt]sx?$/, "").replace(/(^|\/)index$/, "")
          : "/" + rel.replace(/(^|\/)page\.[jt]sx?$/, "");
        route = route
          .split("/")
          .filter((seg) => !/^\(.*\)$/.test(seg))
          .join("/");
        route = route.replace(/\/+$/, "") || "/";
        if (route.includes("[") || route.includes("@")) continue;
        if (route.length < 64) routes.add(route);
      }
    }
  }
  return [...routes];
}

export function discoverRoutes(root) {
  const routes = new Set(["/", ...discoverNextRoutes(root)]);
  const srcDir = path.join(root, "src");
  const stack = [fs.existsSync(srcDir) ? srcDir : root];
  let filesRead = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (/^\.|^(node_modules|dist|build|coverage)$/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!/\.[jt]sx?$/.test(e.name) || ++filesRead > 800) continue;
      let text = "";
      try {
        text = fs.readFileSync(p, "utf8");
      } catch {
        continue;
      }
      if (!/react-router|<Route[\s>]|create(Browser|Hash|Memory)Router|useRoutes/.test(text)) {
        continue;
      }
      for (const m of text.matchAll(/\bpath\s*[=:]\s*[{(]?\s*["'`]([^"'`]+)["'`]/g)) {
        const r = m[1];
        if (r.startsWith("/") && !/[:*]/.test(r) && r.length < 64) routes.add(r);
      }
    }
  }
  return [...routes]
    .sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)))
    .slice(0, 40);
}

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

