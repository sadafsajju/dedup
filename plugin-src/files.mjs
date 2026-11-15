// Shared project traversal and parsing for source editing.

import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "public",
  ".dedup-trash",
]);

/** What the chat agent may list and read: source, markup, styles, and the
 *  small config files it needs to answer "how is this project set up". */
export const CONTEXT_FILE_RE =
  /\.(?:[jt]sx?|mjs|cjs|mts|cts|css|s[ac]ss|html?|json|md)$/i;
export const MAX_FILE_BYTES = 512 * 1024; // cap generated/vendored files
export const MAX_FILES = 5000;

/**
 * Every source file under `root`, sorted. `pattern` picks which kinds:
 * CONTEXT_FILE_RE for "files the chat agent may read" (a wider net — the
 * agent answers questions about markup and stylesheets too).
 *
 * `allow` un-skips directories that are normally skipped. Only the chat agent
 * passes it, and only for `public/`: a static site keeps its actual pages
 * there, so the default skip list would leave the agent blind to the very
 * files it is being asked about. Source listing uses the default skips otherwise.
 */
export function discoverFiles(root, pattern = CONTEXT_FILE_RE, allow = null) {
  const files = [];
  const stack = [root];
  while (stack.length > 0 && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) || allow?.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && pattern.test(entry.name)) {
        files.push(full);
      }
    }
  }
  return files.sort();
}

export function parseSource(code) {
  return parse(code, {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "decorators-legacy"],
  });
}

/** Strict parse — the gate before anything is written (PRD §6). */
export function parseStrict(code) {
  return parse(code, {
    sourceType: "module",
    plugins: ["jsx", "typescript", "decorators-legacy"],
  });
}

const AST_SKIP_KEYS = new Set(["loc", "leadingComments", "trailingComments"]);

/** Depth-first AST walk; a visitor returning false prunes that subtree. */
export function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (AST_SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}

/** Project-relative, POSIX-spelled — the form every dedup id and API uses. */
export function relOf(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Was this module run as the program, rather than imported?
 *
 * The naive `process.argv[1] === new URL(import.meta.url).pathname` looks
 * right and fails in exactly the case that matters: macOS hands out temp
 * paths as `/var/folders/…` while Node resolves `import.meta.url` through the
 * `/private/var/…` realpath, so a sidecar running from a symlinked directory
 * registers no stdin handler and exits silently having produced nothing.
 * Both sides go through realpath here, so the comparison is of the same file
 * rather than of two spellings of it.
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(entry) === real(url.fileURLToPath(importMetaUrl));
}
