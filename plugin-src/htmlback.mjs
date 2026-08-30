// HTML write-back — the .html half of the write-back sidecar (writeback.mjs
// dispatches to it by file extension).
//
// It resolves a dedup id (`<file>@<ordinal>`, stamped by the static server
// through the shared htmlwalk traversal) to an element, reports what may
// safely be done to it, and applies the same edit program the JSX path takes:
// class, text, insert, remove, move. Every op resolves against ONE parse and
// applies as range operations on one magic-string, so formatting elsewhere in
// the file is untouched by construction and ops need no ordering.
//
// The trust gate is where HTML differs, and it is the reason this file is
// careful. A JSX write-back can re-parse its output and be told, definitively,
// that it broke the file. HTML5 has no such thing as invalid input: the parser
// is required to recover from anything, so `<div class="a><p>x</p></div>` is
// not an error — it is a `<div>` with a very long class attribute that ate the
// paragraph. Re-parsing alone would wave that through. So the gate here is
// structural: the output's element tree must be *exactly* what the program
// said it would be — the same tags at the same depths for a content-only
// edit, and the exact expected element count when the program adds or removes
// elements — and the output may introduce no HTML5 parse error the input did
// not already have.

import MagicString from "magic-string";
import fs from "node:fs";
import {
  collectHtml,
  parseHtml,
  parseHtmlFragment,
  tagSequence,
  VOID_TAGS,
} from "./htmlwalk.mjs";
import {
  indentAt,
  lineEndOf,
  lineStartOf,
  ownsLine,
  reindent,
  removalRange,
} from "./srcedit.mjs";

// A class attribute stays a plain single-line string; anything else is refused.
const SAFE_CLASS_RE = /^[^"'`<>\\\n\r]*$/;
// Text is written between tags, so anything that could open one is refused.
const SAFE_TEXT_RE = /^[^<>\\\r\n]*$/;

/** Ordinal → node record, plus the parse errors the file already has. */
function readDoc(code) {
  const errors = [];
  const doc = parseHtml(code, errors);
  return { doc, nodes: collectHtml(doc), errors };
}

function nodeAt(nodes, index) {
  const node = nodes[index];
  if (node && node.index === index) return node;
  return nodes.find((n) => n.index === index) ?? null;
}

/** Where an attribute can be appended inside a start tag (see htmltag.mjs). */
function attrInsertPoint(code, openEnd) {
  let at = openEnd - 1;
  if (code[at] !== ">") return openEnd;
  while (at > 0 && /\s/.test(code[at - 1])) at--;
  if (code[at - 1] === "/") {
    at--;
    while (at > 0 && /\s/.test(code[at - 1])) at--;
  }
  return at;
}

/**
 * Where and how the element's `class` attribute can be read/edited.
 *
 * parse5 gives the range of the whole attribute (`class="flex gap-2"`); the
 * value inside it is found by hand because that is the only part an edit may
 * touch — rewriting the attribute name or its quoting is never what a style
 * change means.
 */
function classInfo(node, code) {
  const loc = node.attrs?.class;
  if (!loc) {
    return {
      editable: true,
      className: "",
      mode: "insert",
      insertAt: attrInsertPoint(code, node.openEnd),
    };
  }
  const raw = code.slice(loc.startOffset, loc.endOffset);
  const eq = raw.indexOf("=");
  if (eq === -1) {
    // Bare `class` with no value — give it one rather than editing nothing.
    return {
      editable: true,
      className: "",
      mode: "valueless",
      insertAt: loc.endOffset,
    };
  }
  let i = eq + 1;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  const quote = raw[i];
  if (quote === '"' || quote === "'") {
    const close = raw.lastIndexOf(quote);
    if (close <= i) {
      return { editable: false, className: null, reason: "unterminated class attribute" };
    }
    return {
      editable: true,
      className: raw.slice(i + 1, close),
      mode: "replace",
      start: loc.startOffset + i + 1,
      end: loc.startOffset + close,
    };
  }
  // Unquoted value (`class=card`) — legal HTML, and editable in place.
  return {
    editable: true,
    className: raw.slice(i),
    mode: "replace",
    start: loc.startOffset + i,
    end: loc.endOffset,
  };
}

/** Non-whitespace child nodes, in source order. */
function contentChildren(node) {
  return (node.node.childNodes ?? []).filter((c) => {
    if (c.nodeName === "#text") return (c.value ?? "").trim() !== "";
    if (c.nodeName === "#comment") return false;
    return true;
  });
}

/**
 * The element's static text, when its children are exactly one text node (or
 * nothing). Anything richer — nested elements — is reported as not
 * text-editable rather than silently flattened.
 */
function textInfo(node) {
  const endTag = node.node.sourceCodeLocation?.endTag;
  if (VOID_TAGS.has(node.tag)) {
    return { editable: false, text: null, reason: "void element — it has no content" };
  }
  if (!endTag) {
    return {
      editable: false,
      text: null,
      reason: "the element has no closing tag in the source",
    };
  }
  const kids = contentChildren(node);
  if (kids.length === 0) {
    return { editable: true, text: "", start: node.openEnd, end: endTag.startOffset };
  }
  if (kids.length === 1 && kids[0].nodeName === "#text") {
    const loc = kids[0].sourceCodeLocation;
    if (!loc) return { editable: false, text: null, reason: "text has no source range" };
    return {
      editable: true,
      text: (kids[0].value ?? "").trim(),
      start: loc.startOffset,
      end: loc.endOffset,
    };
  }
  return { editable: false, text: null, reason: "element has child elements" };
}

/**
 * What structural edits this node admits, and why not when it doesn't — the
 * honesty gate the overlay reads before it offers a gesture.
 *
 * Unlike JSX there is no `.map()` root and no conditional branch here, so the
 * only elements that refuse to move are the document's own skeleton.
 */
function capabilities(node) {
  const structuralBlock = node.core ? "part of the document skeleton" : null;
  const text = textInfo(node);
  const endTag = node.node.sourceCodeLocation?.endTag;
  return {
    canRemove: structuralBlock === null,
    canMove: structuralBlock === null,
    structuralReason: structuralBlock && `this element is ${structuralBlock}`,
    canAcceptChildren: !VOID_TAGS.has(node.tag) && Boolean(endTag),
    canEditText: text.editable,
    textReason: text.reason ?? null,
    text: text.text,
  };
}

export function inspectHtml({ file, index }) {
  const code = fs.readFileSync(file, "utf8");
  const { nodes } = readDoc(code);
  const node = nodeAt(nodes, index);
  if (!node) {
    return {
      ok: false,
      error: `no element #${index} — source may have changed since tagging`,
    };
  }
  const info = classInfo(node, code);
  return {
    ok: true,
    editable: info.editable,
    className: info.className,
    reason: info.reason ?? null,
    line: node.line,
    col: node.col,
    tag: node.tag,
    // A plain HTML page has no components to belong to; the page it lives on
    // is the honest answer to "where am I".
    component: null,
    dynamic: null,
    core: node.core,
    parentIndex: node.parent ? node.parent.index : null,
    ...capabilities(node),
  };
}

// --- edit program -------------------------------------------------------------

/**
 * Where a child lands relative to `target`, as an insertion offset and the
 * exact text to place there. Elements that own their line get a line of their
 * own; inline elements stay inline. `position` is before | after | inside.
 */
function insertionPoint(code, target, position) {
  const outer = indentAt(code, target.start);
  const owns = ownsLine(code, target.start);

  if (position === "before") {
    return owns
      ? { at: lineStartOf(code, target.start), indent: outer, wrap: (b) => outer + b + "\n" }
      : { at: target.start, indent: outer, wrap: (b) => b + " " };
  }

  if (position === "after") {
    const trailing = code.slice(target.end, lineEndOf(code, target.end));
    return owns && trailing.trim() === ""
      ? { at: lineEndOf(code, target.end), indent: outer, wrap: (b) => outer + b + "\n" }
      : { at: target.end, indent: outer, wrap: (b) => " " + b };
  }

  // inside — as the last child, one level deeper than the target.
  const endTag = target.node.sourceCodeLocation?.endTag;
  if (!endTag) return null;
  const indent = outer + "  ";
  const closingStart = lineStartOf(code, endTag.startOffset);
  if (code.slice(closingStart, endTag.startOffset).trim() === "") {
    // Closing tag has its own line — slot the child in above it.
    return { at: closingStart, indent, outer, wrap: (b) => indent + b + "\n" };
  }
  return {
    at: endTag.startOffset,
    indent,
    outer,
    wrap: (b) => "\n" + indent + b + "\n" + outer,
  };
}

/**
 * A snippet must be exactly one element and must parse to exactly that — the
 * palette's markup and anything the editor generates goes through here before
 * it can reach a source file. Returns the element count so the structural gate
 * knows what the program is about to add.
 */
function validateSnippet(snippet) {
  if (typeof snippet !== "string" || snippet.trim() === "") {
    return { error: "empty snippet" };
  }
  if (snippet.length > 4000) return { error: "snippet too large" };
  const errors = [];
  const frag = parseHtmlFragment(snippet.trim(), errors);
  if (errors.length) {
    return { error: `snippet does not parse cleanly: ${[...new Set(errors)].join(", ")}` };
  }
  const kids = (frag.childNodes ?? []).filter(
    (c) => !(c.nodeName === "#text" && (c.value ?? "").trim() === ""),
  );
  if (kids.length !== 1 || !kids[0].tagName) {
    return { error: "snippet must be exactly one HTML element" };
  }
  // An unclosed snippet (`<div>`) is well-formed input to an HTML5 parser and
  // a disaster in a file: dropped in, it swallows every sibling after it into
  // its own subtree. Nothing downstream would notice — the element count is
  // still right — so it is refused here, where the intent is still visible.
  const root = kids[0];
  if (!VOID_TAGS.has(root.tagName.toLowerCase()) && !root.sourceCodeLocation?.endTag) {
    return { error: `snippet's <${root.tagName}> is never closed` };
  }
  let count = 0;
  const walk = (n) => {
    if (n.tagName) count++;
    for (const c of n.content?.childNodes ?? n.childNodes ?? []) walk(c);
  };
  walk(frag);
  return { code: snippet.trim(), elements: count };
}

/**
 * The element at `index`, verbatim, as a snippet the insert op can take back —
 * the read half of cut/copy/paste, and the HTML twin of `copy` in
 * writeback.mjs. De-indented to zero because that is the shape `insert`
 * expects, and passed through the same `validateSnippet` the paste will: a
 * snippet that could never be written back does not belong on a clipboard.
 *
 * `refs` is always empty here and that is not an oversight. A JSX snippet can
 * carry names its new file has to already have; markup carries nothing but
 * itself.
 */
export function copyHtml({ file, index }) {
  const code = fs.readFileSync(file, "utf8");
  const { nodes } = readDoc(code);
  const node = nodeAt(nodes, index);
  if (!node) {
    return {
      ok: false,
      error: `no element #${index} — source may have changed since tagging`,
    };
  }
  if (node.core) {
    return { ok: false, error: "copy: this element is part of the document skeleton" };
  }
  const raw = code.slice(node.start, node.end);
  const snippet = validateSnippet(reindent(raw, indentAt(code, node.start), ""));
  if (snippet.error) return { ok: false, error: `copy: ${snippet.error}` };
  return {
    ok: true,
    lang: "html",
    snippet: snippet.code,
    tag: node.tag,
    component: null,
    refs: [],
    // See the JSX half: the ordinals inside the copy, so the editor can tell
    // the user when they have staged edits in there that it did not take.
    contains: nodes
      .filter((n) => n.start >= node.start && n.end <= node.end)
      .map((n) => n.index),
  };
}

/** Every walked node inside `node`'s source range, itself included. */
function subtreeCount(nodes, node) {
  return nodes.filter((n) => n.start >= node.start && n.end <= node.end).length;
}

/**
 * Parse-error codes the output introduced that the input did not have.
 * Comparing counts, not just presence: a second unterminated tag in a file
 * that already had one is still damage this edit did.
 */
function newParseErrors(before, after) {
  const tally = (list) => {
    const m = new Map();
    for (const c of list) m.set(c, (m.get(c) ?? 0) + 1);
    return m;
  };
  const a = tally(before);
  const introduced = [];
  for (const [code, n] of tally(after)) {
    if (n > (a.get(code) ?? 0)) introduced.push(code);
  }
  return introduced;
}

export function applyHtml({ file, ops }) {
  const code = fs.readFileSync(file, "utf8");
  const { doc, nodes, errors: before } = readDoc(code);
  const s = new MagicString(code);
  const failures = [];

  const resolve = (index, what) => {
    const node = nodeAt(nodes, index);
    if (!node) failures.push(`${what}: element #${index} not found — source changed?`);
    return node;
  };

  const list = Array.isArray(ops) ? ops : [];
  const moves = list.filter((o) => o.op === "move");
  // What this program deletes, resolved up front so an insert is refused
  // whichever order the two ops arrive in — see the JSX write-back for why a
  // cut-then-paste in one program needs it.
  const removedIndexes = new Set();
  const removedRanges = [];
  for (const op of list) {
    if (op.op !== "remove") continue;
    const node = nodeAt(nodes, op.index);
    if (!node) continue;
    removedIndexes.add(node.index);
    removedRanges.push(removalRange(code, node.start, node.end));
  }
  const inRemovedRange = (pos) =>
    removedRanges.some((r) => pos >= r.start && pos <= r.end);
  let expectedDelta = 0;
  let structural = false;

  // Ranges whose content is relocated wholesale. Content ops inside them are
  // applied to the captured text instead of the outer string.
  const movedRanges = [];
  for (const op of moves) {
    const node = resolve(op.index, "move");
    if (!node) continue;
    movedRanges.push({ op, node, start: node.start, end: node.end });
  }
  for (let i = 0; i < movedRanges.length; i++) {
    for (let j = i + 1; j < movedRanges.length; j++) {
      const a = movedRanges[i];
      const b = movedRanges[j];
      if (a.start < b.end && b.start < a.end) {
        failures.push("move: cannot move two elements that contain each other in one save");
      }
    }
  }

  const inMovedRange = (pos) =>
    movedRanges.find((r) => pos >= r.start && pos < r.end) ?? null;

  for (const r of movedRanges) r.text = new MagicString(code.slice(r.start, r.end));

  /** Route a range edit to the outer string or the moved block that owns it. */
  const edit = (start, end, value) => {
    const owner = inMovedRange(start);
    if (owner) {
      if (end > owner.end) {
        failures.push("edit spans the boundary of a moved element");
        return;
      }
      if (start === end) owner.text.appendLeft(start - owner.start, value);
      else owner.text.overwrite(start - owner.start, end - owner.start, value);
      return;
    }
    if (start === end) s.appendLeft(start, value);
    else s.overwrite(start, end, value);
  };

  const removed = [];

  for (const op of list) {
    switch (op.op) {
      case "class": {
        const node = resolve(op.index, "class");
        if (!node) break;
        if (typeof op.className !== "string" || !SAFE_CLASS_RE.test(op.className)) {
          failures.push(`class #${op.index}: refusing unsafe class string`);
          break;
        }
        const info = classInfo(node, code);
        if (!info.editable) {
          failures.push(`class #${op.index}: not editable (${info.reason})`);
          break;
        }
        const value = op.className.trim().replace(/\s+/g, " ");
        if (info.mode === "insert") {
          if (value !== "") edit(info.insertAt, info.insertAt, ` class="${value}"`);
        } else if (info.mode === "valueless") {
          edit(info.insertAt, info.insertAt, `="${value}"`);
        } else {
          edit(info.start, info.end, value);
        }
        break;
      }

      case "text": {
        const node = resolve(op.index, "text");
        if (!node) break;
        if (typeof op.text !== "string" || !SAFE_TEXT_RE.test(op.text)) {
          failures.push(`text #${op.index}: refusing unsafe text`);
          break;
        }
        const info = textInfo(node);
        if (!info.editable) {
          failures.push(`text #${op.index}: not editable (${info.reason})`);
          break;
        }
        edit(info.start, info.end, op.text);
        break;
      }

      case "remove": {
        const node = resolve(op.index, "remove");
        if (!node) break;
        const caps = capabilities(node);
        if (!caps.canRemove) {
          failures.push(`remove #${op.index}: ${caps.structuralReason}`);
          break;
        }
        if (inMovedRange(node.start)) {
          failures.push(`remove #${op.index}: element is inside an element being moved`);
          break;
        }
        // Nested removals would double-count against the structural gate and
        // overlap on the magic-string; one of them already does the job.
        if (removed.some((r) => node.start >= r.start && node.end <= r.end)) {
          failures.push(
            `remove #${op.index}: element is inside another element being removed`,
          );
          break;
        }
        const range = removalRange(code, node.start, node.end);
        removed.push({ start: node.start, end: node.end });
        expectedDelta -= subtreeCount(nodes, node);
        structural = true;
        s.remove(range.start, range.end);
        break;
      }

      case "insert": {
        const target = resolve(op.target, "insert");
        if (!target) break;
        const snippet = validateSnippet(op.snippet);
        if (snippet.error) {
          failures.push(`insert: ${snippet.error}`);
          break;
        }
        if (op.position === "inside" && !capabilities(target).canAcceptChildren) {
          failures.push(`insert: <${target.tag}> cannot take children`);
          break;
        }
        if (removedIndexes.has(target.index)) {
          failures.push("insert: the element it is placed against is being deleted");
          break;
        }
        const point = insertionPoint(code, target, op.position);
        if (!point) {
          failures.push(`insert: <${target.tag}> has no place to put a child`);
          break;
        }
        if (inRemovedRange(point.at)) {
          failures.push("insert: destination is inside an element being deleted");
          break;
        }
        // Snippet lines carry no base indentation of their own.
        s.appendRight(point.at, point.wrap(reindent(snippet.code, "", point.indent)));
        expectedDelta += snippet.elements;
        structural = true;
        break;
      }

      case "move":
        break; // handled below, after content edits are routed

      default:
        failures.push(`unknown op: ${op.op}`);
    }
  }

  // Moves last: their content is now final (nested edits applied), and the
  // destination offsets still refer to the original text.
  for (const r of movedRanges) {
    const target = resolve(r.op.target, "move");
    if (!target) continue;
    const node = r.node;
    const caps = capabilities(node);
    if (!caps.canMove) {
      failures.push(`move #${node.index}: ${caps.structuralReason}`);
      continue;
    }
    if (target.index === node.index) {
      failures.push("move: an element cannot be moved relative to itself");
      continue;
    }
    if (target.start >= node.start && target.end <= node.end) {
      failures.push("move: an element cannot be moved inside itself");
      continue;
    }
    if (r.op.position === "inside" && !capabilities(target).canAcceptChildren) {
      failures.push(`move: <${target.tag}> cannot take children`);
      continue;
    }
    const point = insertionPoint(code, target, r.op.position);
    if (!point) {
      failures.push(`move: <${target.tag}> has no place to put a child`);
      continue;
    }
    const range = removalRange(code, node.start, node.end);
    if (point.at > range.start && point.at < range.end) {
      failures.push("move: destination is inside the element being moved");
      continue;
    }
    const body = reindent(r.text.toString(), indentAt(code, node.start), point.indent);
    s.remove(range.start, range.end);
    // appendRight, not appendLeft: the chunk to the left may be the one this
    // same program just removed, and content appended to a removed chunk is
    // dropped. The chunk to the right is the surviving anchor.
    s.appendRight(point.at, point.wrap(body));
    structural = true;
  }

  if (failures.length > 0) return { ok: false, error: failures.join("; ") };

  const output = s.toString();
  if (output === code) return { ok: true, changed: false };

  // --- trust gate -----------------------------------------------------------
  // HTML5 never rejects input, so "it still parses" proves nothing. What the
  // output has to match is the *structure the program described*.
  const after = [];
  const outDoc = parseHtml(output, after);

  const introduced = newParseErrors(before, after);
  if (introduced.length) {
    return {
      ok: false,
      error: `edit would break the markup (${[...new Set(introduced)].join(", ")}), aborted`,
    };
  }

  const expected = nodes.length + expectedDelta;
  const outNodes = collectHtml(outDoc);
  if (outNodes.length !== expected) {
    return {
      ok: false,
      error:
        `edit would change the page structure unexpectedly ` +
        `(${outNodes.length} elements, expected ${expected}), aborted`,
    };
  }
  if (!structural) {
    // A class or text edit must not move a single tag. Comparing depth+tag in
    // walk order catches an attribute value that swallowed the markup after it.
    const beforeTags = tagSequence(doc);
    const afterTags = tagSequence(outDoc);
    const drift = beforeTags.findIndex((t, i) => t !== afterTags[i]);
    if (drift !== -1) {
      return {
        ok: false,
        error: `edit would restructure the page at <${beforeTags[drift].split(":")[1]}>, aborted`,
      };
    }
  }

  fs.writeFileSync(file, output);
  return { ok: true, changed: true };
}

/**
 * Full-file replacement (AI chat edits). The content is model output, so the
 * gate is strict: the only HTML5 parse error tolerated is a missing doctype,
 * and the result must actually contain markup.
 */
export function validateHtmlContent(content) {
  const errors = [];
  const doc = parseHtml(content, errors);
  const real = errors.filter((c) => c !== "missing-doctype");
  if (real.length) {
    return {
      ok: false,
      error: `new content is malformed HTML (${[...new Set(real)].join(", ")}), aborted`,
    };
  }
  if (collectHtml(doc).length === 0) {
    return { ok: false, error: "new content has no HTML elements, aborted" };
  }
  return { ok: true };
}
