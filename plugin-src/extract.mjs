// dedup extract — inline duplicate detection (FR-5.10).
//
// The scan compares *named components* to each other. This looks for the other
// half of the same problem: markup that was never a component at all — the
// same styled `<button>` pasted into twelve pages. The scan cannot see it by
// construction, because its unit of comparison is a component's whole tree,
// and an inline button is three nodes buried inside a page's.
//
// Same division of labour as the merge (see `lib/mergeProposal.ts`): detection
// here is deterministic and model-free, and the model is asked only for the
// thing static analysis genuinely cannot do — what the extracted component
// should be called and what its API should be. Everything this file reports is
// reproducible from the source alone.
//
// Two commands:
//
//   extract  read-only. Candidate groups of identical-shaped subtrees, each
//            with the deterministic report of exactly what varies between its
//            occurrences — which is the prop signature, computed before the
//            model sees anything.
//
// (`apply` lives in the codemod, not here — this half never writes.)
//
// Runs as a one-shot node process: JSON request on stdin, progress lines + one
// final JSON line on stdout, like the scan.

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
import {
  djb2,
  isLayoutKnob,
  jaccard,
  jsxTagName,
  knobOf,
  staticClassTokens,
} from "./jsxfacts.mjs";

// --- tunables ----------------------------------------------------------------

/** Below this a subtree isn't worth naming: `<div className="flex">` is not a
 *  component waiting to happen, however many times it appears. Weight counts
 *  elements + static class tokens + attributes, so it rises with how much
 *  *decision* the markup carries rather than with how big it is. */
const MIN_WEIGHT = 5;

/** How many copies before it's duplication rather than a coincidence. */
const MIN_OCCURRENCES = 3;

/** Class agreement required to call two same-shaped subtrees the same thing.
 *  Higher than the scan's 0.8 cluster threshold on purpose: these are supposed
 *  to be literal pastes, and the shape already matched exactly. */
const CLASS_THRESHOLD = 0.75;

/** Above this many same-shaped subtrees, skip the pairwise pass and group by
 *  exact knob set — a bucket that large is `<div><span/></div>`, and O(n²) on
 *  it buys nothing. */
const MAX_BUCKET = 400;

/** Candidates returned. Ranked by value, so the tail is noise by definition. */
const MAX_CANDIDATES = 100;

// --- subtree model -----------------------------------------------------------

// --- preview markup ---------------------------------------------------------
//
// A drift occurrence has no name and no export, so it cannot be rendered the
// way the component harness renders a component (import the module, mount the
// export). What it does have is markup — so the preview is built here, from
// the tree that was just parsed, and handed to a harness that only has to drop
// it into a page carrying the project's own stylesheet. Same Tailwind, same
// pixels, no module to import.
//
// It is a *picture*, not a translation: event handlers and computed values are
// dropped rather than approximated, because a preview that invented an `href`
// or a `disabled` state would be lying about the thing the user is judging.

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "source", "track", "wbr",
]);

/** Attributes worth keeping: static strings that change how it looks. An
 *  expression value (`onClick={…}`, `disabled={busy}`) is dropped — its
 *  runtime value is exactly what a static preview cannot know. */
const SKIP_ATTRS = /^(?:key|ref|on[A-Z]|dangerouslySetInnerHTML$)/;

const escapeHtml = (t) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (t) => escapeHtml(t).replace(/"/g, "&quot;");

/** Display text for an expression child. A string literal inside it is the
 *  label the user actually sees (`{saving ? "Saving…" : "Save"}` → `Saving…`),
 *  so prefer that; otherwise show the expression, which reads as the
 *  placeholder it is. */
function expressionText(expr) {
  const literal = expr.match(/["'`]([^"'`\n]{1,60})["'`]/);
  return literal ? literal[1] : expr.trim();
}

function openTag(node) {
  const attrs = [];
  if (node.classes.length > 0) {
    attrs.push(` class="${escapeAttr(node.classes.join(" "))}"`);
  }
  for (const a of node.attrs) {
    if (SKIP_ATTRS.test(a.name)) continue;
    if (!a.text) continue;
    const m = a.text.match(/^"([^"]*)"$|^'([^']*)'$/);
    if (!m) continue; // an expression — unknowable statically
    attrs.push(` ${a.name}="${escapeAttr(m[1] ?? m[2] ?? "")}"`);
  }
  return attrs.join("");
}

/**
 * Build the comparable form of one JSX element and everything under it.
 *
 * Returns null for a fragment: a fragment has no tag to key on and no single
 * element to replace it with, so it is not an extraction candidate (its
 * children still are, and are reached separately).
 */
function buildNode(el, code) {
  if (el.type !== "JSXElement") return null;
  const opening = el.openingElement;

  const attrs = [];
  let hasSpread = false;
  let dynamicClass = false;
  for (const a of opening.attributes) {
    if (a.type === "JSXSpreadAttribute") {
      hasSpread = true;
      continue;
    }
    const n = a.name;
    const name =
      n?.type === "JSXNamespacedName"
        ? `${n.namespace?.name}:${n.name?.name}`
        : n?.name;
    if (!name) continue;
    if (name === "className") continue; // handled by staticClassTokens
    attrs.push({
      name,
      // Source text, not a parsed value: an attribute is either the same
      // between two occurrences or it isn't, and the source is the only
      // spelling that survives `onClick={() => save(id)}`.
      text: a.value ? code.slice(a.value.start, a.value.end) : null,
    });
  }

  const classAttr = opening.attributes.find(
    (a) => a.type === "JSXAttribute" && a.name?.name === "className",
  );
  const classes = staticClassTokens(opening);
  if (classAttr && classes.length === 0) dynamicClass = true;

  const children = [];
  const texts = [];
  // Preview markup is assembled here rather than from `children` + `texts`,
  // which are separate arrays and so have lost the order the two appeared in.
  // `<button><Icon/>Save</button>` and `<button>Save<Icon/></button>` are
  // different pictures.
  const inner = [];
  for (const c of el.children ?? []) {
    if (c.type === "JSXElement") {
      const child = buildNode(c, code);
      if (child) {
        children.push(child);
        inner.push(child.html);
      }
    } else if (c.type === "JSXText") {
      const t = c.value.trim();
      if (t) {
        texts.push(t);
        inner.push(escapeHtml(t));
      }
    } else if (c.type === "JSXExpressionContainer") {
      if (c.expression?.type === "JSXEmptyExpression") continue; // a comment
      const expr = code.slice(c.expression.start, c.expression.end);
      texts.push(`{${expr.length > 200 ? `${expr.slice(0, 200)}…` : expr}}`);
      // JSX inside the expression still shapes the subtree, so `{items.map(i =>
      // <li/>)}` contributes an `li` exactly as the scan's walk does.
      const nested = [];
      walk(c.expression, (n) => {
        if (n.type === "JSXElement") {
          const child = buildNode(n, code);
          if (child) {
            children.push(child);
            nested.push(child.html);
          }
          return false;
        }
      });
      inner.push(nested.length > 0 ? nested.join("") : escapeHtml(expressionText(expr)));
    }
  }

  const node = {
    tag: jsxTagName(opening.name),
    classes,
    attrs,
    texts,
    children,
    start: el.start,
    end: el.end,
    line: el.loc?.start.line ?? 0,
    col: el.loc?.start.column ?? 0,
  };
  // A component child (`<InboxIcon className="h-7 w-7"/>`) has no HTML form,
  // so it renders as an empty box carrying its own classes — which is enough
  // for its sizing to hold the layout together.
  const tagName = /^[a-z]/.test(node.tag) ? node.tag : null;
  const attrHtml = openTag(node);
  node.html = tagName
    ? VOID_TAGS.has(tagName)
      ? `<${tagName}${attrHtml}>`
      : `<${tagName}${attrHtml}>${inner.join("")}</${tagName}>`
    : `<span${attrHtml}>${inner.join("")}</span>`;

  node.shape = `${node.tag}(${children.map((c) => c.shape).join(",")})`;
  node.elements = 1 + children.reduce((n, c) => n + c.elements, 0);
  node.weight =
    1 +
    classes.length +
    attrs.length +
    children.reduce((n, c) => n + c.weight, 0);
  node.hasSpread = hasSpread || children.some((c) => c.hasSpread);
  node.dynamicClass = dynamicClass || children.some((c) => c.dynamicClass);
  return node;
}

/** Pre-order node list. Two subtrees with the same `shape` produce lists of
 *  the same length whose entries correspond — which is what makes the variance
 *  report below a per-node comparison rather than a diff. */
function preorder(node, out = []) {
  out.push(node);
  for (const c of node.children) preorder(c, out);
  return out;
}

/** Every node in the subtree, each of which is itself a candidate root. */
const allNodes = (root) => preorder(root);

function skeletonOf(node, shared, index = { i: 0 }, depth = 0, lines = []) {
  const cls = shared[index.i] ?? [];
  lines.push("  ".repeat(depth) + node.tag + (cls.length ? ` .${cls.join(" .")}` : ""));
  index.i++;
  for (const c of node.children) skeletonOf(c, shared, index, depth + 1, lines);
  return lines;
}

// --- per-file collection -----------------------------------------------------

/** Capitalized function declarations, innermost-first, so an occurrence can
 *  say which component it was found in. */
function componentRanges(program) {
  const ranges = [];
  walk(program, (node) => {
    if (
      node.type === "FunctionDeclaration" &&
      node.id &&
      /^[A-Z]/.test(node.id.name)
    ) {
      ranges.push({ name: node.id.name, start: node.start, end: node.end });
    } else if (
      node.type === "VariableDeclarator" &&
      node.id?.type === "Identifier" &&
      /^[A-Z]/.test(node.id.name) &&
      node.init
    ) {
      ranges.push({ name: node.id.name, start: node.start, end: node.end });
    }
  });
  // Innermost wins: a nested component's range is contained in its parent's.
  ranges.sort((a, b) => a.end - a.start - (b.end - b.start));
  return ranges;
}

const enclosing = (ranges, node) =>
  ranges.find((r) => r.start <= node.start && node.end <= r.end)?.name ?? null;

/** Every extraction candidate in one parsed file. */
function collectFile(program, code, rel, minWeight) {
  const ranges = componentRanges(program);
  const roots = [];
  walk(program, (n) => {
    if (n.type === "JSXElement") {
      const built = buildNode(n, code);
      if (built) roots.push(built);
      return false; // children are reached through the built tree
    }
    if (n.type === "JSXFragment") return undefined; // descend into its children
  });

  // A component whose entire body is one JSX root: if that root turns up as an
  // occurrence, the canonical component the user is looking for already exists.
  const soleReturn = new Map(); // "start:end" -> component name
  const byComponent = new Map();
  for (const root of roots) {
    const owner = enclosing(ranges, root);
    if (!owner) continue;
    if (!byComponent.has(owner)) byComponent.set(owner, []);
    byComponent.get(owner).push(root);
  }
  for (const [name, list] of byComponent) {
    if (list.length === 1) soleReturn.set(`${list[0].start}:${list[0].end}`, name);
  }

  const out = [];
  for (const root of roots) {
    for (const node of allNodes(root)) {
      if (!/^[a-z]/.test(node.tag)) continue; // already a component, not markup
      if (node.weight < minWeight) continue;
      out.push({
        file: rel,
        node,
        component: enclosing(ranges, node),
        existingComponent: soleReturn.get(`${node.start}:${node.end}`) ?? null,
        source: code.slice(node.start, node.end),
      });
    }
  }
  return out;
}

// --- grouping ----------------------------------------------------------------

function classSets(occ) {
  const tokens = new Set();
  for (const n of allNodes(occ.node)) for (const c of n.classes) tokens.add(c);
  const knobs = new Set([...tokens].map(knobOf));
  return { tokens, knobs };
}

/** Same blend the scan uses: mostly "same control", partly "same value". */
function classSimilarity(a, b) {
  const knob = jaccard(a.knobs, b.knobs);
  const token = jaccard(a.tokens, b.tokens);
  if (knob === null) return 1; // neither styles anything — identical absence
  return 0.6 * knob + 0.4 * token;
}

function groupBucket(bucket) {
  if (bucket.length > MAX_BUCKET) {
    // Too many to compare pairwise; fall back to exact knob identity.
    const byKey = new Map();
    for (const occ of bucket) {
      const key = [...occ.sets.knobs].sort().join(" ");
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(occ);
    }
    return [...byKey.values()];
  }

  const parent = bucket.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      if (classSimilarity(bucket[i].sets, bucket[j].sets) >= CLASS_THRESHOLD) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < bucket.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(bucket[i]);
  }
  return [...groups.values()];
}

// --- variance ----------------------------------------------------------------

/**
 * What differs between occurrences, per node — the prop signature, derived
 * before any model is involved.
 *
 * Because the group's members share an exact shape, their pre-order node lists
 * line up index for index, so this is a column-wise comparison rather than a
 * diff. Three kinds of variation, and they mean different things:
 *
 *  - a **layout** class knob that varies belongs at the call site (see
 *    `LAYOUT_KNOBS`) — bake `mt-4` into a shared button and it fights every
 *    later use of it;
 *  - a **visual** class knob that varies is a variant;
 *  - an attribute or text that varies is a plain prop.
 */
function varianceOf(occs) {
  const lists = occs.map((o) => allNodes(o.node));
  const n = lists[0].length;
  const classes = [];
  const attrs = [];
  const texts = [];
  const shared = [];

  for (let i = 0; i < n; i++) {
    const nodes = lists.map((l) => l[i]);

    // Classes, keyed by knob so `bg-blue-600` and `bg-red-600` are one row.
    const byKnob = new Map();
    for (const node of nodes) {
      for (const token of node.classes) {
        const k = knobOf(token);
        if (!byKnob.has(k)) byKnob.set(k, new Map());
        byKnob.get(k).set(node, token);
      }
    }
    const sharedHere = [];
    for (const [knob, perNode] of byKnob) {
      const values = nodes.map((node) => perNode.get(node) ?? null);
      const distinct = new Set(values);
      if (distinct.size === 1 && !values.includes(null)) {
        sharedHere.push(values[0]);
      } else {
        classes.push({ node: i, knob, layout: isLayoutKnob(knob), values });
      }
    }
    shared.push(sharedHere.sort());

    // Attributes.
    const names = new Set();
    for (const node of nodes) for (const a of node.attrs) names.add(a.name);
    for (const name of names) {
      const values = nodes.map(
        (node) => node.attrs.find((a) => a.name === name)?.text ?? null,
      );
      if (new Set(values).size > 1) attrs.push({ node: i, name, values });
    }

    // Text and expression children.
    const textValues = nodes.map((node) => node.texts.join(" "));
    if (new Set(textValues).size > 1) texts.push({ node: i, values: textValues });
  }

  return { classes, attrs, texts, shared };
}

// --- extract entry -----------------------------------------------------------

/**
 * `scopeFiles` (relative paths) limits which files may contribute occurrences,
 * the same "current canvas" scope the scan takes.
 */
export function extract(root, options = {}, emitProgress = () => {}) {
  const started = Date.now();
  const {
    files: scopeFiles = null,
    minOccurrences = MIN_OCCURRENCES,
    minWeight = MIN_WEIGHT,
  } = options;

  const discovered = discoverFiles(root, COMPONENT_FILE_RE);
  const scope = scopeFiles ? new Set(scopeFiles) : null;

  const occurrences = [];
  let skipped = 0;
  discovered.forEach((file, i) => {
    if (i % 25 === 0) emitProgress("inventory", i, discovered.length);
    const rel = relOf(root, file);
    if (scope && !scope.has(rel)) return;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        skipped++;
        return;
      }
      const code = fs.readFileSync(file, "utf8");
      occurrences.push(
        ...collectFile(parseSource(code).program, code, rel, minWeight),
      );
    } catch {
      skipped++;
    }
  });

  for (const occ of occurrences) occ.sets = classSets(occ);

  const buckets = new Map();
  for (const occ of occurrences) {
    const key = occ.node.shape;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(occ);
  }

  let done = 0;
  const groups = [];
  for (const bucket of buckets.values()) {
    if (++done % 200 === 0) emitProgress("grouping", done, buckets.size);
    if (bucket.length < minOccurrences) continue;
    for (const group of groupBucket(bucket)) {
      // An occurrence dedup cannot describe is not silently dropped — it is
      // reported alongside the ones it would have joined.
      const usable = [];
      const refused = [];
      for (const occ of group) {
        const reason = occ.node.hasSpread
          ? "spread attributes — the prop signature can't be known"
          : occ.node.dynamicClass
            ? "computed className — the classes can't be read statically"
            : null;
        (reason ? refused : usable).push(reason ? { occ, reason } : occ);
      }
      if (usable.length < minOccurrences) continue;
      groups.push({ usable, refused });
    }
  }

  // Value = how much markup this actually removes. Also the nesting order:
  // when a button and the card containing it are both candidates, the card is
  // worth more, claims its range first, and the button's copies inside it are
  // then no longer separately extractable.
  const valueOf = (g) => g.usable.length * g.usable[0].node.weight;
  groups.sort((a, b) => valueOf(b) - valueOf(a));

  const claimed = new Map(); // file -> [[start, end], …]
  const overlaps = (file, node) =>
    (claimed.get(file) ?? []).some(([s, e]) => node.start < e && s < node.end);

  const candidates = [];
  for (const group of groups) {
    if (candidates.length >= MAX_CANDIDATES) break;
    const kept = [];
    for (const occ of group.usable) {
      if (overlaps(occ.file, occ.node)) continue;
      kept.push(occ);
      if (!claimed.has(occ.file)) claimed.set(occ.file, []);
      claimed.get(occ.file).push([occ.node.start, occ.node.end]);
    }
    if (kept.length < minOccurrences) continue;

    const variance = varianceOf(kept);
    const id = djb2(
      kept
        .map((o) => `${o.file}:${o.node.start}`)
        .sort()
        .join("|"),
    );
    candidates.push({
      id,
      tag: kept[0].node.tag,
      shape: kept[0].node.shape,
      elements: kept[0].node.elements,
      weight: kept[0].node.weight,
      fileCount: new Set(kept.map((o) => o.file)).size,
      /** Total source bytes currently spent on the copies. */
      bytes: kept.reduce((n, o) => n + o.source.length, 0),
      /** Elements the extraction removes from the codebase. */
      elementsRemoved: kept[0].node.elements * (kept.length - 1),
      /** The shared structure, with only the classes every copy agrees on. */
      skeleton: skeletonOf(kept[0].node, variance.shared).join("\n"),
      /** A copy that is already a component's whole body — the canonical one
       *  the user is looking for may already exist. */
      existing:
        kept.find((o) => o.existingComponent)
          ? {
              file: kept.find((o) => o.existingComponent).file,
              name: kept.find((o) => o.existingComponent).existingComponent,
            }
          : null,
      occurrences: kept.map((o) => ({
        file: o.file,
        line: o.node.line,
        col: o.node.col,
        start: o.node.start,
        end: o.node.end,
        component: o.component,
        source: o.source,
        /** Static markup for the preview harness — see the note above
         *  VOID_TAGS. Not a translation of the JSX, a picture of it. */
        html: o.node.html,
      })),
      varies: {
        classes: variance.classes,
        attrs: variance.attrs,
        texts: variance.texts,
      },
      refused: group.refused.map((r) => ({
        file: r.occ.file,
        line: r.occ.node.line,
        reason: r.reason,
      })),
    });
  }

  return {
    ok: true,
    schema: 1,
    files: discovered.length,
    skipped,
    candidates,
    durationMs: Date.now() - started,
    scannedAt: started,
  };
}

// --- entry -------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    let result;
    try {
      const req = JSON.parse(input);
      if (req.cmd === "extract") {
        result = extract(req.root, req, (stage, done, total) => {
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
