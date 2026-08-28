// dedup scan — component inventory + structural similarity + clustering
// (FR-5.1, FR-5.2 structural signal; semantic/visual are Phase 5). Runs as a
// one-shot node process: JSON request on stdin, progress lines + one final
// JSON line on stdout. Bundled self-contained like the other sidecars.
//
// Detection is deterministic by design: tree edit distance on simplified JSX
// trees plus Tailwind class comparison where `p-4` vs `p-6` counts as "same
// knob, different value". No model involved — scores must be reproducible.

import fs from "node:fs";
import path from "node:path";
import {
  COMPONENT_FILE_RE,
  MAX_FILE_BYTES,
  discoverFiles,
  isMainModule,
  parseSource,
  relOf,
  walk,
} from "./files.mjs";

// --- parsing + component extraction (FR-5.1) --------------------------------

/** Unwrap memo(...)/forwardRef(...) wrappers down to the inner function. */
function unwrapToFunction(node) {
  if (!node) return null;
  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression"
  ) {
    return node;
  }
  if (node.type === "CallExpression") {
    for (const arg of node.arguments) {
      const inner = unwrapToFunction(arg);
      if (inner) return inner;
    }
  }
  return null;
}

/** { name, fn } when the node declares a capitalized function component. */
function componentDeclOf(node) {
  if (
    node.type === "FunctionDeclaration" &&
    node.id &&
    /^[A-Z]/.test(node.id.name)
  ) {
    return { name: node.id.name, fn: node };
  }
  if (
    node.type === "VariableDeclarator" &&
    node.id?.type === "Identifier" &&
    /^[A-Z]/.test(node.id.name)
  ) {
    const fn = unwrapToFunction(node.init);
    if (fn) return { name: node.id.name, fn };
  }
  return null;
}

function jsxTagName(name) {
  if (!name) return "?";
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    return `${jsxTagName(name.object)}.${name.property?.name ?? "?"}`;
  }
  if (name.type === "JSXNamespacedName") {
    return `${name.namespace?.name}:${name.name?.name}`;
  }
  return "?";
}

/** Static class tokens of a JSX opening element ([] when absent/dynamic). */
function staticClassTokens(opening) {
  const attr = opening.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name?.name === "className",
  );
  if (!attr?.value) return [];
  let value = null;
  if (attr.value.type === "StringLiteral") value = attr.value.value;
  else if (attr.value.type === "JSXExpressionContainer") {
    const e = attr.value.expression;
    if (e.type === "StringLiteral") value = e.value;
    else if (e.type === "TemplateLiteral" && e.expressions.length === 0) {
      value = e.quasis[0].value.cooked ?? e.quasis[0].value.raw;
    }
  }
  return value ? value.split(/\s+/).filter(Boolean) : [];
}

/** Simplified JSX tree: { tag, classes, children } — expression containers
 * are traversed so `{items.map(i => <li/>)}` contributes children. */
function buildTree(node) {
  if (node.type === "JSXFragment") {
    return { tag: "<>", classes: [], children: jsxChildren(node.children) };
  }
  return {
    tag: jsxTagName(node.openingElement.name),
    classes: staticClassTokens(node.openingElement),
    children: jsxChildren(node.children),
  };
}

function jsxChildren(children) {
  const out = [];
  for (const child of children) {
    if (child.type === "JSXElement" || child.type === "JSXFragment") {
      out.push(buildTree(child));
    } else if (child.type === "JSXExpressionContainer") {
      walk(child.expression, (n) => {
        if (n.type === "JSXElement" || n.type === "JSXFragment") {
          out.push(buildTree(n));
          return false;
        }
      });
    }
  }
  return out;
}

function treeSize(tree) {
  return 1 + tree.children.reduce((sum, c) => sum + treeSize(c), 0);
}

/** Pre-order list of nodes (label = tag) for TED / sequence comparison. */
function flatten(tree, out = []) {
  out.push(tree.tag);
  for (const c of tree.children) flatten(c, out);
  return out;
}

function skeletonText(tree, depth = 0, lines = []) {
  const classes = tree.classes.length ? ` .${tree.classes.join(" .")}` : "";
  lines.push("  ".repeat(depth) + tree.tag + classes);
  for (const c of tree.children) skeletonText(c, depth + 1, lines);
  return lines;
}

function allClassTokens(tree, out = []) {
  out.push(...tree.classes);
  for (const c of tree.children) allClassTokens(c, out);
  return out;
}

/** Prop names from the component's first parameter. */
function propNames(fn) {
  const p = fn.params?.[0];
  if (!p) return [];
  const pattern = p.type === "AssignmentPattern" ? p.left : p;
  if (pattern.type !== "ObjectPattern") return [];
  const names = [];
  for (const prop of pattern.properties) {
    if (prop.type === "ObjectProperty" && prop.key?.type === "Identifier") {
      names.push(prop.key.name);
    } else if (prop.type === "RestElement" && prop.argument?.type === "Identifier") {
      names.push(`...${prop.argument.name}`);
    }
  }
  return names;
}

/** Exported names of a module: name -> "named" | "default". */
function exportMap(program) {
  const map = new Map();
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration;
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        map.set(decl.id.name, "named");
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id?.type === "Identifier") map.set(d.id.name, "named");
        }
      }
      for (const spec of stmt.specifiers ?? []) {
        if (spec.local?.name) map.set(spec.local.name, "named");
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration;
      if (d.type === "FunctionDeclaration" && d.id) map.set(d.id.name, "default");
      else if (d.type === "Identifier") map.set(d.name, "default");
    }
  }
  return map;
}

/** Extract all function components declared in one parsed file. */
function extractComponents(program, relFile) {
  const components = [];
  const exports = exportMap(program);

  walk(program, (node) => {
    const decl = componentDeclOf(node);
    if (!decl) return;

    // Collect JSX roots in the body, not descending into nested component
    // definitions — their JSX belongs to the inner component.
    const roots = [];
    walk(decl.fn.body ?? decl.fn, (n) => {
      if (n !== node && componentDeclOf(n)) return false;
      if (n.type === "JSXElement" || n.type === "JSXFragment") {
        roots.push(buildTree(n));
        return false;
      }
    });
    if (roots.length === 0) return;

    let tree = roots[0];
    let size = treeSize(tree);
    for (const r of roots.slice(1)) {
      const s = treeSize(r);
      if (s > size) [tree, size] = [r, s];
    }

    components.push({
      name: decl.name,
      file: relFile,
      line: (decl.fn.loc ?? node.loc).start.line,
      col: (decl.fn.loc ?? node.loc).start.column,
      exportKind: exports.get(decl.name) ?? "local",
      props: propNames(decl.fn),
      nodeCount: size,
      tree,
      tags: flatten(tree),
      classTokens: allClassTokens(tree),
      skeleton: skeletonText(tree).join("\n"),
    });
  });
  return components;
}

// --- similarity (FR-5.2, structural signal) ---------------------------------

const COLOR_NAMES = new Set(
  ("slate gray zinc neutral stone red orange amber yellow lime green emerald " +
    "teal cyan sky blue indigo violet purple fuchsia pink rose black white " +
    "transparent current inherit").split(" "),
);

/** Reduce a Tailwind token to its "knob" so p-4/p-6 (and bg-red-500 /
 * bg-blue-600) compare as the same knob with a different value. */
function knobOf(token) {
  const sep = token.lastIndexOf(":");
  const variant = sep >= 0 ? token.slice(0, sep + 1) : "";
  let base = sep >= 0 ? token.slice(sep + 1) : token;
  if (base.startsWith("-")) base = base.slice(1);
  base = base.replace(/-\[[^\]]*\]$/, ""); // arbitrary values are just values
  const parts = base.split("-");
  if (parts.length >= 2) {
    if (COLOR_NAMES.has(parts[1])) return `${variant}${parts[0]}-color`;
    const last = parts[parts.length - 1];
    if (/^(\d+(\.\d+)?|\d+\/\d+|px|full|none|auto|xs|sm|md|lg|xl|\d+xl)$/.test(last)) {
      return variant + parts.slice(0, -1).join("-");
    }
  }
  return variant + base;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return null;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Zhang–Shasha ordered tree edit distance (unit costs, label = tag). */
function treeEditDistance(t1, t2) {
  const prep = (root) => {
    // Post-order the nodes; l[i] = index of the leftmost leaf under node i.
    const nodes = [];
    const l = [];
    (function po(node) {
      let leftmost = -1;
      for (const c of node.children) {
        const childIdx = po(c);
        if (leftmost === -1) leftmost = l[childIdx];
      }
      const idx = nodes.length;
      nodes.push(node.tag);
      l.push(leftmost === -1 ? idx : leftmost);
      return idx;
    })(root);
    // Keyroots: nodes with no parent-sharing-leftmost-leaf above them.
    const keyroots = [];
    const seen = new Set();
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (!seen.has(l[i])) {
        keyroots.push(i);
        seen.add(l[i]);
      }
    }
    keyroots.sort((a, b) => a - b);
    return { labels: nodes, l, keyroots };
  };

  const A = prep(t1);
  const B = prep(t2);
  const na = A.labels.length;
  const nb = B.labels.length;
  const td = Array.from({ length: na }, () => new Array(nb).fill(0));

  for (const i of A.keyroots) {
    for (const j of B.keyroots) {
      const li = A.l[i];
      const lj = B.l[j];
      const rows = i - li + 2;
      const cols = j - lj + 2;
      const fd = Array.from({ length: rows }, () => new Array(cols).fill(0));
      for (let x = 1; x < rows; x++) fd[x][0] = fd[x - 1][0] + 1;
      for (let y = 1; y < cols; y++) fd[0][y] = fd[0][y - 1] + 1;
      for (let x = 1; x < rows; x++) {
        for (let y = 1; y < cols; y++) {
          const ai = li + x - 1;
          const bj = lj + y - 1;
          if (A.l[ai] === li && B.l[bj] === lj) {
            const rename = A.labels[ai] === B.labels[bj] ? 0 : 1;
            fd[x][y] = Math.min(
              fd[x - 1][y] + 1,
              fd[x][y - 1] + 1,
              fd[x - 1][y - 1] + rename,
            );
            td[ai][bj] = fd[x][y];
          } else {
            fd[x][y] = Math.min(
              fd[x - 1][y] + 1,
              fd[x][y - 1] + 1,
              fd[A.l[ai] - li][B.l[bj] - lj] + td[ai][bj],
            );
          }
        }
      }
    }
  }
  return td[na - 1][nb - 1];
}

const TED_NODE_BUDGET = 10_000; // n1*n2 above this → sequence fallback

/** Structural similarity of two components in [0, 1]. */
export function similarity(a, b) {
  // Tree signal.
  const bigger = Math.max(a.nodeCount, b.nodeCount);
  const dist =
    a.nodeCount * b.nodeCount > TED_NODE_BUDGET
      ? levenshtein(a.tags, b.tags)
      : treeEditDistance(a.tree, b.tree);
  const treeSim = Math.max(0, 1 - dist / bigger);

  // Class signal: knobs (same control) + exact tokens (same value).
  const knobSim = jaccard(
    new Set(a.classTokens.map(knobOf)),
    new Set(b.classTokens.map(knobOf)),
  );
  const tokenSim = jaccard(new Set(a.classTokens), new Set(b.classTokens));
  const classSim = knobSim === null ? null : 0.6 * knobSim + 0.4 * tokenSim;

  const propSim = jaccard(new Set(a.props), new Set(b.props));

  let score = 0.6 * treeSim;
  let weight = 0.6;
  if (classSim !== null) {
    score += 0.3 * classSim;
    weight += 0.3;
  }
  if (propSim !== null) {
    score += 0.1 * propSim;
    weight += 0.1;
  }
  return score / weight;
}

/** Cheap gate before the expensive pair comparison. */
function worthComparing(a, b) {
  const ratio =
    Math.min(a.nodeCount, b.nodeCount) / Math.max(a.nodeCount, b.nodeCount);
  if (ratio < 0.5) return false;
  const bag = (tags) => {
    const m = new Map();
    for (const t of tags) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  };
  const ba = bag(a.tags);
  const bb = bag(b.tags);
  let inter = 0;
  for (const [t, n] of ba) inter += Math.min(n, bb.get(t) ?? 0);
  return inter / (a.tags.length + b.tags.length - inter) >= 0.4;
}

// --- gallery filter (canvas artboards) ----------------------------------------
// "Big elements only": structural composites and interactive controls render
// as artboards; pure text wrappers and svg-only icons don't.

const INTERACTIVE_TAGS = new Set([
  "button", "input", "select", "textarea", "a", "form", "details", "summary", "option",
]);
const TEXT_TAGS = new Set([
  "span", "p", "h1", "h2", "h3", "h4", "h5", "h6",
  "label", "strong", "em", "small", "b", "i", "blockquote",
]);
const SVG_TAGS = new Set([
  "svg", "path", "circle", "rect", "line", "g", "polyline", "polygon",
  "defs", "ellipse", "use", "mask", "clipPath", "linearGradient", "stop",
]);

// App shells aren't reusable UI — rendering them just shows routers/404s.
const SHELL_NAME_RE = /^App$|Routes$|Router$|Provider$|Layout$/;

export function qualifiesForGallery(component) {
  if (SHELL_NAME_RE.test(component.name)) return false;
  const hosts = component.tags.filter((t) => /^[a-z]/.test(t));
  if (hosts.length > 0 && hosts.every((t) => SVG_TAGS.has(t))) return false; // icon
  const interactive = hosts.some((t) => INTERACTIVE_TAGS.has(t));
  if (interactive) return true;
  if (component.nodeCount < 2) return false; // bare wrappers
  if (hosts.length > 0 && hosts.every((t) => TEXT_TAGS.has(t))) return false; // typography
  return true;
}

// --- clustering --------------------------------------------------------------

const CLUSTER_THRESHOLD = 0.8;
const MIN_NODES = 2; // one-element wrappers cluster everything; skip them

function clusterId(members) {
  const key = members
    .map((m) => `${m.file}#${m.name}`)
    .sort()
    .join("|");
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function cluster(components, emitProgress) {
  const eligible = components.filter((c) => c.nodeCount >= MIN_NODES);
  const parent = eligible.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };

  const pairScores = new Map(); // "i,j" -> score, for cluster confidence
  const total = (eligible.length * (eligible.length - 1)) / 2;
  let done = 0;
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      done++;
      if (done % 2000 === 0) emitProgress("similarity", done, total);
      if (!worthComparing(eligible[i], eligible[j])) continue;
      const score = similarity(eligible[i], eligible[j]);
      if (score >= CLUSTER_THRESHOLD) {
        pairScores.set(`${i},${j}`, score);
        parent[find(i)] = find(j);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < eligible.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  const clusters = [];
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    let sum = 0;
    let n = 0;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const key = `${Math.min(indices[a], indices[b])},${Math.max(indices[a], indices[b])}`;
        const s = pairScores.get(key);
        if (s !== undefined) {
          sum += s;
          n++;
        }
      }
    }
    const members = indices.map((i) => eligible[i]);
    clusters.push({
      id: clusterId(members),
      confidence: n > 0 ? sum / n : CLUSTER_THRESHOLD,
      members,
    });
  }
  clusters.sort((a, b) => b.confidence - a.confidence);
  return clusters;
}

// --- call sites ---------------------------------------------------------------

/** Count `<Name` usages per component name across all parsed files. This is
 * name-based, not import-resolved — good enough to rank clusters. */
function countCallSites(programs, names) {
  const counts = new Map();
  for (const name of names) counts.set(name, 0);
  for (const program of programs) {
    walk(program, (n) => {
      if (n.type === "JSXOpeningElement" && n.name?.type === "JSXIdentifier") {
        const tag = n.name.name;
        if (counts.has(tag)) counts.set(tag, counts.get(tag) + 1);
      }
    });
  }
  return counts;
}

// --- scan entry ---------------------------------------------------------------

/**
 * `scopeFiles` (relative paths) limits which components may cluster — the
 * "current canvas" scope. The whole project is still parsed either way so
 * call-site counts stay project-wide truth.
 */
export function scan(root, scopeFiles = null, emitProgress = () => {}) {
  const started = Date.now();
  const files = discoverFiles(root, COMPONENT_FILE_RE);
  const scope = scopeFiles ? new Set(scopeFiles) : null;

  const components = [];
  const programs = [];
  let skipped = 0;
  files.forEach((file, i) => {
    if (i % 25 === 0) emitProgress("inventory", i, files.length);
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        skipped++;
        return;
      }
      const program = parseSource(fs.readFileSync(file, "utf8")).program;
      programs.push(program);
      const rel = relOf(root, file);
      components.push(...extractComponents(program, rel));
    } catch {
      skipped++;
    }
  });

  const callSites = countCallSites(
    programs,
    new Set(components.map((c) => c.name)),
  );

  const inScope = scope
    ? components.filter((c) => scope.has(c.file))
    : components;

  const clusters = cluster(inScope, emitProgress).map((c) => ({
    id: c.id,
    confidence: c.confidence,
    totalCallSites: c.members.reduce(
      (sum, m) => sum + (callSites.get(m.name) ?? 0),
      0,
    ),
    members: c.members.map((m) => ({
      name: m.name,
      file: m.file,
      line: m.line,
      col: m.col,
      exportKind: m.exportKind,
      props: m.props,
      nodeCount: m.nodeCount,
      callSites: callSites.get(m.name) ?? 0,
      classTokens: m.classTokens,
      skeleton: m.skeleton,
    })),
  }));

  // Artboard gallery: every in-scope component big enough to matter visually,
  // annotated with its cluster when it has one.
  const clusterOf = new Map();
  for (const c of clusters) {
    for (const m of c.members) clusterOf.set(`${m.file}#${m.name}`, c.id);
  }
  const gallery = inScope.filter(qualifiesForGallery).map((c) => ({
    name: c.name,
    file: c.file,
    line: c.line,
    col: c.col,
    exportKind: c.exportKind,
    props: c.props,
    nodeCount: c.nodeCount,
    callSites: callSites.get(c.name) ?? 0,
    clusterId: clusterOf.get(`${c.file}#${c.name}`) ?? null,
    // Structural outline, for AI categorization + change detection (capped —
    // category decisions don't need 200 lines of tree).
    skeleton: c.skeleton.split("\n").slice(0, 30).join("\n"),
  }));

  return {
    ok: true,
    // Persisted-result schema: bump whenever the shape changes so restored
    // saves from older builds are discarded instead of crashing consumers.
    schema: 2,
    files: files.length,
    skipped,
    components: inScope.length,
    /** Scope actually applied: file count when canvas-scoped, null = project. */
    scopedFiles: scope ? scope.size : null,
    clusters,
    gallery,
    durationMs: Date.now() - started,
    scannedAt: started,
  };
}

// --- entry --------------------------------------------------------------------

// Only run the stdin loop when executed directly (tests import `scan`).
if (isMainModule(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    let result;
    try {
      const req = JSON.parse(input);
      if (req.cmd === "scan") {
        result = scan(req.root, req.files ?? null, (stage, done, total) => {
          process.stdout.write(
            JSON.stringify({ event: "progress", stage, done, total }) + "\n",
          );
        });
      } else {
        result = { ok: false, error: `unknown cmd: ${req.cmd}` };
      }
    } catch (e) {
      result = { ok: false, error: String(e?.message ?? e) };
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  });
}
