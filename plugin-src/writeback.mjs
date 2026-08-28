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
import { collectJsx } from "./jsxwalk.mjs";
import { discoverRoutes } from "./routes.mjs";

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

// --- edit program -----------------------------------------------------------

/** Indentation of the line `pos` sits on. */
function indentAt(code, pos) {
  const lineStart = code.lastIndexOf("\n", pos - 1) + 1;
  const m = code.slice(lineStart, pos).match(/^[ \t]*/);
  return m ? m[0] : "";
}

/** Start of the line `pos` sits on (so removals take the whole line). */
function lineStartOf(code, pos) {
  return code.lastIndexOf("\n", pos - 1) + 1;
}

/** End of the line `pos` sits on, including its newline. */
function lineEndOf(code, pos) {
  const nl = code.indexOf("\n", pos);
  return nl === -1 ? code.length : nl + 1;
}

/**
 * Re-indent a captured block for its new home: strip the block's own base
 * indentation from every line after the first, then apply the target's.
 * Moved markup that lands a level deeper reads as if it were typed there.
 */
function reindent(text, fromIndent, toIndent) {
  if (fromIndent === toIndent) return text;
  return text
    .split("\n")
    .map((line, i) => {
      if (i === 0) return line;
      const stripped = line.startsWith(fromIndent) ? line.slice(fromIndent.length) : line;
      return stripped.trim() === "" ? stripped : toIndent + stripped;
    })
    .join("\n");
}

/** Element range including a trailing `{" "}`-free line when it owns its line. */
function removalRange(code, element) {
  const start = element.start;
  const end = element.end;
  const before = code.slice(lineStartOf(code, start), start);
  if (before.trim() !== "") return { start, end };
  const after = code.slice(end, lineEndOf(code, end));
  if (after.trim() !== "") return { start, end };
  // The element owns its line(s) — take the whole line so no blank is left.
  return { start: lineStartOf(code, start), end: lineEndOf(code, end) };
}

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
  const ownsLine = code.slice(lineStartOf(code, element.start), element.start).trim() === "";

  if (position === "before") {
    return ownsLine
      ? { at: lineStartOf(code, element.start), indent: outer, wrap: (b) => outer + b + "\n" }
      : { at: element.start, indent: outer, wrap: (b) => b + " " };
  }

  if (position === "after") {
    const trailing = code.slice(element.end, lineEndOf(code, element.end));
    return ownsLine && trailing.trim() === ""
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
        const range = removalRange(code, node.element);
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
        const point = insertionPoint(code, target, op.position);
        if (point && op.position === "inside" && !capabilities(target, code).canAcceptChildren) {
          failures.push(`insert: <${tagNameOf(target.opening, code)}> cannot take children`);
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
    const range = removalRange(code, node.element);
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
function writeFile({ file, content }) {
  if (typeof content !== "string" || content.trim() === "") {
    return { ok: false, error: "refusing to write empty content" };
  }
  try {
    parse(content, {
      sourceType: "module",
      plugins: ["jsx", "typescript", "decorators-legacy"],
    });
  } catch (e) {
    return { ok: false, error: `new content does not parse, aborted: ${e.message}` };
  }
  const previous = fs.readFileSync(file, "utf8");
  if (previous === content) {
    return { ok: true, changed: false };
  }
  fs.writeFileSync(file, content);
  return { ok: true, changed: true };
}

// --- entry ------------------------------------------------------------------

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let result;
  try {
    const req = JSON.parse(input);
    if (req.cmd === "inspect") result = inspect(req);
    // Route discovery from outside the dev server. Vite projects get this
    // over HTTP from the tagger's middleware; Next has no middleware to add
    // one to, so this is the only way its file-based routes are ever found.
    else if (req.cmd === "routes") result = { ok: true, routes: discoverRoutes(req.root) };
    else if (req.cmd === "apply") result = apply(req);
    else if (req.cmd === "writeFile") result = writeFile(req);
    else result = { ok: false, error: `unknown cmd: ${req.cmd}` };
  } catch (e) {
    result = { ok: false, error: String(e?.message ?? e) };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
});
