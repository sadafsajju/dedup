// Shared project traversal for the analysis sidecars — one definition of
// "which files dedup considers part of the user's app, and how they parse".
//
// The scan and the merge codemod must agree on this exactly: the scan finds a
// duplicate cluster over some set of files, and the merge then rewrites call
// sites over the same set. If the two walked different trees, a merge could
// rename a component in a file the scan never looked at, or miss a call site
// that exists — the second is a broken build, the first is worse.

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

export const COMPONENT_FILE_RE = /\.[jt]sx$/;
/** Any module that can *import* a component — call sites live here too. */
export const SOURCE_FILE_RE = /\.[jt]sx?$/;
export const MAX_FILE_BYTES = 512 * 1024; // generated/vendored monsters aren't components
export const MAX_FILES = 5000;

/**
 * Every source file under `root`, sorted. `pattern` picks which kinds:
 * COMPONENT_FILE_RE for "files that can declare JSX components" (the scan),
 * SOURCE_FILE_RE for "files that can reference one" (the codemod).
 */
export function discoverFiles(root, pattern = COMPONENT_FILE_RE) {
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
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
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
