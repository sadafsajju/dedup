// dedup tagger — Vite plugin stamping every JSX element with
// `data-dedup-id="<file>:<line>:<col>"` plus the enclosing component name
// (FR-2.1), and injecting/serving the canvas overlay script (FR-2.2).
//
// This file is bundled (with @babel/parser + magic-string inlined) into a
// single self-contained module that dedup writes into the user's project at
// node_modules/.dedup/ — it must not require anything from their tree.
//
// Tags live only in the served JS, never in the user's source files.

import { parse } from "@babel/parser";
import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JSX_FILE_RE = /\.[jt]sx$/;
const OVERLAY_ROUTE = "/__dedup/overlay.js";

export default function dedupTagger(options = {}) {
  const projectRoot = options.root || process.cwd();
  const selfDir = path.dirname(fileURLToPath(import.meta.url));
  const overlayFile = options.overlayFile || path.join(selfDir, "dedup-overlay.js");

  return {
    name: "dedup:tagger",
    enforce: "pre",

    transform(code, id) {
      const [file] = id.split("?", 1);
      if (!JSX_FILE_RE.test(file) || file.includes("node_modules")) return null;
      const rel = path.relative(projectRoot, file);
      if (rel.startsWith("..")) return null;
      return tagCode(code, rel);
    },

    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: OVERLAY_ROUTE, defer: true },
          injectTo: "body",
        },
      ];
    },

    configureServer(server) {
      server.middlewares.use(OVERLAY_ROUTE, (_req, res) => {
        res.setHeader("content-type", "text/javascript");
        try {
          res.end(fs.readFileSync(overlayFile, "utf8"));
        } catch (e) {
          res.statusCode = 404;
          res.end(`// dedup overlay missing: ${e}`);
        }
      });
    },
  };
}

/**
 * Insert data-dedup-id / data-dedup-component into every JSX opening element.
 * Exported for tests. Returns { code, map } or null when nothing was tagged.
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

  walk(ast.program, [], (node, componentStack) => {
    if (isFragmentName(node.name)) return;
    const { line, column } = node.loc.start;
    const idValue = `${relFile}:${line}:${column}`;
    const component = componentStack[componentStack.length - 1];
    // Anchor right after the last attribute (or the name/generics when there
    // are none) so spacing stays natural for both `>` and ` />` endings.
    const last = node.attributes[node.attributes.length - 1];
    const insertAt =
      last?.end ??
      node.typeArguments?.end ??
      node.typeParameters?.end ??
      node.name.end;
    let attrs = ` data-dedup-id="${idValue}"`;
    if (component) attrs += ` data-dedup-component="${component}"`;
    s.appendLeft(insertAt, attrs);
    tagged++;
  });

  if (tagged === 0) return null;
  return {
    code: s.toString(),
    map: s.generateMap({ hires: true }),
  };
}

/** Depth-first AST walk that tracks the enclosing-component name stack and
 * calls `visit` for every JSXOpeningElement. */
function walk(node, componentStack, visit) {
  if (!node || typeof node.type !== "string") return;

  const componentName = componentNameOf(node);
  if (componentName) componentStack.push(componentName);

  if (node.type === "JSXOpeningElement") visit(node, componentStack);

  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
      continue;
    }
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) walk(child, componentStack, visit);
    } else if (value && typeof value.type === "string") {
      walk(value, componentStack, visit);
    }
  }

  if (componentName) componentStack.pop();
}

/** A function is "a component" when it's named with a leading capital —
 * function declarations and const Foo = () => … / function () … forms. */
function componentNameOf(node) {
  if (
    node.type === "FunctionDeclaration" &&
    node.id &&
    /^[A-Z]/.test(node.id.name)
  ) {
    return node.id.name;
  }
  if (
    node.type === "VariableDeclarator" &&
    node.id?.type === "Identifier" &&
    /^[A-Z]/.test(node.id.name) &&
    node.init &&
    (node.init.type === "ArrowFunctionExpression" ||
      node.init.type === "FunctionExpression")
  ) {
    return node.id.name;
  }
  return null;
}

/** Fragments (<></>, <Fragment>, <React.Fragment>) only accept `key` —
 * adding data attributes would make React warn. */
function isFragmentName(name) {
  if (!name) return true;
  if (name.type === "JSXIdentifier") return name.name === "Fragment";
  if (name.type === "JSXMemberExpression") {
    return (
      name.property?.name === "Fragment" &&
      name.object?.type === "JSXIdentifier"
    );
  }
  return false;
}
