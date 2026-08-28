// Module-specifier resolution — the difference between "a JSX tag spelled
// `Card`" and "a use of *this* `Card`".
//
// The scan's call-site counts are name-based on purpose (they only rank
// clusters, so an approximation is fine). A codemod cannot be approximate: a
// rewrite that renames someone's `<Card>` from a UI library because it shares
// a name with the component being merged is exactly the corrupted-codebase
// failure the safety model exists to prevent. So every call site the merge
// touches must be traced back to the member file through a real import.
//
// Resolution covers what a Vite/Next React project actually uses: relative
// specifiers, tsconfig `paths` aliases, and `baseUrl`. Anything else — a bare
// package name, a specifier no strategy resolves — is reported unresolved
// rather than guessed at, and the merge refuses those call sites out loud.

import fs from "node:fs";
import path from "node:path";

/** Extension order matches what bundlers try, TS first (these are .tsx apps). */
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"];

/** Resolve `spec` as a file path: exact, then +ext, then /index+ext. */
export function resolveFileLike(spec) {
  try {
    if (fs.statSync(spec).isFile()) return spec;
  } catch {
    // Not a file on its own — try the extension candidates below.
  }
  for (const ext of EXTENSIONS) {
    const candidate = spec + ext;
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = path.join(spec, "index" + ext);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read the alias table out of tsconfig/jsconfig. Only `baseUrl` + `paths` are
 * honoured — the two that actually redirect module resolution. `extends` is
 * followed one level, which covers the common `tsconfig.app.json` split.
 */
export function readAliases(root) {
  const seen = new Set();
  const read = (file, depth) => {
    if (depth > 3 || seen.has(file)) return null;
    seen.add(file);
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let config;
    try {
      config = JSON.parse(stripJsonComments(text));
    } catch {
      return null;
    }
    let inherited = { baseUrl: null, paths: {} };
    if (typeof config.extends === "string") {
      const base = config.extends.startsWith(".")
        ? path.resolve(path.dirname(file), config.extends)
        : path.join(root, "node_modules", config.extends);
      inherited = read(resolveFileLike(base) ?? base + ".json", depth + 1) ?? inherited;
    }
    const opts = config.compilerOptions ?? {};
    return {
      baseUrl: opts.baseUrl
        ? path.resolve(path.dirname(file), opts.baseUrl)
        : inherited.baseUrl,
      paths: { ...inherited.paths, ...(opts.paths ?? {}) },
      // Where `paths` patterns resolve from: baseUrl when set, else the
      // config's own directory (TS 5's behaviour).
      pathsBase: opts.paths
        ? opts.baseUrl
          ? path.resolve(path.dirname(file), opts.baseUrl)
          : path.dirname(file)
        : inherited.pathsBase ?? null,
    };
  };

  const merged = { baseUrl: null, paths: {}, pathsBase: null };
  for (const name of ["tsconfig.json", "jsconfig.json", "tsconfig.app.json"]) {
    const found = read(path.join(root, name), 0);
    if (!found) continue;
    merged.baseUrl = merged.baseUrl ?? found.baseUrl;
    merged.pathsBase = merged.pathsBase ?? found.pathsBase;
    Object.assign(merged.paths, found.paths);
  }
  return merged;
}

/** JSON with // and /* *​/ comments — tsconfig's dialect. */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  // Trailing commas are legal in tsconfig, not in JSON.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Resolve one import specifier written in `fromFile` to an absolute file
 * path, or null when nothing in the project answers to it (a real package,
 * a CSS import, an alias we don't model).
 */
export function resolveSpecifier(spec, fromFile, aliases) {
  if (typeof spec !== "string" || spec === "") return null;
  if (spec.startsWith(".")) {
    return resolveFileLike(path.resolve(path.dirname(fromFile), spec));
  }
  if (spec.startsWith("/")) return resolveFileLike(spec);

  // tsconfig paths — longest pattern wins, as TS does it.
  const patterns = Object.keys(aliases?.paths ?? {}).sort(
    (a, b) => b.length - a.length,
  );
  for (const pattern of patterns) {
    const star = pattern.indexOf("*");
    let tail = null;
    if (star === -1) {
      if (spec !== pattern) continue;
      tail = "";
    } else {
      const head = pattern.slice(0, star);
      const rest = pattern.slice(star + 1);
      if (!spec.startsWith(head) || !spec.endsWith(rest)) continue;
      tail = spec.slice(head.length, spec.length - rest.length);
    }
    for (const target of aliases.paths[pattern]) {
      const filled = target.includes("*") ? target.replace("*", tail) : target;
      const base = aliases.pathsBase ?? aliases.baseUrl;
      if (!base) continue;
      const hit = resolveFileLike(path.resolve(base, filled));
      if (hit) return hit;
    }
  }

  if (aliases?.baseUrl) {
    const hit = resolveFileLike(path.resolve(aliases.baseUrl, spec));
    if (hit) return hit;
  }
  return null;
}

/**
 * Import specifier to write in `fromFile` so it points at `toFile`. Reuses
 * an alias prefix when the project has one covering the target (matching the
 * codebase's own convention beats a six-level `../../../`), relative
 * otherwise. The extension is dropped — bundler convention, and what every
 * existing import in these projects looks like.
 */
export function specifierFor(fromFile, toFile, aliases) {
  const aliased = aliasSpecifier(toFile, aliases);
  if (aliased) return aliased;
  let rel = path
    .relative(path.dirname(fromFile), toFile)
    .split(path.sep)
    .join("/");
  rel = rel.replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
  if (rel.endsWith("/index")) rel = rel.slice(0, -"/index".length);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

function aliasSpecifier(toFile, aliases) {
  const base = aliases?.pathsBase ?? aliases?.baseUrl;
  if (!base) return null;
  let best = null;
  for (const [pattern, targets] of Object.entries(aliases.paths ?? {})) {
    const star = pattern.indexOf("*");
    if (star === -1) continue;
    for (const target of targets) {
      const tStar = target.indexOf("*");
      if (tStar === -1) continue;
      const dir = path.resolve(base, target.slice(0, tStar));
      const rel = path.relative(dir, toFile);
      if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
      let tail = rel.split(path.sep).join("/").replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
      if (tail.endsWith("/index")) tail = tail.slice(0, -"/index".length);
      const spec = pattern.slice(0, star) + tail + pattern.slice(star + 1);
      // Shortest wins — the most specific alias for this file.
      if (best === null || spec.length < best.length) best = spec;
    }
  }
  return best;
}
