// The HTML tagging transform — the one implementation, used by the static
// server on its way out to the canvas.
//
// Exactly parallel to tagcode.mjs on the JSX side, and for the same reason:
// an element's dedup id is its ORDINAL in the shared htmlwalk traversal, so
// the stamper and the write-back must walk identically. Both import
// htmlwalk.mjs; neither reimplements the traversal.
//
// Tags live only in the served HTML, never in the user's file.

import MagicString from "magic-string";
import { makeDedupId } from "./jsxwalk.mjs";
import { parseHtml, walkHtml, VOID_TAGS } from "./htmlwalk.mjs";

/**
 * Where an attribute can be appended inside a start tag: just before the `>`,
 * stepping back over a self-closing `/` and any whitespace so `<img src="x"/>`
 * stays `<img src="x" data-dedup-id="…"/>` rather than growing a stray space.
 */
function attrInsertPoint(code, openEnd) {
  let at = openEnd - 1;
  if (code[at] !== ">") return openEnd; // unterminated tag — never seen in practice
  while (at > 0 && /\s/.test(code[at - 1])) at--;
  if (code[at - 1] === "/") {
    at--;
    while (at > 0 && /\s/.test(code[at - 1])) at--;
  }
  return at;
}

/**
 * Insert dedup's tracking attributes into every element's start tag:
 *
 *   data-dedup-id    `<file>@<ordinal>` — stable identity (see htmlwalk)
 *   data-dedup-core  "body" for <html>/<head>/<body>
 *
 * The overlay reads the same attribute names the JSX tagger writes, so the
 * canvas has one selection model regardless of what produced the page. HTML
 * has no `.map()` and no conditional branch, so `data-dedup-dyn` never
 * applies here — its absence is the honest answer, not a missing feature.
 *
 * Returns the tagged HTML (unchanged input when there is nothing to tag).
 */
export function tagHtml(code, relFile) {
  const doc = parseHtml(code);
  const s = new MagicString(code);
  let tagged = 0;

  walkHtml(doc, (node) => {
    // A void element written with a closing tag would confuse the browser
    // more than the tag helps; stamp it anyway — attributes are safe on all
    // of them, and the ordinal must not skip.
    const at = attrInsertPoint(code, node.openEnd);
    let attrs = ` data-dedup-id="${makeDedupId(relFile, node.index)}"`;
    if (node.core) attrs += ` data-dedup-core="${node.core}"`;
    if (VOID_TAGS.has(node.tag)) attrs += ` data-dedup-void="1"`;
    s.appendLeft(at, attrs);
    tagged++;
  });

  return tagged === 0 ? code : s.toString();
}
