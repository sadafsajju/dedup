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
import { guardResponse, NOTICE } from "./frameable.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export { tagCode };
export { buildBootScript, HOLD_FLAG, OFFLINE_FLAG } from "./boot.mjs";
export { discoverRoutes } from "./routes.mjs";

const JSX_FILE_RE = /\.[jt]sx$/;
const OVERLAY_ROUTE = "/__dedup/overlay.js";
const ROUTES_ROUTE = "/__dedup/routes";
const SESSION_ROUTE = "/__dedup/session.js";


export default function dedupTagger(options = {}) {
  const projectRoot = options.root || process.cwd();
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const overlayFile = options.overlayFile || path.join(selfDir, "dedup-overlay.js");

  return {
    name: "dedup:tagger",
    enforce: "pre",

    transform(code, id) {
      const [file] = id.split("?", 2);
      if (!JSX_FILE_RE.test(file) || file.includes("node_modules")) return null;
      const rel = path.relative(projectRoot, file);
      if (rel.startsWith("..")) return null;
      return tagCode(code, rel);
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

    configureServer(server) {
      // First in the chain, so nothing later can leave a framing guard on the
      // response: the canvas is an iframe, and `X-Frame-Options` from a
      // project's `server.headers` (or any plugin) is a blank white artboard
      // with no error anywhere the user can see. See `frameable.mjs`.
      let announced = false;
      server.middlewares.use((_req, res, next) => {
        guardResponse(res, () => {
          if (announced) return;
          announced = true;
          // eslint-disable-next-line no-console
          console.warn(NOTICE);
        });
        next();
      });

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
    },
  };
}
