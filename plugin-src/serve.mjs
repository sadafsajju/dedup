// dedup's dev server for plain HTML sites.
//
// A static site has no build step to hook, so there is nothing for the Vite
// plugin or the Next loader to ride on — but it also needs far less. The file
// *is* the markup, so this server does one thing on the way out: run every
// HTML response through the shared stamper (htmltag.mjs) so the canvas gets
// the same `data-dedup-id` attributes a React page gets, resolved by the same
// write-back against the same walk.
//
// It runs as the project's dev server child process, so everything the Rust
// core already does — own process group, streamed logs, ready-URL parse,
// teardown — applies unchanged. That is why it announces itself in Vite's
// format: `devserver.rs` learns the port by reading this line, and there is
// no second code path for "the static case".
//
// Bundled self-contained into the app's support directory; it never touches
// the user's folder, which for a static site has no node_modules to hide in.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildBootScript } from "./boot.mjs";
import { tagHtml } from "./htmltag.mjs";
import { discoverStaticRoutes } from "./routes.mjs";

const OVERLAY_ROUTE = "/__dedup/overlay.js";
const ROUTES_ROUTE = "/__dedup/routes";
const RELOAD_ROUTE = "/__dedup/reload";
const SESSION_ROUTE = "/__dedup/session.js";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".map": "application/json",
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Resolved through the symlinks up front: on macOS the folder picker hands
// back /var/... while the filesystem reports /private/var/..., and a root that
// disagreed with the files under it would make every dedup id relative to the
// wrong base.
const ROOT = fs.realpathSync(path.resolve(arg("root", process.cwd())));
// Element ids are relative to the *project* root even when the pages live in
// a subfolder (`site/`, `www/`), so one project has one path vocabulary: the
// id the canvas reports is the path the write-back opens.
const BASE = fs.realpathSync(path.resolve(arg("base", ROOT)));
const OVERLAY_FILE = arg("overlay");
const SESSION_FILE = arg("session");
const FIRST_PORT = Number(arg("port", "4321")) || 4321;

/**
 * Resolve a URL path to a file inside the project, or null.
 *
 * The refusal is the point: this server hands out whatever the path names, so
 * anything that escapes the root — `..`, an absolute path, a symlink pointing
 * out of the tree — must resolve to nothing rather than to a file on the
 * user's disk. Same rule as the write-back's `resolve_in_root`.
 */
function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split("?")[0]);
  } catch {
    return null;
  }
  const joined = path.resolve(ROOT, "." + (rel.startsWith("/") ? rel : "/" + rel));
  let real;
  try {
    real = fs.realpathSync(joined);
  } catch {
    return null;
  }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) return null;
  try {
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      const index = path.join(real, "index.html");
      return fs.existsSync(index) ? index : null;
    }
    return real;
  } catch {
    return null;
  }
}

/** The seed as the editor last saved it, or null. Read per request so saving
 *  one takes effect on the next frame reload — same contract as the tagger. */
function readSeed() {
  if (!SESSION_FILE) return null;
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

const RELOAD_CLIENT = `
<script>
// dedup live reload — the static equivalent of HMR: the file changed, so the
// page is reloaded. No module graph to be cleverer with.
(function () {
  var es = new EventSource(${JSON.stringify(RELOAD_ROUTE)});
  es.onmessage = function () { location.reload(); };
})();
</script>
`;

/**
 * Insert `snippet` right after the first `<head…>` (or `<html…>`, or at the
 * very top). The boot script has to run before anything else on the page, and
 * a hand-written HTML file may legitimately have no <head> at all.
 */
function injectAtTop(html, snippet) {
  const m = /<head[^>]*>/i.exec(html) ?? /<html[^>]*>/i.exec(html);
  if (!m) return snippet + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + "\n" + snippet + html.slice(at);
}

/** Insert `snippet` just before `</body>` (or append). */
function injectAtBottom(html, snippet) {
  const m = /<\/body\s*>/i.exec(html);
  if (!m) return html + snippet;
  return html.slice(0, m.index) + snippet + html.slice(m.index);
}

function renderHtml(file) {
  const relFile = path.relative(BASE, file);
  const source = fs.readFileSync(file, "utf8");
  let html = tagHtml(source, relFile);
  // Served as a file, not inlined — the same shape the Vite tagger uses. A
  // seed is user-authored script text, and inside an inline <script> the
  // string "</script>" anywhere in it would close the tag and dump the rest of
  // the boot script into the page as markup. A classic (non-deferred) src tag
  // still blocks until it has run, which is the property the seed needs.
  html = injectAtTop(html, `<script src="${SESSION_ROUTE}"></script>\n`);
  html = injectAtBottom(
    html,
    `<script src="${OVERLAY_ROUTE}" defer></script>\n${RELOAD_CLIENT}`,
  );
  return html;
}

// --- live reload -------------------------------------------------------------

const clients = new Set();

function watchProject() {
  let timer = null;
  try {
    fs.watch(ROOT, { recursive: true }, (_event, name) => {
      if (name && /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(String(name))) return;
      clearTimeout(timer);
      // Editors save in bursts (write + rename + chmod); one reload per burst.
      timer = setTimeout(() => {
        for (const res of clients) {
          try {
            res.write("data: reload\n\n");
          } catch {
            clients.delete(res);
          }
        }
      }, 60);
    });
  } catch (e) {
    console.log(`dedup: file watching unavailable (${e.message}) — edits need a manual reload`);
  }
}

// --- request handling ---------------------------------------------------------

function handle(req, res) {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === OVERLAY_ROUTE) {
    res.setHeader("content-type", "text/javascript");
    try {
      res.end(fs.readFileSync(OVERLAY_FILE, "utf8"));
    } catch (e) {
      res.statusCode = 404;
      res.end(`// dedup overlay missing: ${e}`);
    }
    return;
  }

  if (urlPath === SESSION_ROUTE) {
    // Read the seed fresh per request so saving one from the editor takes
    // effect on the next frame reload — same contract as the tagger. A
    // missing or unreadable file serves the inert script, never a 500 that
    // would block the page's <head>.
    res.setHeader("content-type", "text/javascript");
    res.setHeader("cache-control", "no-store");
    res.end(buildBootScript(readSeed()));
    return;
  }

  if (urlPath === ROUTES_ROUTE) {
    // The editor webview fetches this cross-origin.
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    const routes = discoverStaticRoutes(ROOT);
    res.end(JSON.stringify({ routes: routes.length ? routes : ["/"] }));
    return;
  }

  if (urlPath === RELOAD_ROUTE) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const file = resolveFile(urlPath);
  if (!file) {
    res.statusCode = 404;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><meta charset="utf-8"><body style="font:14px ui-sans-serif,system-ui;padding:40px;color:#444">` +
        `<h1 style="font-size:16px">404 — no such file</h1>` +
        `<p style="color:#888"><code>${urlPath.replace(/[<&]/g, "")}</code> isn't in this folder.</p>`,
    );
    return;
  }

  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") {
    let html;
    try {
      html = renderHtml(file);
    } catch (e) {
      res.statusCode = 500;
      res.end(`dedup: could not render ${path.relative(ROOT, file)}: ${e.message}`);
      return;
    }
    res.setHeader("content-type", MIME[".html"]);
    res.setHeader("cache-control", "no-store");
    res.end(html);
    return;
  }

  res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  fs.createReadStream(file)
    .on("error", () => {
      res.statusCode = 500;
      res.end("read error");
    })
    .pipe(res);
}

// --- listen -------------------------------------------------------------------

/**
 * Bind both loopback spellings on one port. `127.0.0.1` and `[::1]` are
 * separate origins to the browser — which is exactly how dedup renders a page
 * "signed out" — so a server reachable through only one of them would break
 * that the moment a static site grew a login.
 */
function listen(port) {
  return new Promise((resolve, reject) => {
    const v4 = http.createServer(handle);
    const v6 = http.createServer(handle);
    const fail = (e) => {
      v4.close();
      v6.close();
      reject(e);
    };
    v4.once("error", fail);
    v4.listen(port, "127.0.0.1", () => {
      v6.once("error", () => {
        // IPv6 loopback unavailable — v4 alone still serves the canvas.
        resolve({ v4, v6: null });
      });
      v6.listen(port, "::1", () => resolve({ v4, v6 }));
    });
  });
}

async function main() {
  let port = FIRST_PORT;
  let bound = false;
  for (let i = 0; i < 20 && !bound; i++, port++) {
    try {
      await listen(port);
      bound = true;
    } catch (e) {
      if (e && e.code === "EADDRINUSE") continue;
      console.error(`dedup: could not start the static server: ${e.message}`);
      process.exit(1);
    }
  }
  if (!bound) {
    console.error(
      `dedup: no free port in ${FIRST_PORT}-${port - 1} for the static server`,
    );
    process.exit(1);
  }
  port--; // the loop increments past the port it bound

  watchProject();
  console.log(`  dedup static server serving ${ROOT}`);
  // Vite's shape on purpose: the Rust core parses this line for the port.
  console.log(`  ➜  Local:   http://localhost:${port}/`);
}

main();
