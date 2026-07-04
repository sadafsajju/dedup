// dedup tagger — Vite plugin stamping every JSX element with
// `data-dedup-id="<file>:<line>:<col>"` plus the enclosing component name
// (FR-2.1), and injecting/serving the canvas overlay script (FR-2.2).
//
// This file is bundled (with @babel/parser + magic-string inlined) into a
// single self-contained module that dedup writes into the user's project at
// node_modules/.dedup/ — it must not require anything from their tree.
//
// Tags live only in the served JS, never in the user's source files.

import { parse } from "@babel/parser";
import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JSX_FILE_RE = /\.[jt]sx$/;
const OVERLAY_ROUTE = "/__dedup/overlay.js";
const HARNESS_ROUTE = "/__dedup/harness";
const HARNESS_ID = "virtual:dedup-harness";

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
const report = (data) => parent.postMessage({ __dedup: true, file, name, ...data }, "*");
let settled = false;
// React dev rethrows boundary-caught render errors globally — those must not
// settle the harness while the router retry is still pending.
let attempting = true;

window.addEventListener("error", (e) => { if (!attempting) fail(String(e.message)); });
window.addEventListener("unhandledrejection", (e) => { if (!attempting) fail(String(e.reason && e.reason.message || e.reason)); });

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
function attempt(Comp, Wrapper) {
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
    if (Wrapper) tree = React.createElement(Wrapper, null, tree);
    createRoot(el).render(tree);
    requestAnimationFrame(() => setTimeout(() => resolve(caught), 200));
  });
}

async function main() {
  try {
    // Allows a ?dedup-export=Name query for previewing file-local components.
    if (!/^[\\w@./?=&-]+$/.test(file)) throw new Error("bad file param");
    const mod = await import(/* @vite-ignore */ "/" + file);
    const Comp = (name === "default" ? mod.default : mod[name]) ?? mod.default;
    if (!Comp) throw new Error("export " + name + " not found in " + file);

    // Bare render first; components with their own <Router> must not be
    // double-wrapped. Router-shaped failures retry inside a MemoryRouter.
    let err = await attempt(Comp, null);
    if (err && ROUTERISH.test(String(err && err.message || err))) {
      ${routerImport}
      if (routerMod.MemoryRouter) err = await attempt(Comp, routerMod.MemoryRouter);
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

/**
 * Insert data-dedup-id / data-dedup-component into every JSX opening element.
 * `exportName` (harness only) additionally appends `export { Name };` so a
 * file-local component becomes importable. Exported for tests. Returns
 * { code, map } or null when nothing was changed.
 */
export function tagCode(code, relFile, exportName = null) {
  let ast;
  try {
    ast = parse(code, {
      sourceType: "module",
      errorRecovery: true,
      plugins: ["jsx", "typescript", "decorators-legacy"],
    });
  } catch {
    return null; // unparseable — leave the module untouched
  }

  const s = new MagicString(code);
  let tagged = 0;
  if (exportName && /^[A-Za-z_$][\w$]*$/.test(exportName)) {
    s.append(`\nexport { ${exportName} };\n`);
    tagged++;
  }

  walk(ast.program, [], (node, componentStack) => {
    if (isFragmentName(node.name)) return;
    const { line, column } = node.loc.start;
    const idValue = `${relFile}:${line}:${column}`;
    const component = componentStack[componentStack.length - 1];
    // Anchor right after the last attribute (or the name/generics when there
    // are none) so spacing stays natural for both `>` and ` />` endings.
    const last = node.attributes[node.attributes.length - 1];
    const insertAt =
      last?.end ??
      node.typeArguments?.end ??
      node.typeParameters?.end ??
      node.name.end;
    let attrs = ` data-dedup-id="${idValue}"`;
    if (component) attrs += ` data-dedup-component="${component}"`;
    s.appendLeft(insertAt, attrs);
    tagged++;
  });

  if (tagged === 0) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}

/** Depth-first AST walk that tracks the enclosing-component name stack and
 * calls `visit` for every JSXOpeningElement. */
function walk(node, componentStack, visit) {
  if (!node || typeof node.type !== "string") return;

  const componentName = componentNameOf(node);
  if (componentName) componentStack.push(componentName);

  if (node.type === "JSXOpeningElement") visit(node, componentStack);

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, componentStack, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, componentStack, visit);
    }
  }

  if (componentName) componentStack.pop();
}

/** A function is "a component" when it's named with a leading capital —
 * function declarations and const Foo = () => … / function () … forms. */
function componentNameOf(node) {
  if (
    node.type === "FunctionDeclaration" &&
    node.id &&
    /^[A-Z]/.test(node.id.name)
  ) {
    return node.id.name;
  }
  if (
    node.type === "VariableDeclarator" &&
    node.id?.type === "Identifier" &&
    /^[A-Z]/.test(node.id.name) &&
    node.init &&
    (node.init.type === "ArrowFunctionExpression" ||
      node.init.type === "FunctionExpression")
  ) {
    return node.id.name;
  }
  return null;
}

/** Fragments (<></>, <Fragment>, <React.Fragment>) only accept `key` —
 * adding data attributes would make React warn. */
function isFragmentName(name) {
  if (!name) return true;
  if (name.type === "JSXIdentifier") return name.name === "Fragment";
  if (name.type === "JSXMemberExpression") {
    return (
      name.property?.name === "Fragment" &&
      name.object?.type === "JSXIdentifier"
    );
  }
  return false;
}
