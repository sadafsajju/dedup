// dedup canvas overlay — injected into the user's app by the tagger plugin.
// Hover highlights tagged elements with a component badge; click selects and
// reports to the dedup editor over postMessage (FR-2.2); dragging an element
// re-parents it and the insert palette places new ones. Dependency-free.
//
// The overlay never decides what is editable — the tagger stamps that onto
// each element (data-dedup-dyn / -core) from the same walk the write-back
// uses, so a gesture is refused before it starts rather than after a failed
// save. Nothing here writes to source: gestures become staged actions in the
// editor, and this file only shows what they would look like.
(() => {
  "use strict";
  if (window.__dedupOverlay) return;
  window.__dedupOverlay = true;
  // Harness pages get the overlay via the shared HTML transform, but they're
  // static previews — hover/select/page reports would fight the real canvas.
  if (location.pathname.startsWith("/__dedup/harness")) return;

  const ACCENT = "#4c7fff";
  const Z = 2147483646;

  let hoverEl = null;
  let selectedEl = null;
  // "inspect" swallows clicks to select; "browse" hands the page back to the
  // user (links/buttons work) until the editor switches tools again.
  let mode = "inspect";
  // Canvas gestures the editor has armed: dragging elements to re-parent them,
  // and click-to-place for the insert palette.
  let dragEnabled = false;
  let insertArmed = false;

  // The staged (unsaved) program, as state — see the `stage` message. Kept
  // whole rather than as deltas so it can be re-applied verbatim whenever
  // HMR or a React re-render swaps the DOM out from under us.
  let program = { classes: {}, texts: {}, structural: [] };

  // --- chrome -------------------------------------------------------------

  function makeBox(fill) {
    const el = document.createElement("div");
    el.setAttribute("data-dedup-ui", "");
    Object.assign(el.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      border: `1px solid ${ACCENT}`,
      background: fill,
      zIndex: String(Z),
      boxSizing: "border-box",
    });
    return el;
  }

  const hoverBox = makeBox("rgba(76,127,255,0.08)");
  const selectBox = makeBox("transparent");
  selectBox.style.borderWidth = "1.5px";

  const badge = document.createElement("div");
  badge.setAttribute("data-dedup-ui", "");
  Object.assign(badge.style, {
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    background: ACCENT,
    color: "#fff",
    font: "500 11px -apple-system, system-ui, sans-serif",
    padding: "2px 6px",
    borderRadius: "3px",
    zIndex: String(Z + 1),
    whiteSpace: "nowrap",
  });

  // Drop affordances for drag/insert: a line between siblings, a box for
  // "inside". Both are pointer-events:none so elementFromPoint sees through.
  const dropLine = document.createElement("div");
  dropLine.setAttribute("data-dedup-ui", "");
  Object.assign(dropLine.style, {
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    height: "2px",
    background: ACCENT,
    borderRadius: "2px",
    zIndex: String(Z + 2),
  });

  const dropBox = makeBox("rgba(76,127,255,0.12)");
  dropBox.style.borderStyle = "dashed";
  dropBox.style.zIndex = String(Z + 2);

  // Staged-class preview rules (see applyValues). Declared here with the rest
  // of the chrome because mount() runs during script evaluation — anything it
  // appends has to exist by then, not further down the file.
  const previewStyle = document.createElement("style");
  previewStyle.setAttribute("data-dedup-ui", "");

  // --- viewport-height freeze ----------------------------------------------
  // The editor grows the canvas frame to the page's full height. Without help,
  // vh/dvh-based layouts (h-screen sections, 100dvh app shells) re-resolve
  // against the grown frame — sections balloon and the layout diverges. Pin
  // the common Tailwind viewport-height classes to the DEVICE viewport height
  // (sent by the editor; falls back to the height at overlay load) so the page
  // keeps its designed proportions no matter how tall the frame gets.
  let deviceH = window.innerHeight;
  const freezeStyle = document.createElement("style");
  freezeStyle.setAttribute("data-dedup-ui", "");
  function refreshFreeze() {
    const h = deviceH + "px";
    freezeStyle.textContent =
      ".h-screen,.h-dvh,.h-svh,.h-lvh{height:" + h + " !important}" +
      ".min-h-screen,.min-h-dvh,.min-h-svh,.min-h-lvh{min-height:" + h + " !important}" +
      ".max-h-screen,.max-h-dvh,.max-h-svh,.max-h-lvh{max-height:" + h + " !important}";
  }
  refreshFreeze();

  function mount() {
    document.documentElement.appendChild(hoverBox);
    document.documentElement.appendChild(selectBox);
    document.documentElement.appendChild(badge);
    document.documentElement.appendChild(freezeStyle);
    document.documentElement.appendChild(previewStyle);
    document.documentElement.appendChild(dropLine);
    document.documentElement.appendChild(dropBox);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // --- element helpers ------------------------------------------------------

  function tagged(el) {
    while (el && el !== document.documentElement) {
      if (el.nodeType === 1 && el.hasAttribute("data-dedup-id")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function labelOf(el) {
    const component = el.getAttribute("data-dedup-component");
    const tag = el.tagName.toLowerCase();
    return component ? `${component} · ${tag}` : tag;
  }

  function describe(el) {
    return {
      dedupId: el.getAttribute("data-dedup-id"),
      component: el.getAttribute("data-dedup-component") || null,
      tag: el.tagName.toLowerCase(),
      domClassName: el.getAttribute("class") || "",
      // Stamped by the tagger: why this node resists structural edits. The
      // overlay uses them to refuse a gesture before it starts, instead of
      // letting the user drag something the write-back will reject.
      dynamic: el.getAttribute("data-dedup-dyn") || null,
      core: el.getAttribute("data-dedup-core") || null,
      domId: getOrAssignDomId(el),
    };
  }

  /** Per-DOM-node identity. One source element rendered from a `.map()` has
   * many of these — a gesture names the instance it actually hit, even though
   * the edit it produces is still a source-level edit. */
  let domIdSeq = 0;
  function getOrAssignDomId(el) {
    let id = el.getAttribute("data-dedup-dom");
    if (!id) {
      id = "d" + (++domIdSeq).toString(36) + Date.now().toString(36).slice(-4);
      el.setAttribute("data-dedup-dom", id);
    }
    return id;
  }

  // --- staged program -------------------------------------------------------
  // The editor sends the whole staged program as state, never deltas: applying
  // it means undo whatever we applied last, then replay from scratch. Undo,
  // redo, reverting one action out of the middle, and recovering after React
  // re-renders a node we touched all take that same path.

  /** dedup ids are `<file>@<ordinal>`; the file half is the scan's unit. */
  function fileOfId(id) {
    const at = (id || "").lastIndexOf("@");
    return at > 0 ? id.slice(0, at) : null;
  }

  const byId = (id) => document.querySelector(`[data-dedup-id="${CSS.escape(id)}"]`);
  const allById = (id) =>
    document.querySelectorAll(`[data-dedup-id="${CSS.escape(id)}"]`);

  // --- value edits (class / text) ------------------------------------------
  // Staged classes are written onto the element AND mirrored into one
  // stylesheet keyed by dedup id. The mirror exists because Tailwind's JIT
  // only generates CSS for classes present in source: a class staged live may
  // have no rule yet. A stylesheet (rather than the inline `style` attribute
  // this used to use) leaves the element's own inline styles alone, and
  // undoing a preview is dropping a rule rather than remembering which
  // properties we touched.
  /** ids whose class attribute we overwrote → their pre-stage class string. */
  const stagedFrom = new Map();

  function applyValues() {
    const rules = [];
    for (const [id, patch] of Object.entries(program.classes)) {
      stagedFrom.set(id, patch.from);
      for (const el of allById(id)) {
        if (el.getAttribute("class") !== patch.to) {
          el.setAttribute("class", patch.to);
        }
      }
      const decls = declarationsFor(patch.to);
      // `html [attr]` beats a bare utility class on specificity without
      // reaching for !important, so a staged value wins over the class it
      // replaces while the project's own !important rules still win over us.
      if (decls) rules.push(`html [data-dedup-id="${cssEscapeAttr(id)}"]{${decls}}`);
    }
    // Anything no longer staged goes back to what the source said.
    for (const [id, from] of [...stagedFrom]) {
      if (program.classes[id]) continue;
      for (const el of allById(id)) el.setAttribute("class", from);
      stagedFrom.delete(id);
    }
    previewStyle.textContent = rules.join("\n");

    for (const [id, patch] of Object.entries(program.texts)) {
      for (const el of allById(id)) {
        // Never rewrite the node the caret is in: assigning textContent would
        // drop the selection to the start on every keystroke.
        if (el === editingEl) continue;
        if (el.textContent !== patch.to) el.textContent = patch.to;
      }
    }
  }

  /** The CSS a staged class string should preview as, or "" when we can't
   * interpret any of it (the real Tailwind rules already cover that case). */
  function declarationsFor(cls) {
    const out = [];
    for (const token of cls.split(/\s+/)) {
      if (!token || token.includes(":")) continue; // base classes only
      const decls = styleFor(token);
      if (!decls) continue;
      for (const [prop, value] of decls) out.push(`${prop}:${value}`);
    }
    return out.join(";");
  }

  /** dedup ids are `file@ordinal` — only quotes and backslashes can hurt us
   * inside an attribute selector. */
  function cssEscapeAttr(v) {
    return v.replace(/["\\]/g, "\\$&");
  }

  // --- structural edits (insert / remove / move) ----------------------------

  /** Inverses of the structural ops we applied, newest last. */
  let applied = [];

  /** Where a node currently sits, so the inverse can put it back exactly. */
  function origin(node) {
    return { node, parent: node.parentNode, next: node.nextSibling };
  }

  function restore(entry) {
    const { node, parent, next } = entry;
    if (!parent || !parent.isConnected) return;
    // A re-render may have rebuilt this element while we held the old node.
    // Putting our copy back would show the element twice — React already
    // restored it, so there is nothing to undo.
    const id = node.getAttribute && node.getAttribute("data-dedup-id");
    if (!node.isConnected && id && byId(id)) return;
    if (next && next.parentNode === parent) parent.insertBefore(node, next);
    else parent.appendChild(node);
  }

  function resetStructural() {
    for (let i = applied.length - 1; i >= 0; i--) {
      const entry = applied[i];
      if (entry.kind === "insert") entry.node.remove();
      else restore(entry);
    }
    applied = [];
  }

  function placeNode(node, ref, position) {
    if (position === "inside") ref.appendChild(node);
    else if (position === "before") ref.parentNode?.insertBefore(node, ref);
    else ref.parentNode?.insertBefore(node, ref.nextSibling);
  }

  function applyStructural() {
    resetStructural();
    for (const op of program.structural) {
      if (op.op === "remove") {
        // Every instance: the source element is gone after save, so all of its
        // DOM instances must disappear from the preview too.
        for (const el of allById(op.id)) {
          applied.push({ kind: "remove", ...origin(el) });
          el.remove();
        }
      } else if (op.op === "move") {
        const el = byId(op.id);
        const ref = byId(op.to);
        if (!el || !ref || el.contains(ref)) continue;
        applied.push({ kind: "move", ...origin(el) });
        placeNode(el, ref, op.position);
      } else if (op.op === "insert") {
        const ref = byId(op.id);
        if (!ref) continue;
        const host = document.createElement("div");
        host.innerHTML = op.html;
        const node = host.firstElementChild;
        if (!node) continue;
        // Marked so hover/select can tell the user this element only exists in
        // the preview until they save — and given the editor's provisional id,
        // so it can be selected, styled and typed into before it is written.
        node.setAttribute("data-dedup-staged", "insert");
        if (op.pendingId) node.setAttribute("data-dedup-id", op.pendingId);
        applied.push({ kind: "insert", node });
        placeNode(node, ref, op.position);
      }
    }
  }

  // --- inline text editing (FR-3.8) ---------------------------------------
  // Double-click puts the caret in the element itself rather than sending the
  // user to a field in the side panel. The editor decides whether the element
  // may be edited at all — it is the one holding the write-back's answer — so
  // a double-click asks, and editing only starts if it says yes.

  let editingEl = null;
  let editingOriginal = "";

  function isEditing(node) {
    return !!editingEl && (node === editingEl || editingEl.contains(node));
  }

  function beginTextEdit(id) {
    const el = byId(id);
    if (!el) return;
    endTextEdit();
    editingEl = el;
    editingOriginal = el.textContent;
    el.setAttribute("contenteditable", "plaintext-only");
    el.setAttribute("data-dedup-editing", "true");
    el.focus();
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Selection APIs are best-effort; the caret still lands in the element.
    }
    repaint();
  }

  function endTextEdit() {
    if (!editingEl) return;
    editingEl.removeAttribute("contenteditable");
    editingEl.removeAttribute("data-dedup-editing");
    if (editingEl.blur) editingEl.blur();
    editingEl = null;
  }

  document.addEventListener(
    "dblclick",
    (e) => {
      if (mode !== "inspect" || insertArmed) return;
      const el = tagged(e.target);
      if (!el) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post("text-edit-request", { id: el.getAttribute("data-dedup-id") });
    },
    true,
  );

  document.addEventListener(
    "input",
    () => {
      if (!editingEl) return;
      post("text-input", {
        id: editingEl.getAttribute("data-dedup-id"),
        text: editingEl.textContent,
      });
    },
    true,
  );

  document.addEventListener(
    "focusout",
    (e) => {
      if (isEditing(e.target)) endTextEdit();
    },
    true,
  );

  /** Has a re-render undone our surgery? Cheap enough to run on every tick. */
  function structuralDrifted() {
    for (const entry of applied) {
      if (entry.kind === "insert" && !entry.node.isConnected) return true;
    }
    for (const op of program.structural) {
      if (op.op === "remove") {
        if (byId(op.id)) return true;
      } else if (op.op === "move") {
        const el = byId(op.id);
        const ref = byId(op.to);
        if (!el || !ref) continue;
        const ok =
          op.position === "inside"
            ? el.parentElement === ref
            : el.parentElement === ref.parentElement;
        if (!ok) return true;
      }
    }
    return false;
  }

  /** Serialized structural program, so an unchanged one isn't rebuilt. */
  let structuralSig = "";

  function applyProgram() {
    const sig = JSON.stringify(program.structural);
    // Rebuilding on every message would tear down and recreate an inserted
    // element on each keystroke typed into it — the node being edited would
    // vanish mid-word. Value edits never change this signature.
    if (sig !== structuralSig) {
      structuralSig = sig;
      endTextEdit();
      applyStructural();
    }
    applyValues();
    repaint();
  }

  // --- tiny Tailwind interpreter (preview only; fidelity via theme vars) ----

  const SPACE = (n) => `calc(var(--spacing, 0.25rem) * ${n})`;

  function sizeValue(v, axis) {
    if (v === "auto") return "auto";
    if (v === "full") return "100%";
    if (v === "screen") return axis === "x" ? "100vw" : "100vh";
    if (v === "min") return "min-content";
    if (v === "max") return "max-content";
    if (v === "fit") return "fit-content";
    if (v === "px") return "1px";
    if (/^\[.+\]$/.test(v)) return v.slice(1, -1);
    if (/^\d+\/\d+$/.test(v)) {
      const [a, b] = v.split("/").map(Number);
      return `${((a / b) * 100).toFixed(4)}%`;
    }
    if (/^\d+(\.\d+)?$/.test(v)) return SPACE(v);
    return null;
  }

  function spacingDecl(props, raw) {
    const neg = raw.startsWith("-");
    const v = sizeValue(neg ? raw.slice(1) : raw, "x");
    if (v === null) return null;
    const value = neg ? `calc(-1 * ${v})` : v;
    return props.map((p) => [p, value]);
  }

  function colorValue(v) {
    if (v === "white") return "#fff";
    if (v === "black") return "#000";
    if (v === "transparent") return "transparent";
    if (v === "current") return "currentColor";
    if (v === "inherit") return "inherit";
    if (/^\[.+\]$/.test(v)) return v.slice(1, -1);
    if (/^[a-z]+-(?:50|[1-9]50|[1-9]00)$/.test(v)) return `var(--color-${v})`;
    return null;
  }

  const STATIC = {
    block: [["display", "block"]],
    "inline-block": [["display", "inline-block"]],
    inline: [["display", "inline"]],
    flex: [["display", "flex"]],
    "inline-flex": [["display", "inline-flex"]],
    grid: [["display", "grid"]],
    "inline-grid": [["display", "inline-grid"]],
    hidden: [["display", "none"]],
    "flex-row": [["flex-direction", "row"]],
    "flex-row-reverse": [["flex-direction", "row-reverse"]],
    "flex-col": [["flex-direction", "column"]],
    "flex-col-reverse": [["flex-direction", "column-reverse"]],
    border: [["border-width", "1px"]],
    rounded: [["border-radius", "var(--radius, 0.25rem)"]],
    shadow: [["box-shadow", "var(--shadow, 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1))"]],
    "shadow-none": [["box-shadow", "none"]],
    "rounded-none": [["border-radius", "0"]],
    "rounded-full": [["border-radius", "9999px"]],
  };

  const JUSTIFY = { start: "flex-start", end: "flex-end", center: "center", between: "space-between", around: "space-around", evenly: "space-evenly", stretch: "stretch" };
  const ITEMS = { start: "flex-start", end: "flex-end", center: "center", baseline: "baseline", stretch: "stretch" };
  const WEIGHTS = { thin: "100", extralight: "200", light: "300", normal: "400", medium: "500", semibold: "600", bold: "700", extrabold: "800", black: "900" };
  const FONT_SIZES = { xs: ".75rem", sm: ".875rem", base: "1rem", lg: "1.125rem", xl: "1.25rem", "2xl": "1.5rem", "3xl": "1.875rem", "4xl": "2.25rem", "5xl": "3rem", "6xl": "3.75rem", "7xl": "4.5rem", "8xl": "6rem", "9xl": "8rem" };
  const LINE_HEIGHTS = { xs: "1rem", sm: "1.25rem", base: "1.5rem", lg: "1.75rem", xl: "1.75rem", "2xl": "2rem", "3xl": "2.25rem", "4xl": "2.5rem" };
  const RADII = { xs: ".125rem", sm: ".25rem", md: ".375rem", lg: ".5rem", xl: ".75rem", "2xl": "1rem", "3xl": "1.5rem", "4xl": "2rem" };
  const SHADOWS = {
    "2xs": "0 1px rgb(0 0 0 / 0.05)",
    xs: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
    md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
    inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
  };
  const SPACING_SIDES = { "": ["top", "right", "bottom", "left"], t: ["top"], r: ["right"], b: ["bottom"], l: ["left"], x: ["left", "right"], y: ["top", "bottom"] };

  function styleFor(token) {
    if (STATIC[token]) return STATIC[token];
    let m;
    if ((m = token.match(/^(-?)([pm])(t|r|b|l|x|y)?-(.+)$/))) {
      const base = m[2] === "p" ? "padding" : "margin";
      const sides = SPACING_SIDES[m[3] ?? ""];
      return spacingDecl(sides.map((s) => `${base}-${s}`), m[1] + m[4]);
    }
    if ((m = token.match(/^gap(-[xy])?-(.+)$/))) {
      const prop = m[1] === "-x" ? "column-gap" : m[1] === "-y" ? "row-gap" : "gap";
      return spacingDecl([prop], m[2]);
    }
    if ((m = token.match(/^(min-|max-)?([wh])-(.+)$/))) {
      const dim = m[2] === "w" ? "width" : "height";
      const prop = (m[1] ?? "") + dim;
      const v = sizeValue(m[3], m[2] === "w" ? "x" : "y");
      return v === null ? null : [[prop, v]];
    }
    if ((m = token.match(/^justify-(\w+)$/)) && JUSTIFY[m[1]]) {
      return [["justify-content", JUSTIFY[m[1]]]];
    }
    if ((m = token.match(/^items-(\w+)$/)) && ITEMS[m[1]]) {
      return [["align-items", ITEMS[m[1]]]];
    }
    if ((m = token.match(/^font-(\w+)$/)) && WEIGHTS[m[1]]) {
      return [["font-weight", `var(--font-weight-${m[1]}, ${WEIGHTS[m[1]]})`]];
    }
    if ((m = token.match(/^text-(left|center|right|justify)$/))) {
      return [["text-align", m[1]]];
    }
    if ((m = token.match(/^text-(.+)$/))) {
      const size = FONT_SIZES[m[1]];
      if (size) {
        const decls = [["font-size", `var(--text-${m[1]}, ${size})`]];
        if (LINE_HEIGHTS[m[1]]) {
          decls.push(["line-height", `var(--text-${m[1]}--line-height, ${LINE_HEIGHTS[m[1]]})`]);
        }
        return decls;
      }
      if (/^\[(?!#|rgb|hsl|var|oklch)[^\]]+\]$/.test(m[1])) {
        return [["font-size", m[1].slice(1, -1)]];
      }
      const color = colorValue(m[1]);
      return color === null ? null : [["color", color]];
    }
    if ((m = token.match(/^bg-(.+)$/))) {
      const color = colorValue(m[1]);
      return color === null ? null : [["background-color", color]];
    }
    if ((m = token.match(/^border-(0|2|4|8)$/))) {
      return [["border-width", `${m[1]}px`]];
    }
    if ((m = token.match(/^border-(.+)$/))) {
      const color = colorValue(m[1]);
      return color === null ? null : [["border-color", color]];
    }
    if ((m = token.match(/^rounded-(.+)$/))) {
      if (RADII[m[1]]) {
        return [["border-radius", `var(--radius-${m[1]}, ${RADII[m[1]]})`]];
      }
      if (/^\[.+\]$/.test(m[1])) return [["border-radius", m[1].slice(1, -1)]];
      return null;
    }
    if ((m = token.match(/^shadow-(.+)$/)) && SHADOWS[m[1]]) {
      return [["box-shadow", `var(--shadow-${m[1]}, ${SHADOWS[m[1]]})`]];
    }
    if ((m = token.match(/^leading-(.+)$/))) {
      const named = { none: "1", tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625", loose: "2" }[m[1]];
      if (named) return [["line-height", named]];
      if (/^\d+(\.\d+)?$/.test(m[1])) return [["line-height", SPACE(m[1])]];
      return null;
    }
    if ((m = token.match(/^tracking-(.+)$/))) {
      const named = { tighter: "-0.05em", tight: "-0.025em", normal: "0", wide: "0.025em", wider: "0.05em", widest: "0.1em" }[m[1]];
      return named ? [["letter-spacing", named]] : null;
    }
    return null;
  }

  function payload(el) {
    const id = el.getAttribute("data-dedup-id");
    const ancestry = [];
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (cur.nodeType === 1 && cur.hasAttribute("data-dedup-id")) {
        ancestry.push(describe(cur));
      }
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return {
      ...describe(el),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      instanceCount: document.querySelectorAll(
        `[data-dedup-id="${CSS.escape(id)}"]`,
      ).length,
      ancestry, // innermost-first, includes the element itself
    };
  }

  function position(box, el) {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: r.x + "px",
      top: r.y + "px",
      width: r.width + "px",
      height: r.height + "px",
    });
    return r;
  }

  function repaint() {
    if (hoverEl && hoverEl.isConnected) {
      const r = position(hoverBox, hoverEl);
      badge.textContent = labelOf(hoverEl);
      badge.style.display = "block";
      const above = r.y >= 24;
      badge.style.left = r.x + "px";
      badge.style.top = (above ? r.y - 22 : r.y + 2) + "px";
    } else {
      hoverBox.style.display = "none";
      badge.style.display = "none";
    }
    if (selectedEl && selectedEl.isConnected) {
      position(selectBox, selectedEl);
    } else {
      selectBox.style.display = "none";
    }
  }

  // --- messaging ------------------------------------------------------------

  function post(type, data) {
    window.parent.postMessage({ __dedup: true, type, ...data }, "*");
  }

  // --- page console forwarding ---------------------------------------------
  // The editor's console shows the dev server's output, which is the build
  // side of the story. Anything the app says at *runtime* — an auth SDK
  // refusing a domain, a failed request, a thrown render — happens inside
  // this iframe, where the user has no way to see it. Forward the loud levels
  // so a page that misbehaves on the canvas can be diagnosed from the editor.
  // Never console.log ourselves in here: that would recurse.

  /** Args → one line, without throwing on cycles or exotic values. */
  function describeArg(v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    try {
      return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    } catch {
      return String(v);
    }
  }

  // A render loop can throw thousands of times a second; the editor's log is
  // capped anyway, so drop the flood rather than ship it.
  let logBudget = 200;
  setInterval(() => {
    logBudget = Math.min(200, logBudget + 20);
  }, 1000);

  function forward(level, args) {
    if (logBudget <= 0) return;
    logBudget--;
    let text = "";
    try {
      text = Array.prototype.map.call(args, describeArg).join(" ");
    } catch {
      text = "(unserializable console arguments)";
    }
    if (text.length > 2000) text = text.slice(0, 2000) + "…";
    post("page-log", { level, text, path: location.pathname });
  }

  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = function (...args) {
      try {
        forward(level, args);
      } catch {
        // Forwarding is best-effort; never break the page's own logging.
      }
      if (typeof original === "function") original.apply(console, args);
    };
  }

  window.addEventListener("error", (e) => {
    forward("error", [e.error || e.message || "uncaught error"]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    forward("error", ["unhandled rejection:", e.reason]);
  });

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.__dedup !== true) return;
    if (m.type === "select-id") {
      const el = document.querySelector(
        `[data-dedup-id="${CSS.escape(m.id)}"]`,
      );
      // Broadcast to every page frame: the one holding the element selects
      // it, the others drop their now-stale selection boxes.
      if (el) select(el);
      else {
        selectedEl = null;
        repaint();
      }
    } else if (m.type === "clear") {
      selectedEl = null;
      hoverEl = null;
      repaint();
    } else if (m.type === "stage") {
      // The whole staged program (FR-3.7), applied as state: reset, replay.
      program = {
        classes: m.classes || {},
        texts: m.texts || {},
        structural: Array.isArray(m.structural) ? m.structural : [],
      };
      applyProgram();
    } else if (m.type === "text-edit-begin") {
      beginTextEdit(m.id);
    } else if (m.type === "set-edit-mode") {
      dragEnabled = !!m.drag;
      insertArmed = !!m.insert;
      if (!insertArmed) hideDropIndicator();
    } else if (m.type === "set-mode") {
      mode = m.mode === "browse" ? "browse" : "inspect";
      if (mode === "browse") {
        hoverEl = null;
        selectedEl = null;
        repaint();
      }
    } else if (m.type === "release-hold") {
      // Let a frozen frame finish what it was doing (the boot script flushes
      // the timers it queued), so the user can watch the transition land
      // instead of having to reload out of the hold.
      if (typeof window.__dedupRelease === "function") window.__dedupRelease();
    } else if (m.type === "hover-id") {
      // Hovering a row in the editor's Layers tree — same highlight a pointer
      // over the canvas would draw. Frames not holding the element clear.
      hoverEl = m.id ? byId(m.id) : null;
      repaint();
    } else if (m.type === "list-layers") {
      reportLayers(true);
    } else if (m.type === "list-files") {
      // Source files behind everything currently rendered (FR-5.1 canvas
      // scope). dedupId is "file@ordinal" — strip the ordinal.
      const files = new Set();
      for (const el of document.querySelectorAll("[data-dedup-id]")) {
        const file = fileOfId(el.getAttribute("data-dedup-id"));
        if (file) files.add(file);
      }
      post("files", { files: [...files] });
    } else if (m.type === "list-sizes") {
      // Rendered size of each component as it appears on THIS page: for every
      // (file, component) pair, the outermost tagged element of its first
      // on-page instance — the component gallery sizes its preview cards to
      // match the site. Nested elements of the same component (its inner
      // markup, or recursive instances) are skipped.
      const keyFor = (el) => {
        const name = el.getAttribute("data-dedup-component");
        const file = fileOfId(el.getAttribute("data-dedup-id"));
        return name && file ? file + "#" + name : null;
      };
      const sizes = {};
      for (const el of document.querySelectorAll("[data-dedup-id]")) {
        const key = keyFor(el);
        if (!key || sizes[key]) continue; // first instance wins
        let cur = el.parentElement;
        let nested = false;
        while (cur) {
          if (cur.hasAttribute("data-dedup-id") && keyFor(cur) === key) {
            nested = true;
            break;
          }
          cur = cur.parentElement;
        }
        if (nested) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 1 && r.height >= 1) {
          sizes[key] = { w: Math.ceil(r.width), h: Math.ceil(r.height) };
        }
      }
      post("component-sizes", { sizes });
    } else if (m.type === "navigate") {
      // Snap this frame back to its pinned route after a navigation spawned
      // a new artboard. Soft first (react-router listens to popstate, no
      // reload); hard fallback if the router didn't take it.
      const target = String(m.path || "/");
      try {
        history.replaceState(null, "", target);
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      } catch {}
      setTimeout(() => {
        if (location.pathname !== target) location.replace(target);
      }, 400);
    } else if (m.type === "set-viewport") {
      // Device viewport height from the editor — the reference for the
      // vh-freeze and for spotting viewport-pinned scrollers. Matters after
      // HMR reloads the overlay inside an already-grown frame, where
      // window.innerHeight is no longer the device height.
      if (typeof m.height === "number" && m.height > 0 && m.height !== deviceH) {
        deviceH = m.height;
        refreshFreeze();
        reportHeight();
      }
    } else if (m.type === "reload") {
      // Full-page refresh after an AI chat edit: guarantees the canvas shows
      // the committed source (HMR sockets can wedge) and re-stamps every
      // data-dedup-id, since positions may have shifted.
      //
      // With `path`, reload *at* that route instead of wherever the frame
      // currently sits. That's how a mock session takes effect on a frame the
      // app already bounced to its login page: a plain reload would just
      // refresh /login. Both forms are a fresh document load, which is what
      // the session seed needs (it runs before the app boots).
      const target = typeof m.path === "string" ? m.path : null;
      if (target && location.pathname !== target) location.replace(target);
      else location.reload();
    }
  });

  function select(el) {
    selectedEl = el;
    repaint();
    post("selected", { payload: payload(el) });
  }

  // --- drag to re-parent, click to insert ----------------------------------
  // Both gestures share one target resolver, so a dragged element and a
  // palette element land in exactly the same places, described the same way.

  const VOID_TAGS = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);

  /** The tagger stamps why an element resists structural edits; trust it here
   * so a drag never starts on something the write-back would refuse. */
  function structurallyEditable(el) {
    return (
      !!el &&
      !el.hasAttribute("data-dedup-dyn") &&
      !el.hasAttribute("data-dedup-core") &&
      !!el.parentElement?.closest("[data-dedup-id]")
    );
  }

  /**
   * Which element a pointer at (x, y) would drop onto, and where relative to
   * it. `exclude` (the element being dragged) and its subtree are skipped —
   * dropping something inside itself is not a thing.
   */
  function dropTargetAt(x, y, exclude) {
    let el = tagged(document.elementFromPoint(x, y));
    while (el && exclude && (el === exclude || exclude.contains(el))) {
      el = tagged(el.parentElement);
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.height < 1) return null;
    const rel = (y - r.top) / r.height;
    const acceptsChildren = !VOID_TAGS.has(el.tagName.toLowerCase());
    const position =
      acceptsChildren && rel > 0.3 && rel < 0.7
        ? "inside"
        : rel < 0.5
          ? "before"
          : "after";
    return { el, position, rect: r };
  }

  function showDropIndicator(target) {
    if (!target) {
      hideDropIndicator();
      return;
    }
    const { rect, position } = target;
    if (position === "inside") {
      dropLine.style.display = "none";
      Object.assign(dropBox.style, {
        display: "block",
        left: rect.x + "px",
        top: rect.y + "px",
        width: rect.width + "px",
        height: rect.height + "px",
      });
      return;
    }
    dropBox.style.display = "none";
    Object.assign(dropLine.style, {
      display: "block",
      left: rect.x + "px",
      top: (position === "before" ? rect.y - 1 : rect.y + rect.height - 1) + "px",
      width: rect.width + "px",
    });
  }

  function hideDropIndicator() {
    dropLine.style.display = "none";
    dropBox.style.display = "none";
  }

  // Drag begins only after the pointer travels a few px, so a plain click on
  // an element still selects it.
  const DRAG_THRESHOLD = 4;
  let drag = null;

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (mode !== "inspect" || !dragEnabled || insertArmed) return;
      if (e.button !== 0 || isEditing(e.target)) return;
      const el = tagged(e.target);
      if (!structurallyEditable(el)) return;
      drag = { el, x: e.clientX, y: e.clientY, active: false, target: null };
    },
    true,
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (insertArmed && mode === "inspect") {
        showDropIndicator(dropTargetAt(e.clientX, e.clientY, null));
        return;
      }
      if (!drag) return;
      if (!drag.active) {
        const moved =
          Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
        if (moved < DRAG_THRESHOLD) return;
        drag.active = true;
        hoverEl = null;
        repaint();
        post("drag-start", { id: drag.el.getAttribute("data-dedup-id") });
      }
      e.preventDefault();
      drag.target = dropTargetAt(e.clientX, e.clientY, drag.el);
      showDropIndicator(drag.target);
    },
    true,
  );

  document.addEventListener(
    "pointerup",
    (e) => {
      if (insertArmed && mode === "inspect") {
        const target = dropTargetAt(e.clientX, e.clientY, null);
        hideDropIndicator();
        if (target) {
          e.preventDefault();
          e.stopImmediatePropagation();
          post("insert-at", {
            id: target.el.getAttribute("data-dedup-id"),
            position: target.position,
          });
        }
        return;
      }
      if (!drag) return;
      const finished = drag;
      drag = null;
      hideDropIndicator();
      if (!finished.active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post("drag-end", {});
      if (!finished.target) return;
      post("drop", {
        id: finished.el.getAttribute("data-dedup-id"),
        to: finished.target.el.getAttribute("data-dedup-id"),
        position: finished.target.position,
      });
    },
    true,
  );

  window.addEventListener("blur", () => {
    if (drag?.active) post("drag-end", {});
    drag = null;
    hideDropIndicator();
  });

  // --- keyboard forwarding --------------------------------------------------
  // Clicking the canvas gives the iframe focus, so the editor's own window
  // never sees these. Forward the editor's shortcuts (and only those); the
  // page's own key handling is otherwise untouched.
  document.addEventListener(
    "keydown",
    (e) => {
      // Typing into an element on the canvas: Enter commits, Escape puts the
      // original text back (staged, so ⌘Z still works either way).
      if (isEditing(e.target)) {
        if (e.key === "Escape") {
          post("text-input", {
            id: editingEl.getAttribute("data-dedup-id"),
            text: editingOriginal,
          });
          endTextEdit();
          e.preventDefault();
        } else if (e.key === "Enter" && !e.shiftKey) {
          endTextEdit();
          e.preventDefault();
        }
        return;
      }
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable);
      if (typing) return;
      const meta = e.metaKey || e.ctrlKey;
      const forwarded =
        (meta && (e.key === "s" || e.key === "z" || /^[123]$/.test(e.key))) ||
        (!meta &&
          (e.key === "Escape" ||
            e.key === "Delete" ||
            e.key === "Backspace" ||
            e.key === "v" ||
            e.key === "h" ||
            e.key === "b"));
      if (!forwarded) return;
      if (drag?.active && e.key === "Escape") {
        drag = null;
        hideDropIndicator();
        post("drag-end", {});
        return;
      }
      e.preventDefault();
      post("key", { key: e.key, meta, shift: e.shiftKey });
    },
    true,
  );

  // --- events ---------------------------------------------------------------

  document.addEventListener(
    "mousemove",
    (e) => {
      if (mode === "browse" || drag?.active || insertArmed) return;
      const el = tagged(e.target);
      if (el !== hoverEl) {
        hoverEl = el;
        repaint();
      }
    },
    true,
  );

  document.addEventListener(
    "mouseleave",
    () => {
      hoverEl = null;
      repaint();
    },
    true,
  );

  // Inspect-don't-activate: swallow clicks and select instead (design-tool
  // semantics; links/buttons in the user's app don't fire). Browse mode
  // steps aside entirely so the app is navigable.
  document.addEventListener(
    "click",
    (e) => {
      if (mode === "browse") return;
      // Clicks inside the element being typed into belong to the caret.
      if (isEditing(e.target)) return;
      endTextEdit();
      e.preventDefault();
      e.stopImmediatePropagation();
      // A click that ended a drag or placed an element is not a selection.
      if (drag?.active || insertArmed) return;
      const el = tagged(e.target);
      if (el) select(el);
    },
    true,
  );

  // --- layer tree reporting (FR-6.2) ----------------------------------------
  // The rendered DOM is the truth of what's on this page, so the Layers tree
  // mirrors it: staged inserts/removes appear live, and one source element
  // rendered from a .map() shows once per instance. Pushed from the same
  // debounced mutation tick as the height report; the editor can also force
  // one with `list-layers` (e.g. when the tab opens after the initial push).

  let lastLayersSig = "";

  function buildLayers() {
    const walk = (el, out) => {
      for (const child of el.children) {
        if (child.hasAttribute("data-dedup-ui")) continue;
        if (child.hasAttribute("data-dedup-id")) {
          const node = {
            id: child.getAttribute("data-dedup-id"),
            tag: child.tagName.toLowerCase(),
            component: child.getAttribute("data-dedup-component") || null,
            dynamic: child.getAttribute("data-dedup-dyn") || null,
            core: child.getAttribute("data-dedup-core") || null,
            staged: child.hasAttribute("data-dedup-staged"),
            text: null,
            children: [],
          };
          walk(child, node.children);
          // A short text snippet tells leaf rows apart ("li · Sign out"
          // beats three anonymous "li"s). Leaves only — a container's
          // textContent would be its whole subtree's text.
          if (node.children.length === 0) {
            const t = (child.textContent || "").trim().replace(/\s+/g, " ");
            if (t) node.text = t.length > 40 ? t.slice(0, 40) + "…" : t;
          }
          out.push(node);
        } else {
          // Untagged wrapper (portal root, third-party markup): its tagged
          // descendants still belong in the tree, parented to ours above.
          walk(child, out);
        }
      }
    };
    const out = [];
    if (document.body) walk(document.body, out);
    return out;
  }

  function reportLayers(force) {
    const layers = buildLayers();
    const sig = JSON.stringify(layers);
    if (!force && sig === lastLayersSig) return;
    lastLayersSig = sig;
    post("layers", { layers, path: location.pathname });
  }

  // --- full-page height reporting -------------------------------------------
  // The editor sizes the canvas frame to the page's natural height. Reports
  // are mutation-driven (not resize-driven) so vh-based layouts can't enter a
  // grow → re-measure → grow feedback loop: resizing the frame mutates
  // nothing, so no re-report happens.
  let lastReportedHeight = 0;
  let lastMeta = "";
  let heightTimer = null;
  // documentElement.scrollHeight alone misses apps that pin their root to the
  // viewport (100dvh / h-screen shells) and scroll an inner panel — the
  // document never overflows, so the scrollbar hides inside the frame. Unpin
  // such page-level scrollers at runtime (height:auto lets the document carry
  // the true height); with the vh-freeze above keeping section proportions,
  // the measurement then converges instead of feeding back through vh units.
  // Runtime-only styles — the user's source is never touched.
  const unpinnedEls = new Set();
  function unpin(el) {
    unpinnedEls.add(el);
    el.style.setProperty("height", "auto", "important");
    el.style.setProperty("max-height", "none", "important");
  }
  function unpinPageScrollers() {
    // React re-renders can rebuild or restyle unpinned nodes — re-assert.
    for (const el of unpinnedEls) {
      if (el.isConnected) unpin(el);
      else unpinnedEls.delete(el);
    }
    const body = document.body;
    if (!body) return;
    // A pinned scroller tracks the CURRENT viewport (100dvh grows with the
    // frame), so compare against innerHeight, not deviceH. Width filter keeps
    // sidebars/chat panels scrolling on their own. Unpinning one scroller can
    // expose a nested one; a few passes settle it.
    for (let pass = 0; pass < 3; pass++) {
      let found = false;
      for (const el of [body, ...body.querySelectorAll("*")]) {
        if (el.hasAttribute("data-dedup-ui") || unpinnedEls.has(el)) continue;
        if (
          el.clientHeight < window.innerHeight * 0.9 ||
          el.clientWidth < window.innerWidth * 0.6 ||
          el.scrollHeight <= el.clientHeight + 8
        ) {
          continue;
        }
        const oy = getComputedStyle(el).overflowY;
        if (oy !== "auto" && oy !== "scroll") continue;
        unpin(el);
        found = true;
      }
      if (!found) break;
    }
  }
  function measureHeight() {
    unpinPageScrollers();
    const doc = document.documentElement;
    const body = document.body;
    return Math.ceil(Math.max(doc.scrollHeight, body ? body.scrollHeight : 0));
  }
  function reportHeight() {
    if (heightTimer) return;
    heightTimer = setTimeout(() => {
      heightTimer = null;
      const h = measureHeight();
      if (Math.abs(h - lastReportedHeight) > 8) {
        lastReportedHeight = h;
        post("page-size", { height: h, path: location.pathname });
      }
      // Frame label (Figma artboard name): the page's own title + route.
      // `gesture` separates user navigation (spawns a new page artboard in
      // the editor) from app-initiated redirects like auth guards, which
      // must not — they'd spawn/snap-back forever.
      const meta = `${document.title} ${location.pathname}`;
      if (meta !== lastMeta) {
        lastMeta = meta;
        post("page-meta", {
          title: document.title,
          path: location.pathname,
          gesture: Date.now() - lastGesture < 1500,
        });
      }
      // Same debounced tick: the mutations that changed the height are the
      // ones that reshape the tree. Signature-gated, so quiet ticks are free.
      reportLayers(false);
    }, 200);
  }
  // User-gesture tracking for the navigation-vs-redirect call above.
  let lastGesture = 0;
  const markGesture = () => { lastGesture = Date.now(); };
  window.addEventListener("pointerdown", markGesture, true);
  window.addEventListener("keydown", markGesture, true);
  const mo = new MutationObserver(reportHeight);
  function observeBody() {
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true });
      reportHeight();
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeBody);
  } else {
    observeBody();
  }
  window.addEventListener("load", reportHeight);
  // Images/fonts finishing change height without DOM mutations.
  document.addEventListener("load", reportHeight, true);

  // --- canvas pan/zoom forwarding (FR-6.1) -----------------------------------
  // The iframe swallows wheel events, so the editor can't pan while the
  // cursor is over the page. Forward them — unless an inner scrollable
  // element can actually consume the scroll (nested panels keep working).

  function scrollableAncestor(el, dx, dy) {
    while (el && el !== document.documentElement && el.nodeType === 1) {
      const cs = getComputedStyle(el);
      if (
        dy !== 0 &&
        (cs.overflowY === "auto" || cs.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight &&
        ((dy < 0 && el.scrollTop > 0) ||
          (dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1))
      ) {
        return el;
      }
      if (
        dx !== 0 &&
        (cs.overflowX === "auto" || cs.overflowX === "scroll") &&
        el.scrollWidth > el.clientWidth &&
        ((dx < 0 && el.scrollLeft > 0) ||
          (dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1))
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  window.addEventListener(
    "wheel",
    (e) => {
      if (scrollableAncestor(e.target, e.deltaX, e.deltaY)) return;
      e.preventDefault();
      post("wheel", {
        dx: e.deltaX,
        dy: e.deltaY,
        // Pinch gestures arrive as ctrlKey wheels; ⌘+scroll is explicit zoom.
        zoomMod: e.ctrlKey || e.metaKey,
        x: e.clientX,
        y: e.clientY,
      });
    },
    { passive: false, capture: true },
  );

  window.addEventListener("scroll", repaint, true);
  window.addEventListener("resize", repaint, true);
  // HMR swaps DOM nodes under us; cheap periodic sync keeps boxes honest and
  // re-applies staged class patches to freshly rendered elements.
  setInterval(() => {
    // React re-renders (and HMR) rebuild nodes we patched. The program is
    // addressed by dedup id, not by node reference, so re-applying it is
    // always safe — do it whenever the DOM no longer matches.
    // Not while the caret is in an element: rebuilding would drop what the
    // user is typing into. The next non-edit tick catches up.
    if (!editingEl && structuralDrifted()) applyStructural();
    applyValues();
    repaint();
  }, 500);

  // `held` lets the editor confirm the freeze actually took (the boot script
  // runs earlier, and only when the frame was flagged).
  post("overlay-ready", { held: window.__dedupHeld === true });
})();
