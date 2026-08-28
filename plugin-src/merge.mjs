// dedup merge — the guarded-merge codemod (FR-5.4, FR-5.5, FR-5.8).
//
// Two commands, deliberately split so nothing is written before the user has
// seen it:
//
//   plan   read-only. Everything a merge proposal needs: each member's full
//          source, its prop signature, its behaviour signals, and every call
//          site traced through a real import (see resolve.mjs — a name match
//          is not a call site). This is also what the model is shown.
//
//   apply  takes a canonical component (model-written, user-reviewed) plus a
//          per-member prop mapping, and produces the whole rewritten world:
//          canonical file, every call-site file, and the members staged for
//          deletion. `dryRun` returns before/after for review and writes
//          nothing; without it the same computation is written to disk.
//
// The safety model is the same one the class write-back uses, applied across
// files instead of within one: every output is re-parsed before ANY file is
// touched, and the writes then happen together. A merge that would leave the
// project half-rewritten does not happen at all — and since a merge spans
// files, "all or nothing" is the only version of it that is safe.
//
// Runs as a one-shot node process: JSON on stdin, one JSON line on stdout.

import MagicString from "magic-string";
import fs from "node:fs";
import path from "node:path";
import {
  SOURCE_FILE_RE,
  discoverFiles,
  isMainModule,
  parseSource,
  parseStrict,
  relOf,
  walk,
} from "./files.mjs";
import { readAliases, resolveSpecifier, specifierFor } from "./resolve.mjs";

const TRASH_DIR = ".dedup-trash";

// --- module surface ---------------------------------------------------------

/** Local name → what it refers to, for every import binding in a module. */
function importBindings(program, file, aliases) {
  const bindings = new Map();
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    const resolved = resolveSpecifier(stmt.source.value, file, aliases);
    for (const spec of stmt.specifiers) {
      const local = spec.local?.name;
      if (!local) continue;
      bindings.set(local, {
        local,
        imported:
          spec.type === "ImportDefaultSpecifier"
            ? "default"
            : spec.type === "ImportNamespaceSpecifier"
              ? "*"
              : (spec.imported?.name ?? spec.imported?.value ?? local),
        source: stmt.source.value,
        resolved,
        decl: stmt,
        spec,
        typeOnly: stmt.importKind === "type" || spec.importKind === "type",
      });
    }
  }
  return bindings;
}

/** Top-level names a module declares itself (so a local component counts). */
function localDeclarations(program) {
  const names = new Set();
  for (const stmt of program.body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
        ? stmt.declaration
        : stmt;
    if (!decl) continue;
    if (decl.type === "FunctionDeclaration" && decl.id) names.add(decl.id.name);
    else if (decl.type === "ClassDeclaration" && decl.id) names.add(decl.id.name);
    else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id?.type === "Identifier") names.add(d.id.name);
      }
    }
  }
  return names;
}

/** Every name bound at module scope — what a new import must not collide with. */
function takenNames(program) {
  const names = localDeclarations(program);
  for (const stmt of program.body) {
    if (stmt.type !== "ImportDeclaration") continue;
    for (const spec of stmt.specifiers) {
      if (spec.local?.name) names.add(spec.local.name);
    }
  }
  return names;
}

/** name → "default" | "named", for the module's exports. */
function exportKinds(program) {
  const map = new Map();
  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration;
      if (decl?.type === "FunctionDeclaration" && decl.id) map.set(decl.id.name, "named");
      else if (decl?.type === "VariableDeclaration") {
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
      else map.set("default", "default");
    }
  }
  return map;
}

// --- component extraction ----------------------------------------------------

function unwrapToFunction(node) {
  if (!node) return null;
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
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

/** The statement that declares `name` as a component, with its source range.
 * The range starts at the `export` keyword when there is one, so lifting the
 * declaration out carries its export with it. */
function declarationOf(program, name) {
  for (const stmt of program.body) {
    const inner =
      stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration"
        ? stmt.declaration
        : stmt;
    if (!inner) continue;
    if (inner.type === "FunctionDeclaration" && inner.id?.name === name) {
      return { stmt, fn: inner };
    }
    if (inner.type === "VariableDeclaration") {
      for (const d of inner.declarations) {
        if (d.id?.type === "Identifier" && d.id.name === name) {
          return { stmt, fn: unwrapToFunction(d.init) ?? d.init };
        }
      }
    }
  }
  return null;
}

function propNames(fn) {
  const p = fn?.params?.[0];
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

/**
 * Behaviour signals (FR-5.8). Markup and classes are what the similarity score
 * compares; handlers, hooks and other logic are not — so two components can
 * score as near-identical while doing different things. Surfacing them is the
 * difference between "merge these" and "merge these and silently drop a
 * tracking call".
 */
function behaviorOf(fn, code) {
  const hooks = new Set();
  const handlers = new Set();
  const calls = new Set();
  if (!fn) return { hooks: [], handlers: [], calls: [], statements: 0 };
  let statements = 0;
  walk(fn.body ?? fn, (n) => {
    if (n.type === "CallExpression") {
      const callee = n.callee;
      if (callee?.type === "Identifier") {
        if (/^use[A-Z]/.test(callee.name)) hooks.add(callee.name);
        else calls.add(callee.name);
      } else if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") {
        const objName = callee.object?.type === "Identifier" ? callee.object.name : null;
        // `items.map` is markup, not behaviour — it's already in the tree.
        if (callee.property.name !== "map" && objName) {
          calls.add(`${objName}.${callee.property.name}`);
        }
      }
    }
    if (n.type === "JSXAttribute" && /^on[A-Z]/.test(n.name?.name ?? "")) {
      const value = n.value;
      const text =
        value?.type === "JSXExpressionContainer"
          ? code.slice(value.expression.start, value.expression.end)
          : "";
      handlers.add(`${n.name.name}=${text.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    if (n.type?.endsWith("Statement") && n.type !== "BlockStatement") statements++;
  });
  return {
    hooks: [...hooks].sort(),
    handlers: [...handlers].sort(),
    calls: [...calls].sort(),
    statements,
  };
}

/** Do the members differ in behaviour, not just markup? (FR-5.8) */
function behaviorDiff(members) {
  const signature = (m) =>
    JSON.stringify([m.behavior.hooks, m.behavior.handlers, m.behavior.calls]);
  const first = signature(members[0]);
  const differing = members.filter((m) => signature(m) !== first);
  if (differing.length === 0) return { differs: false, detail: null };

  const union = (key) => {
    const all = new Set();
    for (const m of members) for (const v of m.behavior[key]) all.add(v);
    return [...all];
  };
  const varying = [];
  for (const key of ["hooks", "handlers", "calls"]) {
    for (const value of union(key)) {
      const has = members.filter((m) => m.behavior[key].includes(value));
      if (has.length !== members.length) {
        varying.push(
          `${value} — only in ${has.map((m) => m.name).join(", ") || "none"}`,
        );
      }
    }
  }
  return {
    differs: true,
    detail: varying.slice(0, 12).join("; "),
  };
}

// --- call sites --------------------------------------------------------------

/** Serialize one JSX attribute back to source text, for the review + prompt. */
function attrText(attr, code) {
  if (attr.type === "JSXSpreadAttribute") {
    return { name: null, spread: true, text: code.slice(attr.start, attr.end) };
  }
  return {
    name: attr.name?.name ?? String(attr.name?.namespace?.name ?? "?"),
    spread: false,
    text: code.slice(attr.start, attr.end),
    value:
      attr.value?.type === "StringLiteral"
        ? attr.value.value
        : attr.value
          ? code.slice(attr.value.start, attr.value.end)
          : null,
  };
}

/**
 * Every use of the given components, traced through imports. Returns one
 * record per JSX element, plus the parsed program of each touched file so the
 * rewrite doesn't have to parse twice.
 */
function findCallSites(root, targets, aliases, files) {
  const sites = [];
  const parsed = new Map();
  const byFile = new Map(); // absolute member file → target record

  for (const t of targets) byFile.set(t.abs, t);

  for (const file of files) {
    let code;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Cheap gate: no mention of any target name, no work to do.
    if (!targets.some((t) => code.includes(t.name))) continue;

    let program;
    try {
      program = parseSource(code).program;
    } catch {
      continue;
    }
    const bindings = importBindings(program, file, aliases);
    const locals = localDeclarations(program);

    /** Which target (if any) does this JSX tag name refer to here? */
    const targetOfTag = (tagName) => {
      const binding = bindings.get(tagName);
      if (binding) {
        if (binding.typeOnly || !binding.resolved) return null;
        const hit = byFile.get(binding.resolved);
        // A default import can be spelled anything; a named one must match.
        if (!hit) return null;
        if (binding.imported === "*") return null;
        if (binding.imported === "default") {
          return hit.exportKind === "default" ? hit : null;
        }
        return binding.imported === hit.name ? hit : null;
      }
      // Declared in this very file — only counts for the member that lives here.
      if (locals.has(tagName)) {
        const hit = byFile.get(file);
        return hit && hit.name === tagName ? hit : null;
      }
      return null;
    };

    let found = false;
    walk(program, (n) => {
      if (n.type !== "JSXElement") return;
      const nameNode = n.openingElement.name;
      if (nameNode.type !== "JSXIdentifier") return;
      const hit = targetOfTag(nameNode.name);
      if (!hit) return;
      found = true;
      sites.push({
        file: relOf(root, file),
        abs: file,
        component: hit.name,
        localName: nameNode.name,
        line: n.openingElement.loc.start.line,
        col: n.openingElement.loc.start.column,
        selfClosing: n.openingElement.selfClosing,
        attrs: n.openingElement.attributes.map((a) => attrText(a, code)),
        text: code.slice(n.start, Math.min(n.end, n.start + 400)),
      });
    });

    // Also record files that merely import a target (a re-export barrel, or a
    // type-only use): their imports still have to be fixed up.
    for (const b of bindings.values()) {
      if (b.resolved && byFile.has(b.resolved)) found = true;
    }
    if (found) parsed.set(file, { code, program, bindings, locals });
  }
  return { sites, parsed };
}

/**
 * `export { X } from "./member"` / `export * from "./member"` anywhere in the
 * project. These bindings never appear as imports, so the call-site rewrite
 * cannot see them — and the module they name is about to be retired.
 */
function findReExports(root, targets, aliases, files) {
  const byFile = new Map(targets.map((t) => [path.resolve(t.abs), t]));
  const hits = [];
  for (const file of files) {
    let code;
    try {
      code = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!code.includes("export")) continue;
    let program;
    try {
      program = parseSource(code).program;
    } catch {
      continue;
    }
    for (const stmt of program.body) {
      const isReExport =
        (stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportAllDeclaration") &&
        stmt.source;
      if (!isReExport) continue;
      const resolved = resolveSpecifier(stmt.source.value, file, aliases);
      const hit = resolved ? byFile.get(path.resolve(resolved)) : null;
      if (!hit) continue;
      if (stmt.type === "ExportAllDeclaration") {
        hits.push({ file: relOf(root, file), name: `* from ${stmt.source.value}` });
        continue;
      }
      for (const spec of stmt.specifiers ?? []) {
        const local = spec.local?.name ?? spec.exported?.name;
        if (local === hit.name || local === "default") {
          hits.push({ file: relOf(root, file), name: hit.name });
        }
      }
    }
  }
  return hits;
}

/** Non-import references to `name` anywhere in the module (does the binding
 * still have a job after the JSX uses are rewritten?). */
function referenceCount(program, name) {
  let count = 0;
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") continue;
    walk(stmt, (n) => {
      if (n.type === "Identifier" && n.name === name) count++;
      else if (n.type === "JSXIdentifier" && n.name === name) count++;
    });
  }
  return count;
}

// --- plan --------------------------------------------------------------------

function plan({ root, members }) {
  if (!Array.isArray(members) || members.length < 2) {
    return { ok: false, error: "a merge needs at least two components" };
  }
  const aliases = readAliases(root);
  const files = discoverFiles(root, SOURCE_FILE_RE);

  const targets = [];
  for (const m of members) {
    const abs = path.resolve(root, m.file);
    let code;
    try {
      code = fs.readFileSync(abs, "utf8");
    } catch {
      return { ok: false, error: `cannot read ${m.file}` };
    }
    let program;
    try {
      program = parseSource(code).program;
    } catch (e) {
      return { ok: false, error: `cannot parse ${m.file}: ${e.message}` };
    }
    const decl = declarationOf(program, m.name);
    if (!decl) {
      return {
        ok: false,
        error: `${m.name} is no longer declared in ${m.file} — rescan and try again`,
      };
    }
    const kinds = exportKinds(program);
    targets.push({
      name: m.name,
      file: relOf(root, abs),
      abs,
      code,
      program,
      exportKind: kinds.get(m.name) ?? "local",
      source: code.slice(decl.stmt.start, decl.stmt.end),
      props: propNames(decl.fn),
      behavior: behaviorOf(decl.fn, code),
      // Everything else the file declares — tells the apply step whether the
      // file can be retired wholesale or has to stay.
      otherDeclarations: [...localDeclarations(program)].filter((n) => n !== m.name),
    });
  }

  const { sites } = findCallSites(root, targets, aliases, files);

  // Rank the members: the one with the most call sites is the natural
  // canonical home — merging into it leaves the fewest files to rewrite.
  const useCount = new Map(targets.map((t) => [t.name, 0]));
  for (const s of sites) useCount.set(s.component, (useCount.get(s.component) ?? 0) + 1);
  const canonical = [...targets].sort(
    (a, b) => (useCount.get(b.name) ?? 0) - (useCount.get(a.name) ?? 0),
  )[0];

  return {
    ok: true,
    canonicalSuggestion: { name: canonical.name, file: canonical.file },
    members: targets.map((t) => ({
      name: t.name,
      file: t.file,
      exportKind: t.exportKind,
      source: t.source,
      props: t.props,
      behavior: t.behavior,
      otherDeclarations: t.otherDeclarations,
      callSites: useCount.get(t.name) ?? 0,
      /** The file holds nothing else — it can be retired with the merge. */
      fileIsDedicated: t.otherDeclarations.length === 0,
    })),
    callSites: sites.map((s) => ({
      file: s.file,
      component: s.component,
      localName: s.localName,
      line: s.line,
      col: s.col,
      attrs: s.attrs,
      text: s.text,
    })),
    behaviorDiff: behaviorDiff(targets),
    // Surfaced here, not just refused at apply time: the user should know a
    // barrel is in the way before spending a model call on a proposal.
    reExports: findReExports(root, targets, aliases, files),
    filesScanned: files.length,
  };
}

// --- apply -------------------------------------------------------------------

/** Render a props map ({ variant: "compact", elevated: true }) as JSX attrs. */
function renderProps(props) {
  const out = [];
  for (const [name, value] of Object.entries(props ?? {})) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new Error(`refusing unsafe prop name: ${name}`);
    }
    if (value === true) out.push(name);
    else if (typeof value === "string") {
      if (/["\\\n\r]/.test(value)) throw new Error(`refusing unsafe prop value for ${name}`);
      out.push(`${name}="${value}"`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      out.push(`${name}={${value}}`);
    } else if (value && typeof value === "object" && typeof value.expr === "string") {
      // Escape hatch for a raw expression, still parse-gated below.
      if (/[{}]/.test(value.expr)) throw new Error(`refusing nested braces for ${name}`);
      out.push(`${name}={${value.expr}}`);
    } else if (value === null || value === false || value === undefined) {
      continue; // "don't pass this prop"
    } else {
      throw new Error(`unsupported prop value for ${name}`);
    }
  }
  return out;
}

/**
 * Rewrite one file's call sites onto the canonical component: retag the JSX,
 * add the mapped props, drop the imports that no longer have a job, and add
 * the canonical import. Pure — returns the new text, or null when the file
 * needs no change.
 */
function rewriteCallSiteFile(
  ctx,
  { file, code, program, bindings },
  canonical,
  mappingByName,
) {
  const s = new MagicString(code);
  const aliases = ctx.aliases;
  const byFile = ctx.byFile;
  const locals = localDeclarations(program);
  let changed = false;

  const isCanonicalFile = path.resolve(file) === path.resolve(canonical.abs);

  // What the canonical component is called *in this file*. Reuse an existing
  // import when there is one; alias around a collision rather than shadowing
  // something the file already means by that name.
  let localCanonical = canonical.name;
  let existingCanonicalBinding = null;
  for (const b of bindings.values()) {
    if (b.resolved && path.resolve(b.resolved) === path.resolve(canonical.abs)) {
      const matches =
        b.imported === "*"
          ? false
          : b.imported === "default"
            ? canonical.exportKind === "default"
            : b.imported === canonical.name;
      if (matches) {
        existingCanonicalBinding = b;
        localCanonical = b.local;
        break;
      }
    }
  }
  if (isCanonicalFile) localCanonical = canonical.name;

  const mergedBindings = [...bindings.values()].filter(
    (b) => b.resolved && byFile.has(path.resolve(b.resolved)),
  );

  if (!existingCanonicalBinding && !isCanonicalFile) {
    const taken = takenNames(program);
    // A merged-away binding is about to be removed, so its name is free.
    for (const b of mergedBindings) taken.delete(b.local);
    if (taken.has(localCanonical)) {
      let n = 2;
      while (taken.has(`${canonical.name}${n}`)) n++;
      localCanonical = `${canonical.name}${n}`;
      ctx.warnings.push(
        `${relOf(ctx.root, file)} already binds \`${canonical.name}\` to something else — imported as \`${localCanonical}\``,
      );
    }
  }

  // 1. Retag every JSX use and fold in the mapped props.
  const rewrittenLocals = new Set();
  walk(program, (n) => {
    if (n.type !== "JSXElement") return;
    const nameNode = n.openingElement.name;
    if (nameNode.type !== "JSXIdentifier") return;
    const binding = bindings.get(nameNode.name);
    let member = null;
    if (binding) {
      if (binding.typeOnly || !binding.resolved) return;
      const hit = byFile.get(path.resolve(binding.resolved));
      if (!hit) return;
      if (binding.imported === "*") return;
      if (binding.imported === "default" ? hit.exportKind !== "default" : binding.imported !== hit.name) {
        return;
      }
      member = hit;
    } else if (locals.has(nameNode.name)) {
      const hit = byFile.get(path.resolve(file));
      if (!hit || hit.name !== nameNode.name) return;
      member = hit;
    } else {
      return;
    }

    rewrittenLocals.add(nameNode.name);
    if (nameNode.name !== localCanonical) {
      s.overwrite(nameNode.start, nameNode.end, localCanonical);
      const closing = n.closingElement?.name;
      if (closing) s.overwrite(closing.start, closing.end, localCanonical);
      changed = true;
    }

    const mapping = mappingByName.get(member.name);
    const added = renderProps(mapping?.props);
    if (added.length > 0) {
      const present = new Set(
        n.openingElement.attributes
          .filter((a) => a.type === "JSXAttribute")
          .map((a) => a.name?.name),
      );
      const toAdd = added.filter((a) => !present.has(a.split(/[=\s]/)[0]));
      if (toAdd.length > 0) {
        // After the props already written there, so the call site reads the
        // way someone would have typed it: given props first, variant last.
        const attrs = n.openingElement.attributes;
        const at =
          attrs.length > 0
            ? attrs[attrs.length - 1].end
            : (n.openingElement.typeArguments?.end ??
              n.openingElement.typeParameters?.end ??
              nameNode.end);
        s.appendLeft(at, " " + toAdd.join(" "));
        changed = true;
      }
    }
  });

  // 2. Retire the imports whose only job was the merged-away component.
  for (const b of mergedBindings) {
    if (b.typeOnly) continue;
    const stillUsed = referenceCount(program, b.local) > countJsxUses(program, b.local);
    if (stillUsed) {
      ctx.warnings.push(
        `${relOf(ctx.root, file)} still references \`${b.local}\` outside JSX — its import was kept`,
      );
      continue;
    }
    if (!rewrittenLocals.has(b.local)) continue; // nothing was rewritten; leave it
    removeImportSpecifier(s, code, b);
    changed = true;
  }

  // 3. Bring the canonical component in.
  if (!existingCanonicalBinding && !isCanonicalFile && rewrittenLocals.size > 0) {
    const spec = specifierFor(file, canonical.abs, aliases);
    const clause =
      canonical.exportKind === "default"
        ? localCanonical
        : localCanonical === canonical.name
          ? `{ ${canonical.name} }`
          : `{ ${canonical.name} as ${localCanonical} }`;
    const line = `import ${clause} from "${spec}";\n`;
    s.appendLeft(importAnchor(program, code), line);
    changed = true;
  }

  return changed ? s.toString() : null;
}

function countJsxUses(program, name) {
  let count = 0;
  walk(program, (n) => {
    if (n.type === "JSXIdentifier" && n.name === name) count++;
  });
  return count;
}

/** Where a new import line goes: after the last existing import, else the top
 * (below a "use client"-style directive, which must stay first). */
function importAnchor(program, code) {
  let last = null;
  for (const stmt of program.body) {
    if (stmt.type === "ImportDeclaration") last = stmt;
  }
  if (last) {
    const nl = code.indexOf("\n", last.end);
    return nl === -1 ? last.end : nl + 1;
  }
  const first = program.body[0];
  if (
    first?.type === "ExpressionStatement" &&
    first.expression?.type === "StringLiteral"
  ) {
    const nl = code.indexOf("\n", first.end);
    return nl === -1 ? first.end : nl + 1;
  }
  return 0;
}

/** Remove one specifier — or the whole declaration when it was the only one. */
function removeImportSpecifier(s, code, binding) {
  const decl = binding.decl;
  const specs = decl.specifiers;
  if (specs.length <= 1) {
    const start = code.lastIndexOf("\n", decl.start - 1) + 1;
    const nl = code.indexOf("\n", decl.end);
    s.remove(start, nl === -1 ? decl.end : nl + 1);
    return;
  }
  const i = specs.indexOf(binding.spec);
  // Swallow the neighbouring comma so the clause stays well-formed.
  const start = i === 0 ? binding.spec.start : specs[i - 1].end;
  const end = i === 0 ? specs[i + 1].start : binding.spec.end;
  s.remove(start, end);
}

/**
 * Compute the whole merge. Returns every file's before/after; `dryRun` stops
 * there (that IS the reviewable diff of FR-5.4), otherwise the outputs are
 * re-parsed and written together.
 */
function apply({ root, canonical, mapping, dryRun }) {
  if (!canonical?.name || !canonical?.file || typeof canonical.source !== "string") {
    return { ok: false, error: "canonical component missing name, file or source" };
  }
  if (!Array.isArray(mapping) || mapping.length === 0) {
    return { ok: false, error: "no components mapped onto the canonical one" };
  }
  const aliases = readAliases(root);
  const files = discoverFiles(root, SOURCE_FILE_RE);
  const canonicalAbs = path.resolve(root, canonical.file);

  // The canonical source is model output — it goes through the same gate as
  // any other generated write, before it can influence anything else.
  let canonicalProgram;
  try {
    canonicalProgram = parseStrict(canonical.source).program;
  } catch (e) {
    return { ok: false, error: `the proposed component does not parse: ${e.message}` };
  }
  const canonicalExports = exportKinds(canonicalProgram);
  const canonicalExportKind = canonicalExports.get(canonical.name);
  if (!canonicalExportKind) {
    return {
      ok: false,
      error: `the proposed component does not export \`${canonical.name}\``,
    };
  }

  // Resolve the merged-away members.
  const targets = [];
  for (const m of mapping) {
    const abs = path.resolve(root, m.file);
    let code;
    try {
      code = fs.readFileSync(abs, "utf8");
    } catch {
      return { ok: false, error: `cannot read ${m.file}` };
    }
    let program;
    try {
      program = parseSource(code).program;
    } catch (e) {
      return { ok: false, error: `cannot parse ${m.file}: ${e.message}` };
    }
    if (!declarationOf(program, m.name)) {
      return {
        ok: false,
        error: `${m.name} is no longer declared in ${m.file} — rescan and try again`,
      };
    }
    targets.push({
      name: m.name,
      abs,
      file: relOf(root, abs),
      exportKind: exportKinds(program).get(m.name) ?? "local",
      program,
      code,
      otherDeclarations: [...localDeclarations(program)].filter((n) => n !== m.name),
      props: m.props ?? {},
    });
  }

  const canonicalTarget = {
    name: canonical.name,
    abs: canonicalAbs,
    exportKind: canonicalExportKind,
  };

  // Merging *into* an existing file replaces that whole file, so anything else
  // it exported has to survive — otherwise every unrelated importer of that
  // module breaks. This is checkable, so it is checked rather than trusted.
  if (fs.existsSync(canonicalAbs)) {
    try {
      const previous = exportKinds(parseSource(fs.readFileSync(canonicalAbs, "utf8")).program);
      const dropped = [...previous.keys()].filter(
        (name) => !canonicalExports.has(name) && !mapping.some((m) => m.name === name),
      );
      if (dropped.length > 0) {
        return {
          ok: false,
          error: `the proposed ${relOf(root, canonicalAbs)} drops exports the file already had (${dropped.join(", ")}) — every importer of those would break`,
        };
      }
    } catch {
      // Unparseable current file: the new one parses, which is the gate that
      // matters, and there are no exports we could have promised to keep.
    }
  }

  // Members that keep their own file are not "merged away" from the codemod's
  // point of view — the canonical file is one of them when merging in place.
  const merged = targets.filter((t) => path.resolve(t.abs) !== canonicalAbs);
  const byFile = new Map(merged.map((t) => [path.resolve(t.abs), t]));
  // Call sites in the canonical file that use the *old* local name still need
  // retagging when the canonical component was renamed.
  const inPlace = targets.find((t) => path.resolve(t.abs) === canonicalAbs);
  if (inPlace && inPlace.name !== canonical.name) {
    byFile.set(canonicalAbs, inPlace);
  }

  const ctx = { root, aliases, byFile, warnings: [] };
  const mappingByName = new Map(targets.map((t) => [t.name, t]));

  const outputs = new Map(); // absolute path → new content
  const originals = new Map();

  // 1. The canonical component's own file.
  let canonicalBefore = "";
  try {
    canonicalBefore = fs.readFileSync(canonicalAbs, "utf8");
  } catch {
    canonicalBefore = "";
  }
  originals.set(canonicalAbs, canonicalBefore);
  outputs.set(canonicalAbs, canonical.source.endsWith("\n") ? canonical.source : canonical.source + "\n");

  // 2. Every file that references a merged-away member.
  const { parsed } = findCallSites(root, [...byFile.values()], aliases, files);
  for (const [file, info] of parsed) {
    if (path.resolve(file) === canonicalAbs) continue; // rewritten wholesale above
    if (byFile.has(path.resolve(file)) && byFile.get(path.resolve(file)).otherDeclarations.length === 0) {
      continue; // dedicated member file — retired below, not rewritten
    }
    let next;
    try {
      next = rewriteCallSiteFile(ctx, { file, ...info }, canonicalTarget, mappingByName);
    } catch (e) {
      return { ok: false, error: `rewriting ${relOf(root, file)}: ${e.message}` };
    }
    if (next !== null) {
      originals.set(file, info.code);
      outputs.set(file, next);
    }
  }

  // 2b. A barrel that re-exports a member (`export { Card } from "./Card"`)
  //     is not an import binding and is not rewritten by the pass above — and
  //     the module it points at is about to be deleted. Refuse loudly instead
  //     of leaving a dangling re-export for the build to find.
  const reExports = findReExports(root, [...byFile.values()], aliases, files);
  if (reExports.length > 0) {
    return {
      ok: false,
      error: `re-exported elsewhere: ${reExports
        .map((r) => `${r.name} in ${r.file}`)
        .join(", ")} — update or remove those re-exports first, then merge`,
    };
  }

  // 3. Members whose file existed only for them get retired to the trash;
  //    anything else stays put and is reported, because deleting a
  //    declaration out of a shared file is surgery this codemod won't do
  //    blind (PRD: honesty over magic).
  const retire = [];
  const leftBehind = [];
  for (const t of merged) {
    if (t.otherDeclarations.length === 0) retire.push(t);
    else {
      leftBehind.push(t);
      ctx.warnings.push(
        `${t.file} also declares ${t.otherDeclarations.slice(0, 3).join(", ")} — ${t.name} was left in the file with no call sites`,
      );
    }
  }

  // 4. Gate: everything must parse before anything is written.
  for (const [file, content] of outputs) {
    try {
      parseStrict(content);
    } catch (e) {
      return {
        ok: false,
        error: `merge would corrupt ${relOf(root, file)}, aborted: ${e.message}`,
      };
    }
  }

  const changes = [...outputs.entries()].map(([file, after]) => ({
    file: relOf(root, file),
    before: originals.get(file) ?? "",
    after,
    kind:
      path.resolve(file) === canonicalAbs
        ? originals.get(file)
          ? "canonical"
          : "created"
        : "callsite",
  }));
  for (const t of retire) {
    changes.push({
      file: t.file,
      before: t.code,
      after: "",
      kind: "retired",
    });
  }
  changes.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file));

  const summary = {
    ok: true,
    dryRun: !!dryRun,
    canonical: { name: canonical.name, file: relOf(root, canonicalAbs) },
    changes,
    retired: retire.map((t) => t.file),
    leftBehind: leftBehind.map((t) => ({ file: t.file, name: t.name })),
    callSiteFiles: changes.filter((c) => c.kind === "callsite").length,
    warnings: ctx.warnings,
  };
  if (dryRun) return summary;

  // 5. Write. Files first, then the retirements — a failure part-way through
  //    the writes has already been made impossible by the gate above, and the
  //    trash move is reversible by construction.
  for (const [file, content] of outputs) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const trashed = [];
  for (const t of retire) {
    const rel = t.file;
    const dest = path.join(root, TRASH_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(t.abs, dest);
    fs.rmSync(t.abs);
    trashed.push(rel);
  }
  if (trashed.length > 0) writeTrashManifest(root, trashed);

  return { ...summary, trashed, written: [...outputs.keys()].map((f) => relOf(root, f)) };
}

// --- trash staging (FR-5.5) ---------------------------------------------------

function trashManifestPath(root) {
  return path.join(root, TRASH_DIR, "manifest.json");
}

function readTrashManifest(root) {
  try {
    return JSON.parse(fs.readFileSync(trashManifestPath(root), "utf8"));
  } catch {
    return { files: [] };
  }
}

function writeTrashManifest(root, files) {
  const manifest = readTrashManifest(root);
  const seen = new Set(manifest.files.map((f) => f.path));
  for (const rel of files) {
    if (!seen.has(rel)) manifest.files.push({ path: rel, at: Date.now() });
  }
  fs.mkdirSync(path.dirname(trashManifestPath(root)), { recursive: true });
  fs.writeFileSync(trashManifestPath(root), JSON.stringify(manifest, null, 2));
}

/** Put staged files back where they came from (a rollback's second half). */
function restoreTrash({ root, files }) {
  const manifest = readTrashManifest(root);
  const wanted = files ? new Set(files) : null;
  const restored = [];
  const keep = [];
  for (const entry of manifest.files) {
    if (wanted && !wanted.has(entry.path)) {
      keep.push(entry);
      continue;
    }
    const from = path.join(root, TRASH_DIR, entry.path);
    const to = path.join(root, entry.path);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    fs.rmSync(from);
    restored.push(entry.path);
  }
  fs.mkdirSync(path.dirname(trashManifestPath(root)), { recursive: true });
  fs.writeFileSync(trashManifestPath(root), JSON.stringify({ files: keep }, null, 2));
  return { ok: true, restored };
}

/** What's staged for deletion right now — the session-end confirmation list. */
function listTrash({ root }) {
  const manifest = readTrashManifest(root);
  return {
    ok: true,
    files: manifest.files.filter((f) =>
      fs.existsSync(path.join(root, TRASH_DIR, f.path)),
    ),
  };
}

/** Delete permanently — only ever on an explicit confirmation (FR-5.5). */
function emptyTrash({ root }) {
  const dir = path.join(root, TRASH_DIR);
  const manifest = readTrashManifest(root);
  const count = manifest.files.length;
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, deleted: count };
}

// --- entry --------------------------------------------------------------------

export { apply, behaviorDiff, findCallSites, plan };

if (isMainModule(import.meta.url)) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    let result;
    try {
      const req = JSON.parse(input);
      if (req.cmd === "plan") result = plan(req);
      else if (req.cmd === "apply") result = apply(req);
      else if (req.cmd === "restoreTrash") result = restoreTrash(req);
      else if (req.cmd === "listTrash") result = listTrash(req);
      else if (req.cmd === "emptyTrash") result = emptyTrash(req);
      else result = { ok: false, error: `unknown cmd: ${req.cmd}` };
    } catch (e) {
      result = { ok: false, error: String(e?.stack ?? e?.message ?? e) };
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  });
}
