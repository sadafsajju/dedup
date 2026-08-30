// dedup write-back — resolves a dedup id (`<file>@<ordinal>`, stamped by the
// tagger through the shared jsxwalk traversal) to a JSX node, reports what may
// safely be done to it, and applies an edit program: className rewrites,
// static text, insert, remove, and move/reparent (FR-4.1, FR-4.2).
//
// Runs as a one-shot node process: JSON in on stdin, one JSON line out on
// stdout. Bundled self-contained; nothing is required from the user's
// node_modules.
//
// Every op in a program is resolved against ONE parse and applied as range
// operations on one magic-string, so formatting everywhere else in the file is
// untouched by construction and ops need no ordering. The output is re-parsed
// before the file is written — a program that would corrupt the file writes
// nothing (PRD §6).

import { parse } from "@babel/parser";
import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import { collectJsx } from "./jsxwalk.mjs";
import {
  CONTEXT_FILE_RE,
  MAX_FILE_BYTES,
  discoverFiles,
  relOf,
} from "./files.mjs";
import {
  indentAt,
  lineEndOf,
  lineStartOf,
  ownsLine,
  reindent,
  removalRange,
} from "./srcedit.mjs";
import { discoverRoutes } from "./routes.mjs";
import { applyHtml, copyHtml, inspectHtml, validateHtmlContent } from "./htmlback.mjs";

// className must stay a plain single-line string; anything else is refused.
const SAFE_CLASS_RE = /^[^"'`\\\n\r]*$/;
// Static text likewise: no braces (would read as a JSX expression), no tags.
const SAFE_TEXT_RE = /^[^<>{}\\\r\n]*$/;

/** HTML elements that cannot take children — never offered as drop targets. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function parseSource(code) {
  return parse(code, {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "decorators-legacy"],
  });
}

/** Ordinal → node record, from one parse. Shared by inspect and apply. */
function nodesOf(code) {
  return collectJsx(parseSource(code).program);
}

function dynamicReason(expr) {
  switch (expr.type) {
    case "CallExpression": {
      const callee = expr.callee.type === "Identifier" ? expr.callee.name : "call";
      return `computed by ${callee}(…)`;
    }
    case "Identifier":
      return `computed from variable \`${expr.name}\``;
    case "ConditionalExpression":
      return "computed by a conditional";
    case "TemplateLiteral":
      return "template with dynamic parts";
    case "MemberExpression":
      return "computed from an object property";
    default:
      return `dynamic (${expr.type})`;
  }
}

/** Where and how the element's className can be read/edited. */
function classInfo(opening) {
  const attr = opening.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name?.name === "className",
  );
  if (!attr) {
    // No attribute — we can add one right after the tag name/generics.
    const insertAt =
      opening.typeArguments?.end ?? opening.typeParameters?.end ?? opening.name.end;
    return { editable: true, className: "", mode: "insert", insertAt };
  }
  const v = attr.value;
  if (!v) {
    return { editable: false, className: null, reason: "className has no value" };
  }
  if (v.type === "StringLiteral") {
    return {
      editable: true,
      className: v.value,
      mode: "replace",
      start: v.start + 1,
      end: v.end - 1,
    };
  }
  if (v.type === "JSXExpressionContainer") {
    const e = v.expression;
    if (e.type === "StringLiteral") {
      return {
        editable: true,
        className: e.value,
        mode: "replace",
        start: e.start + 1,
        end: e.end - 1,
      };
    }
    if (e.type === "TemplateLiteral" && e.expressions.length === 0) {
      const q = e.quasis[0];
      return {
        editable: true,
        className: q.value.cooked ?? q.value.raw,
        mode: "replace",
        start: q.start,
        end: q.end,
      };
    }
    return { editable: false, className: null, reason: dynamicReason(e) };
  }
  return { editable: false, className: null, reason: "unsupported className form" };
}

/** Tag name as written in source (`Foo`, `Foo.Bar`, `div`). */
function tagNameOf(opening, code) {
  return code.slice(opening.name.start, opening.name.end);
}

/**
 * The element's static text, when its children are exactly one JSXText (or
 * nothing). Anything richer — nested elements, `{expressions}` — is reported
 * as not text-editable rather than silently flattened.
 */
function textInfo(element) {
  const kids = element.children.filter(
    (c) => !(c.type === "JSXText" && c.value.trim() === ""),
  );
  if (kids.length === 0) {
    if (element.openingElement.selfClosing) {
      return { editable: false, text: null, reason: "self-closing element" };
    }
    return {
      editable: true,
      text: "",
      start: element.openingElement.end,
      end: element.closingElement.start,
    };
  }
  if (kids.length === 1 && kids[0].type === "JSXText") {
    return {
      editable: true,
      text: kids[0].value.trim(),
      start: kids[0].start,
      end: kids[0].end,
    };
  }
  return {
    editable: false,
    text: null,
    reason: kids.some((k) => k.type === "JSXExpressionContainer")
      ? "text comes from an expression"
      : "element has child elements",
  };
}

const DYNAMIC_LABEL = {
  array: "an item rendered from a list (.map)",
  conditional: "a conditionally rendered branch",
};

/**
 * What structural edits this node admits, and why not when it doesn't.
 * This is the honesty gate for the canvas: the overlay disables gestures the
 * write-back would refuse, so an affordance never lies about what it will do.
 */
function capabilities(node, code) {
  const structuralBlock =
    node.core === "body"
      ? "the document body"
      : node.core === "root"
        ? "the component's root element"
        : node.dynamic
          ? DYNAMIC_LABEL[node.dynamic]
          : !node.parent
            ? "not inside another element in this file"
            : null;

  const tag = tagNameOf(node.opening, code);
  const text = textInfo(node.element);
  return {
    canRemove: structuralBlock === null,
    canMove: structuralBlock === null,
    structuralReason: structuralBlock && `this element is ${structuralBlock}`,
    // Children can be added to anything that isn't a void HTML tag; a
    // self-closing custom element is expanded to a pair when we insert.
    canAcceptChildren: !VOID_TAGS.has(tag),
    canEditText: text.editable,
    textReason: text.reason ?? null,
    text: text.text,
  };
}

function nodeAt(nodes, index) {
  const node = nodes[index];
  if (!node) return null;
  return node.index === index ? node : nodes.find((n) => n.index === index) ?? null;
}

function inspect({ file, index }) {
  const code = fs.readFileSync(file, "utf8");
  const nodes = nodesOf(code);
  const node = nodeAt(nodes, index);
  if (!node) {
    return {
      ok: false,
      error: `no JSX element #${index} — source may have changed since tagging`,
    };
  }
  const info = classInfo(node.opening);
  const caps = capabilities(node, code);
  const { line, column } = node.opening.loc.start;
  return {
    ok: true,
    editable: info.editable,
    className: info.className,
    reason: info.reason ?? null,
    // Position is derived here, never carried in the id: this is always the
    // live location, even after earlier saves shifted the file.
    line,
    col: column,
    tag: tagNameOf(node.opening, code),
    component: node.component,
    dynamic: node.dynamic,
    core: node.core,
    parentIndex: node.parent ? node.parent.index : null,
    ...caps,
  };
}

// --- copy (the read half of cut/copy/paste) ---------------------------------

/**
 * Names a snippet carries out of its file with it: components it renders and
 * variables its expressions read. A copied `<Card title={title} />` needs both
 * `Card` and `title` wherever it lands, and neither travels with the markup.
 *
 * Deliberately one-sided. This is used to warn, never to rewrite: the caller
 * checks whether the destination file mentions each name at all, and a name it
 * has never heard of is proof the paste would break. Presence proves nothing
 * (a same-named local is not the same binding) and is treated as fine — the
 * honest gate is the one that only fires when it is certainly right.
 */
const KNOWN_GLOBALS = new Set([
  "Array", "Boolean", "Date", "Error", "Infinity", "Intl", "JSON", "Math",
  "NaN", "Number", "Object", "Promise", "React", "RegExp", "String", "Symbol",
  "console", "document", "globalThis", "navigator", "undefined", "window",
]);

/** Depth-first walk of a babel subtree. `visit` returning false means it took
 *  care of that node's children itself. */
function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (typeof node.type !== "string") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }
    walkAst(node[key], visit);
  }
}

function referencedNames(element) {
  const used = new Set();
  const bound = new Set();
  const visit = (n) => {
    switch (n.type) {
      // A closing tag repeats the name the opening tag already reported.
      case "JSXClosingElement":
      case "JSXClosingFragment":
        return false;
      case "JSXOpeningElement": {
        let name = n.name;
        while (name && name.type === "JSXMemberExpression") name = name.object;
        // Lowercase is an HTML tag; capitalised is a component the
        // destination file has to have imported.
        if (name?.type === "JSXIdentifier" && /^[A-Z]/.test(name.name)) {
          used.add(name.name);
        }
        walkAst(n.attributes, visit);
        return false;
      }
      // An attribute's *name* is not a reference; its value is.
      case "JSXAttribute":
        walkAst(n.value, visit);
        return false;
      // `a.b` reads `a`; `b` is a property, not a binding.
      case "MemberExpression":
      case "OptionalMemberExpression":
        walkAst(n.object, visit);
        if (n.computed) walkAst(n.property, visit);
        return false;
      case "ObjectProperty":
        if (n.computed) walkAst(n.key, visit);
        walkAst(n.value, visit);
        return false;
      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        // Names the snippet binds for itself — `items.map((item) => …)` does
        // not need an `item` at the destination.
        walkAst(n.params, (p) => {
          if (p.type === "Identifier") bound.add(p.name);
        });
        return;
      }
      case "Identifier":
        if (!KNOWN_GLOBALS.has(n.name)) used.add(n.name);
        return false;
      default:
        return;
    }
  };
  walkAst(element, visit);
  return [...used].filter((n) => !bound.has(n)).sort();
}

/**
 * The element at `index`, verbatim, as a snippet that can be inserted
 * somewhere else — the read half of cut/copy/paste.
 *
 * Verbatim is the point: the user copies what their file says, not a
 * re-print of it, so a paste lands the same markup they were looking at. It
 * is de-indented to zero here because that is the shape `insert` expects (it
 * re-indents for wherever the snippet is going), and it goes through the same
 * `validateSnippet` the paste will — a snippet that could never be written
 * back has no business sitting on a clipboard pretending it could.
 */
function copy({ file, index }) {
  const code = fs.readFileSync(file, "utf8");
  const nodes = nodesOf(code);
  const node = nodeAt(nodes, index);
  if (!node) {
    return {
      ok: false,
      error: `no JSX element #${index} — source may have changed since tagging`,
    };
  }
  const raw = code.slice(node.element.start, node.element.end);
  const snippet = validateSnippet(reindent(raw, indentAt(code, node.element.start), ""));
  if (snippet.error) return { ok: false, error: `copy: ${snippet.error}` };
  return {
    ok: true,
    lang: "jsx",
    snippet: snippet.code,
    tag: tagNameOf(node.opening, code),
    component: node.component,
    refs: referencedNames(node.element),
    // Every ordinal the copy swallowed, itself included. The editor copies
    // the *file's* text, and this is what lets it notice that the user has
    // staged edits inside the thing they just copied — which the file does
    // not know about, and the copy therefore does not carry.
    contains: nodes
      .filter(
        (n) =>
          n.element.start >= node.element.start && n.element.end <= node.element.end,
      )
      .map((n) => n.index),
  };
}

// --- edit program -----------------------------------------------------------

/**
 * Where a child lands relative to `target`, as an insertion offset and the
 * exact text to place there. Elements that own their line get a line of their
 * own; inline elements stay inline. `position` is before | after | inside.
 *
 * Returns null when the placement is impossible (an `inside` with nowhere to
 * go), so callers can report a reason instead of writing something broken.
 */
function insertionPoint(code, target, position) {
  const element = target.element;
  const opening = target.opening;
  const outer = indentAt(code, element.start);
  const owns = ownsLine(code, element.start);

  if (position === "before") {
    return owns
      ? { at: lineStartOf(code, element.start), indent: outer, wrap: (b) => outer + b + "\n" }
      : { at: element.start, indent: outer, wrap: (b) => b + " " };
  }

  if (position === "after") {
    const trailing = code.slice(element.end, lineEndOf(code, element.end));
    return owns && trailing.trim() === ""
      ? {
          at: lineEndOf(code, element.end),
          indent: outer,
          wrap: (b) => outer + b + "\n",
        }
      : { at: element.end, indent: outer, wrap: (b) => " " + b };
  }

  // inside — as the last child, one level deeper than the target.
  const indent = outer + "  ";
  if (opening.selfClosing) {
    return { at: null, indent, outer, expandSelfClosing: true };
  }
  const closing = element.closingElement;
  if (!closing) return null;
  const closingStart = lineStartOf(code, closing.start);
  if (code.slice(closingStart, closing.start).trim() === "") {
    // Closing tag has its own line — slot the child in above it.
    return { at: closingStart, indent, outer, wrap: (b) => indent + b + "\n" };
  }
  return {
    at: closing.start,
    indent,
    outer,
    wrap: (b) => "\n" + indent + b + "\n" + outer,
  };
}

/**
 * Apply an edit program to one file. Ops:
 *   { op:"class",  index, className }
 *   { op:"text",   index, text }
 *   { op:"remove", index }
 *   { op:"insert", target, position, snippet }
 *   { op:"move",   index, target, position }
 *
 * Move is implemented as capture → delete → re-insert rather than a chunk
 * move, so (a) the block is re-indented for its new depth and (b) class/text
 * ops targeting nodes *inside* the moved subtree still land — a drag followed
 * by a padding tweak is one save, not a conflict.
 */
function apply({ file, ops }) {
  const code = fs.readFileSync(file, "utf8");
  const nodes = nodesOf(code);
  const s = new MagicString(code);
  const failures = [];

  const resolve = (index, what) => {
    const node = nodeAt(nodes, index);
    if (!node) failures.push(`${what}: element #${index} not found — source changed?`);
    return node;
  };

  const list = Array.isArray(ops) ? ops : [];
  const moves = list.filter((o) => o.op === "move");

  // What this program deletes, resolved up front so an insert can be refused
  // whichever order the two ops arrive in. Cut-then-paste puts both in one
  // program, and appending into a chunk that is on its way out drops the
  // content silently — the one failure a paste must never have.
  const removedIndexes = new Set();
  const removedRanges = [];
  for (const op of list) {
    if (op.op !== "remove") continue;
    const node = nodeAt(nodes, op.index);
    if (!node) continue;
    removedIndexes.add(node.index);
    removedRanges.push(removalRange(code, node.element.start, node.element.end));
  }
  // Inclusive of both ends: an insertion point sitting exactly on a removed
  // chunk's boundary belongs to that chunk as far as magic-string is concerned.
  const inRemovedRange = (pos) =>
    removedRanges.some((r) => pos >= r.start && pos <= r.end);

  // Ranges whose content is relocated wholesale. Content ops inside them are
  // applied to the captured text instead of the outer string.
  const movedRanges = [];
  for (const op of moves) {
    const node = resolve(op.index, "move");
    if (!node) continue;
    movedRanges.push({ op, node, start: node.element.start, end: node.element.end });
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

  // Nested magic-strings for moved blocks, so edits inside them survive.
  for (const r of movedRanges) {
    r.text = new MagicString(code.slice(r.start, r.end));
  }

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

  for (const op of list) {
    switch (op.op) {
      case "class": {
        const node = resolve(op.index, "class");
        if (!node) break;
        if (typeof op.className !== "string" || !SAFE_CLASS_RE.test(op.className)) {
          failures.push(`class #${op.index}: refusing unsafe class string`);
          break;
        }
        const info = classInfo(node.opening);
        if (!info.editable) {
          failures.push(`class #${op.index}: not editable (${info.reason})`);
          break;
        }
        const value = op.className.trim().replace(/\s+/g, " ");
        if (info.mode === "insert") {
          if (value !== "") edit(info.insertAt, info.insertAt, ` className="${value}"`);
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
        const info = textInfo(node.element);
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
        const caps = capabilities(node, code);
        if (!caps.canRemove) {
          failures.push(`remove #${op.index}: ${caps.structuralReason}`);
          break;
        }
        const range = removalRange(code, node.element.start, node.element.end);
        if (inMovedRange(range.start)) {
          failures.push(`remove #${op.index}: element is inside an element being moved`);
          break;
        }
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
        if (removedIndexes.has(target.index)) {
          failures.push("insert: the element it is placed against is being deleted");
          break;
        }
        const point = insertionPoint(code, target, op.position);
        if (point && op.position === "inside" && !capabilities(target, code).canAcceptChildren) {
          failures.push(`insert: <${tagNameOf(target.opening, code)}> cannot take children`);
          break;
        }
        if (point?.at != null && inRemovedRange(point.at)) {
          failures.push("insert: destination is inside an element being deleted");
          break;
        }
        // Snippet lines carry no base indentation of their own.
        const body = point ? reindent(snippet.code, "", point.indent) : snippet.code;
        place(s, code, target, point, body, failures, "insert");
        break;
      }

      case "move":
        break; // handled below, after content edits are routed

      default:
        failures.push(`unknown op: ${op.op}`);
    }
  }

  // Moves last: their content is now final (nested edits applied), and the
  // destination offsets refer to the original text, which the outer string
  // still indexes correctly.
  for (const r of movedRanges) {
    const target = resolve(r.op.target, "move");
    if (!target) continue;
    const node = r.node;
    const caps = capabilities(node, code);
    if (!caps.canMove) {
      failures.push(`move #${node.index}: ${caps.structuralReason}`);
      continue;
    }
    if (target.index === node.index) {
      failures.push("move: an element cannot be moved relative to itself");
      continue;
    }
    if (target.element.start >= node.element.start && target.element.end <= node.element.end) {
      failures.push("move: an element cannot be moved inside itself");
      continue;
    }
    const targetCaps = capabilities(target, code);
    if (r.op.position === "inside" && !targetCaps.canAcceptChildren) {
      failures.push(`move: <${tagNameOf(target.opening, code)}> cannot take children`);
      continue;
    }
    const range = removalRange(code, node.element.start, node.element.end);
    const point = insertionPoint(code, target, r.op.position);
    if (!point) {
      failures.push(`move: <${tagNameOf(target.opening, code)}> has no place to put a child`);
      continue;
    }
    const destination = point.at ?? target.element.end;
    if (destination > range.start && destination < range.end) {
      failures.push("move: destination is inside the element being moved");
      continue;
    }
    // The captured text carries any class/text edits made inside the subtree,
    // re-indented for its new depth.
    const body = reindent(
      r.text.toString(),
      indentAt(code, node.element.start),
      point.indent,
    );
    s.remove(range.start, range.end);
    place(s, code, target, point, body, failures, "move");
  }

  if (failures.length > 0) {
    return { ok: false, error: failures.join("; ") };
  }

  const output = s.toString();
  // Trust gate: never write a file we can no longer parse.
  try {
    parse(output, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
    });
  } catch (e) {
    return { ok: false, error: `edit would corrupt the file, aborted: ${e.message}` };
  }
  if (output === code) return { ok: true, changed: false };
  fs.writeFileSync(file, output);
  return { ok: true, changed: true };
}

/**
 * Write an already-final `body` into the string at `point`, expanding a
 * self-closing target into a pair when something is dropped inside it.
 * Returns false (and records a failure) when the placement is impossible.
 */
function place(s, code, target, point, body, failures, what) {
  const name = tagNameOf(target.opening, code);
  if (!point) {
    failures.push(`${what}: <${name}> has no place to put a child`);
    return false;
  }
  if (point.expandSelfClosing) {
    // `<Card />` → `<Card>\n  …\n</Card>` — the only way to reparent into an
    // element that has no children yet.
    const opening = target.opening;
    let slashAt = code.lastIndexOf("/", opening.end);
    if (slashAt <= opening.name.end) {
      failures.push(`${what}: cannot expand <${name} /> to take children`);
      return false;
    }
    // Swallow the space in `<Card />` so the pair reads `<Card>`, not `<Card >`.
    while (slashAt > opening.name.end && /\s/.test(code[slashAt - 1])) slashAt--;
    s.overwrite(
      slashAt,
      opening.end,
      `>\n${point.indent}${body}\n${point.outer}</${name}>`,
    );
    return true;
  }
  // appendRight, not appendLeft: an insertion point is "before whatever comes
  // next", and in a program that also moves an element away, the chunk to the
  // LEFT may have been removed — content appended to a removed chunk is
  // dropped. The chunk to the right is the surviving anchor.
  s.appendRight(point.at, point.wrap(body));
  return true;
}

/**
 * A snippet must be exactly one JSX element and must parse on its own — the
 * palette's markup and anything the editor generates goes through here before
 * it can reach a source file.
 */
function validateSnippet(snippet) {
  if (typeof snippet !== "string" || snippet.trim() === "") {
    return { error: "empty snippet" };
  }
  if (snippet.length > 4000) return { error: "snippet too large" };
  let ast;
  try {
    ast = parse(`<>${snippet}</>`, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
  } catch (e) {
    return { error: `snippet does not parse: ${e.message}` };
  }
  const expr = ast.program.body[0]?.expression;
  const kids = (expr?.children ?? []).filter(
    (c) => !(c.type === "JSXText" && c.value.trim() === ""),
  );
  if (kids.length !== 1 || kids[0].type !== "JSXElement") {
    return { error: "snippet must be exactly one JSX element" };
  }
  return { code: snippet.trim() };
}

// Full-file replacement (AI chat edits). The content is model output, so the
// gate is strict: parse WITHOUT error recovery — any syntax error aborts the
// write. The old content is returned so the caller can diff/undo.
function validateJsxContent(content) {
  try {
    parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
    });
  } catch (e) {
    return { ok: false, error: `new content does not parse, aborted: ${e.message}` };
  }
  return { ok: true };
}

// --- entry ------------------------------------------------------------------

/**
 * Which write-back a file gets. The extension is the whole decision: `.html`
 * is markup the static server stamps and this sidecar edits through
 * htmlback.mjs; everything JSX-shaped goes through the walk above. Anything
 * else is refused by name rather than parsed hopefully.
 */
function languageOf(file) {
  const ext = String(file).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (ext === ".html" || ext === ".htm") return "html";
  if ([".jsx", ".tsx", ".js", ".ts", ".mjs", ".cjs", ".mts", ".cts"].includes(ext)) {
    return "jsx";
  }
  if (ext === ".css") return "css";
  return null;
}

/**
 * Stylesheet replacement (AI chat edits on a static site's CSS).
 *
 * dedup bundles no CSS parser, so this is deliberately *not* called a parse
 * gate: it is a balance check — braces must close and no block comment may be
 * left open. That catches a truncated model reply, which is the failure this
 * is guarding against, and it says exactly what it checks rather than implying
 * a guarantee it cannot make.
 */
function validateCssContent(content) {
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "");
  if (stripped.includes("/*")) {
    return { ok: false, error: "new stylesheet has an unclosed comment, aborted" };
  }
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth++;
    else if (ch === "}" && --depth < 0) break;
  }
  if (depth !== 0) {
    return { ok: false, error: "new stylesheet has unbalanced braces, aborted" };
  }
  return { ok: true };
}

/**
 * The one gate every full-content write passes, whatever produced it. The
 * extension picks the check; an extension with no check is refused by name
 * rather than written hopefully.
 */
function validateContent(file, content) {
  if (typeof content !== "string" || content.trim() === "") {
    return { ok: false, error: "refusing to write empty content" };
  }
  const lang = languageOf(file);
  if (lang === "html") return validateHtmlContent(content);
  if (lang === "css") return validateCssContent(content);
  if (lang === "jsx") return validateJsxContent(content);
  return {
    ok: false,
    error: `dedup cannot write ${path.basename(file)} — unsupported file type`,
  };
}

/** Write validated content. Returns whether the file actually changed; a new
 *  file (the agent extracting a component) counts as a change. */
function commitContent(file, content) {
  let previous = null;
  try {
    previous = fs.readFileSync(file, "utf8");
  } catch {
    previous = null; // a file that does not exist yet
  }
  if (previous === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function writeFile({ file, content }) {
  const check = validateContent(file, content);
  if (!check.ok) return check;
  return { ok: true, changed: commitContent(file, content) };
}

/**
 * Multi-file replacement — the chat agent's write path.
 *
 * Every file is validated before ANY file is written. That is the same
 * all-or-nothing guarantee the single-file write-back makes within one file,
 * extended across a set: a program that would leave the project half-edited
 * (a new component written, its call site not) writes nothing at all. It is
 * the reason the agent may touch more than one file in the first place.
 */
function writeFiles({ files }) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "no files to write" };
  }
  for (const f of files) {
    const check = validateContent(f.file, f.content);
    if (!check.ok) {
      return { ok: false, error: `${f.rel ?? path.basename(f.file)}: ${check.error}` };
    }
  }
  const changed = [];
  for (const f of files) {
    if (commitContent(f.file, f.content)) {
      changed.push(f.rel ?? path.basename(f.file));
    }
  }
  return { ok: true, changed };
}

/**
 * Put files back exactly as dedup found them — how a previewed chat edit is
 * discarded. `content: null` means the file did not exist before, so it is
 * removed.
 *
 * Deliberately *not* gated on validateContent, and this is the one write path
 * where that is right. The gate exists to catch model output; this is bytes
 * dedup itself read off these exact files a moment ago. Validating them would
 * refuse to restore a file that was already broken — which is precisely the
 * case where the user asked the agent for help, previewed the fix, and wants
 * their original state back.
 */
function revertFiles({ files }) {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: "no files to revert" };
  }
  const restored = [];
  for (const f of files) {
    try {
      if (f.content === null || f.content === undefined) {
        fs.rmSync(f.file, { force: true });
      } else {
        fs.writeFileSync(f.file, f.content);
      }
      restored.push(f.rel ?? path.basename(f.file));
    } catch (e) {
      return {
        ok: false,
        error: `could not restore ${f.rel ?? path.basename(f.file)}: ${e?.message ?? e}`,
        restored,
      };
    }
  }
  return { ok: true, restored };
}

// --- chat-agent context tools ----------------------------------------------
//
// The agent is never handed tools or write access to the user's project (that
// would be a second, unaudited path to their source). It asks dedup for what
// it wants to see and dedup answers — these two commands are the whole of
// what it can ask for, and both are read-only.

/** `public/` is skipped by the shared traversal because it holds build
 *  output; a static site keeps its actual pages there. */
const CONTEXT_ALLOW_DIRS = new Set(["public"]);

function listFiles({ root, limit }) {
  const files = discoverFiles(root, CONTEXT_FILE_RE, CONTEXT_ALLOW_DIRS)
    .map((f) => relOf(root, f))
    .filter((f) => !f.includes("node_modules/"));
  const max = Number.isInteger(limit) && limit > 0 ? limit : 1200;
  return { ok: true, files: files.slice(0, max), total: files.length };
}

/**
 * Grep, as a regex when the pattern is one and as a literal when it isn't —
 * a model asking for `useState(` should get matches, not a syntax error.
 */
function grepFiles({ root, pattern, limit }) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    return { ok: false, error: "grep needs a pattern" };
  }
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const max = Number.isInteger(limit) && limit > 0 ? limit : 80;
  const matches = [];
  for (const abs of discoverFiles(root, CONTEXT_FILE_RE, CONTEXT_ALLOW_DIRS)) {
    if (matches.length >= max) break;
    let code;
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) continue;
      code = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (!re.test(code)) continue;
    const rel = relOf(root, abs);
    const lines = code.split("\n");
    for (let i = 0; i < lines.length && matches.length < max; i++) {
      if (re.test(lines[i])) {
        matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
    }
  }
  return { ok: true, matches, truncated: matches.length >= max };
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let result;
  try {
    const req = JSON.parse(input);
    const lang = req.file ? languageOf(req.file) : null;
    if (req.cmd === "inspect") {
      result = lang === "html" ? inspectHtml(req) : inspect(req);
    }
    // The read half of cut/copy/paste: an element's own source, as a snippet
    // the insert op will take back.
    else if (req.cmd === "copy") {
      result = lang === "html" ? copyHtml(req) : copy(req);
    }
    // Route discovery from outside the dev server. Vite projects get this
    // over HTTP from the tagger's middleware; Next has no middleware to add
    // one to, so this is the only way its file-based routes are ever found.
    else if (req.cmd === "routes") result = { ok: true, routes: discoverRoutes(req.root, req.framework) };
    else if (req.cmd === "apply") {
      result = lang === "html" ? applyHtml(req) : apply(req);
    } else if (req.cmd === "writeFile") {
      result = writeFile(req);
    } else if (req.cmd === "writeFiles") {
      result = writeFiles(req);
    } else if (req.cmd === "revertFiles") {
      result = revertFiles(req);
    } else if (req.cmd === "listFiles") {
      result = listFiles(req);
    } else if (req.cmd === "grep") {
      result = grepFiles(req);
    } else result = { ok: false, error: `unknown cmd: ${req.cmd}` };
  } catch (e) {
    result = { ok: false, error: String(e?.message ?? e) };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
});
