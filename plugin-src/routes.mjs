// Route discovery — which URLs of the user's app can become page artboards
// (FR-6.3).
//
// Its own module because two very different callers need the same answer: the
// Vite plugin serves it over `/__dedup/routes` from inside the dev server,
// and the write-back sidecar answers a `routes` command from outside it. That
// second path is the only one a Next.js project has — Next has no middleware
// dedup can add — so a copy here that drifted from the one there would mean
// Vite and Next projects disagreed about what pages a project has.

import fs from "node:fs";
import path from "node:path";

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

/**
 * Routes of a plain static site: every `.html` file is its own URL. Unlike
 * the framework scanners above this needs no heuristics — the filesystem is
 * the routing table, exactly, which is the one thing a static site makes easy.
 *
 * `index.html` becomes the directory's route ("/", "/docs/"), everything else
 * keeps its extension because that is genuinely the URL the browser asks for.
 */
export function discoverStaticRoutes(root) {
  const routes = new Set();
  const stack = [""];
  let seen = 0;
  while (stack.length) {
    const sub = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (/^\.|^(node_modules|dist|build|coverage|vendor)$/.test(e.name)) continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (rel.split("/").length < 4) stack.push(rel);
        continue;
      }
      if (!e.name.endsWith(".html") || ++seen > 200) continue;
      const route =
        e.name === "index.html" ? `/${sub ? sub + "/" : ""}` : `/${rel}`;
      routes.add(route);
    }
  }
  return [...routes];
}

/**
 * The project's routes. `kind` is the framework the Rust core already
 * detected — passed in rather than re-guessed here, because "does this folder
 * have a router or a pile of .html files" is exactly the question detection
 * already answered, and a second opinion could disagree with the first.
 */
export function discoverRoutes(root, kind) {
  if (kind === "static") {
    const statics = discoverStaticRoutes(root);
    return (statics.length ? statics : ["/"])
      .sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)))
      .slice(0, 40);
  }

  // `pages/` and `app/` are routes only because Next says so. Anywhere else
  // they are just folders: a Vite + react-router app keeping its views in
  // `src/pages/` grew a phantom page per file (`/Home`, `/About`) beside its
  // real routes. Only a project detected as Next gets file-based routing.
  const routes = new Set(["/", ...(kind === "next" ? discoverNextRoutes(root) : [])]);
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
