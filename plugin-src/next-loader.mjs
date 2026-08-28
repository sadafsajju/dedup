// The Next/webpack tagging loader. Bundled to CommonJS (webpack resolves
// loaders through require) and written to node_modules/.dedup/next-loader.cjs.
//
// It is a thin shell on purpose: every decision about *which* elements get an
// id, and what that id is, lives in `tagCode` → `jsxwalk`, shared with the
// Vite plugin. An element's identity is its ordinal in that one traversal, so
// a second implementation here would not be a second tagger — it would be a
// second, silently incompatible identity scheme, and the write-back only
// knows one.

import path from "node:path";
import { tagCode } from "./tagcode.mjs";

export default function dedupLoader(source, inputMap) {
  const callback = this.async();
  const root = this.rootContext || process.cwd();
  const rel = path
    .relative(root, this.resourcePath)
    .split(path.sep)
    .join("/");

  // Outside the project, or vendored: not the user's markup, not ours to tag.
  if (rel.startsWith("..") || rel.includes("node_modules")) {
    callback(null, source, inputMap);
    return;
  }

  let result = null;
  try {
    result = tagCode(source, rel);
  } catch {
    // A file dedup cannot tag is still a file that has to build.
    result = null;
  }
  callback(
    null,
    result ? result.code : source,
    result ? (result.map ?? inputMap) : inputMap,
  );
}
