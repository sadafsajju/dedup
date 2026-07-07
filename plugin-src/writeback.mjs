// dedup write-back — locates a JSX element by file:line:col (the coordinates
// stamped by the tagger) and inspects or rewrites its className attribute
// (FR-4.1, FR-4.2). Runs as a one-shot node process: JSON in on stdin, one
// JSON line out on stdout. Bundled self-contained; nothing is required from
// the user's node_modules.
//
// Edits are surgical range replacements (magic-string), so formatting
// everywhere else in the file is untouched by construction. Only static
// className values are editable — anything dynamic is reported read-only
// with a reason (honesty over magic).

import { parse } from "@babel/parser";
import MagicString from "magic-string";
import fs from "node:fs";

// className must stay a plain single-line string; anything else is refused.
const SAFE_CLASS_RE = /^[^"'`\\\n\r]*$/;

function parseSource(code) {
  return parse(code, {
    sourceType: "module",
    errorRecovery: true,
    plugins: ["jsx", "typescript", "decorators-legacy"],
  });
}

function walk(node, visit) {
  if (!node || typeof node.type !== "string") return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, visit);
    }
  }
}

function findOpeningElement(program, line, col) {
  let found = null;
  walk(program, (n) => {
    if (
      n.type === "JSXOpeningElement" &&
      n.loc.start.line === line &&
      n.loc.start.column === col
    ) {
      found = n;
    }
  });
  return found;
}

function dynamicReason(expr) {
  switch (expr.type) {
    case "CallExpression": {
      const callee =
        expr.callee.type === "Identifier" ? expr.callee.name : "call";
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
function classInfo(node) {
  const attr = node.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name?.name === "className",
  );
  if (!attr) {
    // No attribute — we can add one right after the tag name/generics.
    const insertAt =
      node.typeArguments?.end ?? node.typeParameters?.end ?? node.name.end;
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

function inspect({ file, line, col }) {
  const code = fs.readFileSync(file, "utf8");
  const ast = parseSource(code);
  const el = findOpeningElement(ast.program, line, col);
  if (!el) {
    return {
      ok: false,
      error: `no JSX element at ${line}:${col} — source may have changed since tagging`,
    };
  }
  const info = classInfo(el);
  return {
    ok: true,
    editable: info.editable,
    className: info.className,
    reason: info.reason ?? null,
  };
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

function write({ file, edits }) {
  const code = fs.readFileSync(file, "utf8");
  const ast = parseSource(code);
  const s = new MagicString(code);
  const failures = [];

  for (const edit of edits) {
    const { line, col, className } = edit;
    if (typeof className !== "string" || !SAFE_CLASS_RE.test(className)) {
      failures.push(`${line}:${col}: refusing unsafe class string`);
      continue;
    }
    const el = findOpeningElement(ast.program, line, col);
    if (!el) {
      failures.push(`${line}:${col}: element not found — source changed?`);
      continue;
    }
    const info = classInfo(el);
    if (!info.editable) {
      failures.push(`${line}:${col}: not editable (${info.reason})`);
      continue;
    }
    const value = className.trim().replace(/\s+/g, " ");
    if (info.mode === "insert") {
      if (value !== "") {
        s.appendLeft(info.insertAt, ` className="${value}"`);
      }
    } else {
      s.overwrite(info.start, info.end, value);
    }
  }

  if (failures.length > 0) {
    return { ok: false, error: failures.join("; ") };
  }

  const output = s.toString();
  // Trust gate in miniature: never write a file we can no longer parse.
  try {
    parseSource(output);
  } catch (e) {
    return { ok: false, error: `edit would corrupt the file, aborted: ${e.message}` };
  }
  fs.writeFileSync(file, output);
  return { ok: true };
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
    else if (req.cmd === "write") result = write(req);
    else if (req.cmd === "writeFile") result = writeFile(req);
    else result = { ok: false, error: `unknown cmd: ${req.cmd}` };
  } catch (e) {
    result = { ok: false, error: String(e?.message ?? e) };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
});
