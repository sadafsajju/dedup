// Shared JSX traversal — the single definition of "which elements dedup knows
// about, in what order, and what may be done to each".
//
// Both the tagger (which stamps ids into the served JS) and the write-back
// sidecar (which resolves an id back to a source range) import this. That is
// the point: an element's id is its ORDINAL in this walk, so the two sides
// must agree byte-for-byte on the traversal. Sharing the code makes drift
// impossible; two copies of "the same" walk would not stay the same.
//
// Why ordinals instead of file:line:col (the pre-2026-08 scheme): positions go
// stale the moment a save shifts columns, so every element after an edit on
// the same line lost its identity until the next full re-tag. An ordinal only
// changes when elements are added or removed — and those edits re-tag the
// module anyway.

/** Keys that never contain child AST nodes (position/comment bookkeeping). */
const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
]);

/** Element is the root of a `.map()` callback — one source node, N instances. */
export const DYNAMIC_ARRAY = "array";
/** Element is a branch of a ternary / `&&` — its presence is conditional. */
export const DYNAMIC_CONDITIONAL = "conditional";
/** Element is what a component returns — deleting it empties the component. */
export const CORE_ROOT = "root";
/** The document `<body>` — never movable. */
export const CORE_BODY = "body";

/**
 * Fragments (<></>, <Fragment>, <React.Fragment>) only accept `key`, so they
 * are never tagged and never counted in the ordinal.
 */
export function isFragmentName(name) {
  if (!name) return true;
  if (name.type === "JSXIdentifier") return name.name === "Fragment";
  if (name.type === "JSXMemberExpression") {
    return (
      name.property?.name === "Fragment" && name.object?.type === "JSXIdentifier"
    );
  }
  return false;
}

/** A function is "a component" when named with a leading capital. */
function componentNameOf(node) {
  if (node.type === "FunctionDeclaration" && node.id && /^[A-Z]/.test(node.id.name)) {
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

/** `xs.map(…)` — the call whose callback root elements are array instances. */
function isMapCall(node) {
  return (
    node.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.property?.name === "map"
  );
}

/**
 * Which dynamic scope a node opens for the JSX inside it, or null.
 * The scope is *consumed* by the first JSX element found within it (see walk),
 * so only the branch/callback root is marked — its own children are static
 * markup that happens to live inside a dynamic parent.
 */
function opensDynamicScope(node) {
  if (isMapCall(node)) return DYNAMIC_ARRAY;
  if (node.type === "ConditionalExpression") return DYNAMIC_CONDITIONAL;
  if (node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||")) {
    return DYNAMIC_CONDITIONAL;
  }
  return null;
}

/**
 * `dynamic` and `insideComponent` are needed to keep this honest: the root of
 * a `.map()` callback is also "the body of an arrow function", but it is an
 * array item, not a component root — and JSX returned outside any component
 * (a render prop at module scope) is neither.
 */
function coreTypeOf(element, parent, dynamic, insideComponent) {
  const name = element.openingElement.name;
  if (name.type === "JSXIdentifier" && (name.name === "body" || name.name === "html")) {
    return CORE_BODY;
  }
  if (
    !dynamic &&
    insideComponent &&
    parent &&
    (parent.type === "ReturnStatement" ||
      parent.type === "ArrowFunctionExpression" ||
      parent.type === "FunctionExpression")
  ) {
    return CORE_ROOT;
  }
  return null;
}

/**
 * Depth-first walk over every taggable JSX element in `root`, in a fixed
 * order. `visit` receives one node record:
 *
 *   index      ordinal — the identity half of a dedup id
 *   element    the JSXElement node        opening  its JSXOpeningElement
 *   component  enclosing component name (or null)
 *   dynamic    DYNAMIC_* when this element is a map/conditional root
 *   core       CORE_* when this element is a component root or <body>
 *   parent     the enclosing tagged node record, or null
 *   depth      nesting depth among tagged elements
 */
export function walkJsx(root, visit) {
  let index = 0;

  const walk = (node, parent, ancestor, pendingDynamic, components) => {
    if (!node || typeof node.type !== "string") return;

    const component = componentNameOf(node);
    if (component) components.push(component);

    let nextAncestor = ancestor;
    let pending = pendingDynamic;

    if (node.type === "JSXElement" && !isFragmentName(node.openingElement.name)) {
      const record = {
        index: index++,
        element: node,
        opening: node.openingElement,
        component: components.length ? components[components.length - 1] : null,
        dynamic: pending,
        core: coreTypeOf(node, parent, pending, components.length > 0),
        parent: ancestor,
        depth: ancestor ? ancestor.depth + 1 : 0,
      };
      visit(record);
      nextAncestor = record;
      pending = null; // consumed — children are static markup
    }

    const opened = opensDynamicScope(node);
    if (opened) pending = opened;

    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) walk(child, node, nextAncestor, pending, components);
      } else if (value && typeof value.type === "string") {
        walk(value, node, nextAncestor, pending, components);
      }
    }

    if (component) components.pop();
  };

  walk(root, null, null, null, []);
}

/** Collect every node record in one pass (write-back wants random access). */
export function collectJsx(root) {
  const nodes = [];
  walkJsx(root, (record) => nodes.push(record));
  return nodes;
}

// --- dedup ids ---------------------------------------------------------------

/** `<relative file>@<ordinal>` — see the header for why not line:col. */
export function makeDedupId(relFile, index) {
  return `${relFile}@${index}`;
}

export function parseDedupId(id) {
  const at = String(id).lastIndexOf("@");
  if (at <= 0) return null;
  const index = Number(id.slice(at + 1));
  if (!Number.isInteger(index) || index < 0) return null;
  return { file: id.slice(0, at), index };
}
