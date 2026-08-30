// Shared HTML traversal — the single definition of "which elements dedup knows
// about in an .html file, in what order, and what may be done to each".
//
// This is the HTML twin of jsxwalk.mjs, and it exists for the same reason: an
// element's dedup id is its ORDINAL in this walk, so the stamper (which writes
// ids into the HTML the canvas loads) and the write-back (which resolves an id
// back to a source range) must agree byte-for-byte. Both import this. Never
// fork it — a second walk would be a second, silently incompatible identity
// scheme for one write-back.
//
// A plain HTML page is simpler than JSX in the way that matters: the file *is*
// the markup, so there is no `.map()` producing N instances from one node and
// no conditional branch that may or may not render. What survives from the JSX
// model is the honesty gate — which elements refuse to be moved or deleted.

import { parse, parseFragment } from "parse5";

/** The document skeleton — never removable, never movable. */
export const CORE_BODY = "body";

/** Tags that own the document's shape rather than its content. */
const SKELETON = new Set(["html", "head", "body"]);

/** HTML elements that cannot take children — never offered as drop targets. */
export const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Parse `html`, reporting HTML5 parse errors into `errors` when given.
 * `sourceCodeLocationInfo` is what makes ranged, formatting-preserving edits
 * possible at all — without it the write-back would have to re-serialize the
 * whole document and reflow the user's file.
 */
export function parseHtml(html, errors) {
  return parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: errors ? (e) => errors.push(e.code) : undefined,
  });
}

/** Parse a snippet in a body context (what the palette and AI produce). */
export function parseHtmlFragment(html, errors) {
  return parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: errors ? (e) => errors.push(e.code) : undefined,
  });
}

/**
 * Depth-first walk over every element written in the source, in document
 * order. `visit` receives one node record:
 *
 *   index      ordinal — the identity half of a dedup id
 *   node       the parse5 element node
 *   tag        lowercased tag name
 *   start/end  source offsets of the whole element (start tag → end tag)
 *   openEnd    offset just past the start tag — where attributes are appended
 *   attrs      { name: {startOffset, endOffset} } source ranges, lowercased
 *   core       CORE_BODY for <html>/<head>/<body>
 *   parent     the enclosing record, or null
 *   depth      nesting depth among walked elements
 *
 * Elements the parser *synthesized* (an implied <head>, a <body> the file
 * never wrote) carry no source location and are skipped: dedup can only edit
 * what the user actually typed, and stamping an id onto markup that has no
 * source range would be an id the write-back could never resolve.
 */
export function walkHtml(document, visit) {
  let index = 0;

  const walk = (node, ancestor) => {
    let nextAncestor = ancestor;
    const loc = node.sourceCodeLocation;
    if (node.tagName && loc && loc.startTag) {
      const tag = node.tagName.toLowerCase();
      const record = {
        index: index++,
        node,
        tag,
        start: loc.startOffset,
        end: loc.endOffset,
        openEnd: loc.startTag.endOffset,
        attrs: loc.attrs ?? {},
        line: loc.startLine,
        col: loc.startCol - 1,
        core: SKELETON.has(tag) ? CORE_BODY : null,
        parent: ancestor,
        depth: ancestor ? ancestor.depth + 1 : 0,
      };
      visit(record);
      nextAncestor = record;
    }
    // <template> holds its children in a separate document fragment.
    for (const child of node.content?.childNodes ?? node.childNodes ?? []) {
      walk(child, nextAncestor);
    }
  };

  walk(document, null);
}

/** Collect every node record in one pass (the write-back wants random access). */
export function collectHtml(document) {
  const nodes = [];
  walkHtml(document, (record) => nodes.push(record));
  return nodes;
}

/** The walk's tag sequence — the fingerprint the write-back's gate compares. */
export function tagSequence(document) {
  const tags = [];
  walkHtml(document, (r) => tags.push(`${r.depth}:${r.tag}`));
  return tags;
}

/** An element's attribute value as written, or null when it has none. */
export function attrValue(node, name) {
  const attr = node.attrs?.find((a) => a.name === name);
  return attr ? attr.value : null;
}
