// The JSX tagging transform — the one implementation, shared by both build
// pipelines.
//
// The Vite plugin and the Next/webpack loader both call this and nothing else.
// That is not tidiness: an element's dedup id is its ORDINAL in the shared
// jsxwalk traversal, so two taggers that disagreed about which elements count,
// or in what order, would hand the write-back two incompatible identity
// schemes for the same file. There is one walk (jsxwalk.mjs) and one stamper
// (this file), and every pipeline is a thin shell around them.

import { parse } from "@babel/parser";
import MagicString from "magic-string";
import { makeDedupId, walkJsx } from "./jsxwalk.mjs";

/**
 * Insert dedup's tracking attributes into every JSX opening element:
 *
 *   data-dedup-id         `<file>@<ordinal>` — stable identity (see jsxwalk)
 *   data-dedup-component  enclosing component name
 *   data-dedup-dyn        "array" | "conditional" for map/branch roots
 *   data-dedup-core       "root" | "body" for component roots and <body>
 *
 * The last two let the overlay disable structural gestures (drag, delete) on
 * nodes the write-back would refuse anyway — the affordance is honest before
 * the user pulls on it, with no round-trip to the sidecar.
 *
 * Returns { code, map } or null when nothing was changed.
 */
export function tagCode(code, relFile) {
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
  walkJsx(ast.program, (node) => {
    const { opening } = node;
    // Anchor right after the last attribute (or the name/generics when there
    // are none) so spacing stays natural for both `>` and ` />` endings.
    const last = opening.attributes[opening.attributes.length - 1];
    const insertAt =
      last?.end ??
      opening.typeArguments?.end ??
      opening.typeParameters?.end ??
      opening.name.end;
    let attrs = ` data-dedup-id="${makeDedupId(relFile, node.index)}"`;
    if (node.component) attrs += ` data-dedup-component="${node.component}"`;
    if (node.dynamic) attrs += ` data-dedup-dyn="${node.dynamic}"`;
    if (node.core) attrs += ` data-dedup-core="${node.core}"`;
    s.appendLeft(insertAt, attrs);
    tagged++;
  });

  if (tagged === 0) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}
