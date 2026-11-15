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
import { marqueeHits, marqueeRect } from "./marquee.mjs";

(() => {
  "use strict";
  if (window.__dedupOverlay) return;
  window.__dedupOverlay = true;

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
  // Gesture state, declared up here rather than beside the handlers that own
  // them: `repaint` reads both, and it runs from listeners registered above
  // that code. A `let` read in its temporal dead zone throws, and a throw in
  // this IIFE silently kills every listener after it.
  let drag = null;
  let resizing = null;
  // Several elements selected at once. Either this holds two or more and
  // `selectedEl` is null, or it is empty — so everything that belongs to a
  // single selection (grips, the re-parent drag) is off by construction
  // rather than by a check someone has to remember.
  let multiEls = [];
  // A marquee being drawn in the select tool (see the pointer handlers).
  let marquee = null;
  // A marquee release is never also a click: the browser fires one after the
  // pointer comes up, and it would select whatever the drag happened to end
  // over. Set on release (and on Escape), spent by that click, and reset by
  // the next press in case the click never came.
  let suppressClick = false;

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
    // Drawn in screen pixels, not page ones: it is a label *about* the page
    // rather than part of it, so it stays the same size however far the
    // canvas is zoomed out — which is exactly when a name is hardest to read.
    font: "600 13px/16px -apple-system, system-ui, sans-serif",
    padding: "3px 7px",
    borderRadius: "4px",
    zIndex: String(Z + 1),
    whiteSpace: "nowrap",
  });
  /** Height of the badge as styled above (16px line + 3px padding each side),
   *  so it can be parked exactly above an element instead of guessed at. */
  const BADGE_H = 22;

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

  // The marquee, and one outline per element of a multi-selection. Screen
  // pixels like the rest of the chrome. The outlines are a pool grown on
  // demand in `paintMulti` — a selection has no fixed size to build for.
  const marqueeBox = makeBox("rgba(76,127,255,0.10)");
  marqueeBox.style.zIndex = String(Z + 2);
  const multiBoxes = [];

  const dropBox = makeBox("rgba(76,127,255,0.12)");
  dropBox.style.borderStyle = "dashed";
  dropBox.style.zIndex = String(Z + 2);

  // The ghost: the dragged element's own footprint, drawn in the slot the
  // release would put it in. The line answers "where is the insertion point",
  // which is not the question being asked — a page-wide section dropped into
  // a sidebar column looks nothing like the line implies, and until the
  // pointer came up there was no way to find that out.
  const dropGhost = makeBox("rgba(76,127,255,0.14)");
  dropGhost.style.borderRadius = "3px";
  dropGhost.style.boxShadow = "0 8px 24px rgba(23,42,89,0.22)";
  dropGhost.style.zIndex = String(Z + 1);

  // Cursor. Every element under the pointer belongs to the user's app and
  // most of them name a cursor of their own, so "this can be picked up" has
  // to be said in a rule that outranks theirs — said in a stylesheet keyed by
  // dedup id rather than by writing anything into their DOM. The two states
  // are scoped differently on purpose: `grab` belongs to the one element the
  // pointer is over, while `grabbing` covers the document, because mid-drag
  // the pointer is over whatever it happens to pass and the answer must not
  // change from element to element.
  const cursorStyle = document.createElement("style");
  cursorStyle.setAttribute("data-dedup-ui", "");
  /** What that sheet currently says: `repaint` runs on every mousemove, and
   *  assigning textContent re-parses the sheet whether it changed or not. */
  let cursorRule = "";

  function setCursor(kind, id) {
    const sel = id ? `[data-dedup-id="${cssEscapeAttr(id)}"]` : "";
    const rule =
      kind === "grabbing"
        ? "*{cursor:grabbing !important}"
        : kind === "grab" && sel
          ? `${sel},${sel} *{cursor:grab !important}`
          : "";
    if (rule === cursorRule) return;
    cursorRule = rule;
    cursorStyle.textContent = rule;
  }

  // --- "the AI is working on this" ------------------------------------------
  // A chat turn can take a minute, and the only sign of it was a spinner in a
  // side panel the user may have scrolled away from — while the thing being
  // worked on sat there looking idle. Squares lighting up across the element
  // say where the work is happening, and say it without implying a
  // percentage: there is no progress to report, only that something is
  // running. Drawn over the element rather than replacing it, because the
  // user is still entitled to look at what they asked about.
  const busyStyle = document.createElement("style");
  busyStyle.setAttribute("data-dedup-ui", "");
  busyStyle.textContent =
    "@keyframes dedup-busy{0%,100%{opacity:.08}50%{opacity:.5}}" +
    "[data-dedup-busy]>i{display:block;border-radius:2px;background:" +
    ACCENT +
    ";animation:dedup-busy 1.6s ease-in-out infinite}" +
    // Someone who has asked for less motion gets a still wash instead of a
    // pulse — the point is "work is happening here", not the animation.
    "@media (prefers-reduced-motion:reduce){[data-dedup-busy]>i{animation:none;opacity:.22}}";

  const busyBox = document.createElement("div");
  busyBox.setAttribute("data-dedup-ui", "");
  busyBox.setAttribute("data-dedup-busy", "");
  Object.assign(busyBox.style, {
    position: "fixed",
    display: "none",
    pointerEvents: "none",
    zIndex: String(Z),
    boxSizing: "border-box",
    overflow: "hidden",
    gap: "3px",
    padding: "3px",
  });

  // --- resize handles -------------------------------------------------------
  // Figma's eight grips on the selection. Two things make these different from
  // every other piece of chrome here:
  //
  //  * they are the only chrome with `pointerEvents: auto` — everything else
  //    is transparent to `elementFromPoint` on purpose, but a grip you cannot
  //    grab is not a grip;
  //  * they are sized in *screen* px, so they divide by the canvas zoom. At
  //    50% a handle drawn in page px would be 4px on screen, which is not a
  //    target anyone can hit.
  //
  // A handle only ever changes width/height. On a canvas the north-west grip
  // moves the element's origin; in document flow the element's position is the
  // layout's to decide, so dragging any grip resizes and lets the layout
  // re-anchor. The result is visible live, which is the honest version of a
  // gesture that cannot mean exactly what it means in Figma.
  const HANDLES = [
    ["nw", 0, 0, "nwse-resize"], ["n", 0.5, 0, "ns-resize"],
    ["ne", 1, 0, "nesw-resize"], ["e", 1, 0.5, "ew-resize"],
    ["se", 1, 1, "nwse-resize"], ["s", 0.5, 1, "ns-resize"],
    ["sw", 0, 1, "nesw-resize"], ["w", 0, 0.5, "ew-resize"],
  ];
  const handleEls = HANDLES.map(([dir, , , cursor]) => {
    const el = document.createElement("div");
    el.setAttribute("data-dedup-ui", "");
    el.setAttribute("data-dedup-handle", dir);
    Object.assign(el.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "auto",
      background: "#fff",
      border: `1.5px solid ${ACCENT}`,
      borderRadius: "2px",
      boxSizing: "border-box",
      cursor,
      zIndex: String(Z + 3),
    });
    return el;
  });

  /** Canvas zoom, so handles keep a constant on-screen size. */
  let canvasZoom = 1;
  /** Which element the editor says may be resized — null when the selection's
   * className is not statically editable, which is the same gate the
   * inspector uses. No grips on something the write-back would refuse. */
  let resizableId = null;

  // Staged-class preview rules (see applyValues). Declared here with the rest
  // of the chrome because mount() runs during script evaluation — anything it
  // appends has to exist by then, not further down the file.
  const previewStyle = document.createElement("style");
  previewStyle.setAttribute("data-dedup-ui", "");

  // --- viewport-height freeze ----------------------------------------------
  // The editor grows the canvas frame to the page's full height. Without help,
  // vh/dvh-based layouts (h-screen sections, 100dvh app shells) re-resolve
  // against the grown frame — sections balloon, and because height reporting
  // is mutation-driven (any later DOM change re-measures the page), a section
  // that already grew with the last resize gets counted again on the next
  // mutation and grows the frame further still. Left unpinned, a plain
  // full-height header can ratchet the frame toward the height cap on nothing
  // but its own re-renders. Pin viewport-height sizing to the DEVICE viewport
  // height (sent by the editor; falls back to the height at overlay load) so
  // the page keeps its designed proportions no matter how tall the frame
  // gets. The common Tailwind classnames are pinned unconditionally;
  // findViewportRules/pinInlineVh generalize the same fix to raw CSS, other
  // frameworks' equivalents (Bootstrap's .vh-100), and CSS-in-JS output —
  // none of which share a classname dedup could hardcode.
  let deviceH = window.innerHeight;
  const freezeStyle = document.createElement("style");
  freezeStyle.setAttribute("data-dedup-ui", "");
  // The whole property value, just `<number>(vh|dvh|svh|lvh)` — calc()/clamp()
  // expressions are left alone rather than risk pinning them wrong.
  const VH_VALUE_RE = /^\s*(-?\d*\.?\d+)(dvh|svh|lvh|vh)\s*$/i;
  const VH_PROPS = ["height", "min-height", "max-height"];
  function pinnedPx(rawValue) {
    const m = rawValue ? VH_VALUE_RE.exec(rawValue) : null;
    return m ? (parseFloat(m[1]) / 100) * deviceH + "px" : null;
  }
  // Same-origin stylesheets only — a cross-origin one throws on .cssRules,
  // and a rule dedup needs to override always lands in an accessible one
  // (the app's own bundled/JIT-generated CSS, same origin as the page).
  function collectViewportRules(rules, out) {
    for (const rule of rules) {
      if (rule.cssRules) { collectViewportRules(rule.cssRules, out); continue; }
      if (!rule.style || !rule.selectorText) continue;
      for (const prop of VH_PROPS) {
        const px = pinnedPx(rule.style.getPropertyValue(prop));
        if (px) out.push({ selector: rule.selectorText, prop, px });
      }
    }
  }
  function findViewportRules() {
    const out = [];
    for (const sheet of document.styleSheets || []) {
      try {
        if (sheet.cssRules) collectViewportRules(sheet.cssRules, out);
      } catch {}
    }
    return out;
  }
  // Elements sized by an inline vh style, reasserted every pass the way
  // unpinnedEls is below — a React re-render replaces the whole style
  // attribute and would otherwise put the live vh value straight back.
  const inlineVh = new Map();
  function pinInlineVh() {
    for (const el of document.querySelectorAll("[style]")) {
      if (inlineVh.has(el)) continue;
      const coeffs = [];
      for (const prop of VH_PROPS) {
        const m = VH_VALUE_RE.exec(el.style.getPropertyValue(prop));
        if (m) coeffs.push({ prop, num: parseFloat(m[1]) });
      }
      if (coeffs.length) inlineVh.set(el, coeffs);
    }
    for (const [el, coeffs] of inlineVh) {
      if (!el.isConnected) { inlineVh.delete(el); continue; }
      for (const { prop, num } of coeffs) {
        el.style.setProperty(prop, (num / 100) * deviceH + "px", "important");
      }
    }
  }
  function refreshFreeze() {
    const h = deviceH + "px";
    let css =
      ".h-screen,.h-dvh,.h-svh,.h-lvh{height:" + h + " !important}" +
      ".min-h-screen,.min-h-dvh,.min-h-svh,.min-h-lvh{min-height:" + h + " !important}" +
      ".max-h-screen,.max-h-dvh,.max-h-svh,.max-h-lvh{max-height:" + h + " !important}";
    for (const { selector, prop, px } of findViewportRules()) {
      css += selector + "{" + prop + ":" + px + " !important}";
    }
    freezeStyle.textContent = css;
    pinInlineVh();
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
    document.documentElement.appendChild(dropGhost);
    document.documentElement.appendChild(marqueeBox);
    document.documentElement.appendChild(cursorStyle);
    document.documentElement.appendChild(busyStyle);
    document.documentElement.appendChild(busyBox);
    for (const el of handleEls) document.documentElement.appendChild(el);
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

  /**
   * A path with this frame's dedup flags kept on it.
   *
   * The flags that change how a frame behaves — the hold, the offline cut —
   * ride in its query string, because they have to reach the page before the
   * app boots and the URL is the only channel that early. So any time the
   * overlay sends the frame to a bare path, they would be dropped: an offline
   * artboard would quietly come back online, a held one would run. The editor
   * would have no idea, because the label it draws comes from its own state.
   *
   * Matched by prefix rather than by name on purpose. The names live in the
   * boot script and in lib/origins.ts, two separately bundled worlds this file
   * is a third of — one more copy of a list to keep in sync is one more way to
   * lose a flag silently. `__dedup` is the convention; anything wearing it
   * belongs to dedup and travels with the frame.
   */
  function withFlags(path) {
    try {
      const url = new URL(path, location.href);
      new URLSearchParams(location.search).forEach((value, key) => {
        if (key.indexOf("__dedup") === 0) url.searchParams.set(key, value);
      });
      return url.pathname + url.search + url.hash;
    } catch {
      return path;
    }
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
    // The node the last insert put down at a given anchor. Two inserts placed
    // `after` the same element are written into source one behind the other,
    // but replayed naively they would land in the DOM the other way round —
    // each one going directly after the anchor pushes the previous one along.
    // A preview that disagrees with what the save writes is worse than no
    // preview, and pasting twice in a row is the ordinary way to reach it.
    const lastAfter = new Map();
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
        let ref = byId(op.id);
        if (!ref) continue;
        if (op.position === "after") {
          const previous = lastAfter.get(op.id);
          if (previous && previous.isConnected) ref = previous;
        }
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
        if (op.position === "after") lastAfter.set(op.id, node);
      }
    }
  }

  /**
   * The rendered HTML of one element, for a copy's staged preview.
   *
   * A paste needs two renderings of the same thing, exactly as the palette
   * does: the *source* comes from the write-back (the file is the truth about
   * what will be written) and the *picture* comes from here, because only the
   * page knows what that source turned into. Taken from the live DOM, so what
   * the user sees pasted is what they were looking at when they copied.
   *
   * Stripped of dedup's own stamps on the way out. `data-dedup-id` especially:
   * left in, the preview copy would answer to the same id as the element it
   * came from, and every lookup in this file — select, hover, staged class
   * patches, the layer tree — would start hitting whichever one the DOM
   * happened to return first.
   */
  function reportElementHtml(id) {
    const el = byId(id);
    if (!el) return;
    const clone = el.cloneNode(true);
    for (const node of [clone, ...clone.querySelectorAll("*")]) {
      // Overlay chrome never belongs to the page's own markup.
      if (node !== clone && node.hasAttribute("data-dedup-ui")) {
        node.remove();
        continue;
      }
      for (const attr of [...node.attributes]) {
        if (attr.name.startsWith("data-dedup-")) node.removeAttribute(attr.name);
      }
      node.removeAttribute("contenteditable");
    }
    post("element-html", { id: id, html: clone.outerHTML });
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
    // Already typing into this one: re-running would end the edit and reselect
    // all of its text, throwing away where the caret was.
    if (el === editingEl) return;
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
    // The editor cannot see the caret, and it has a mode to show while one is
    // on the canvas. Editing starting and stopping is reported from here —
    // this is the only place that knows, since Escape, Enter, a click
    // elsewhere and a re-render all end it without the editor being involved.
    post("text-editing", { id: id });
    repaint();
  }

  function endTextEdit() {
    if (!editingEl) return;
    editingEl.removeAttribute("contenteditable");
    editingEl.removeAttribute("data-dedup-editing");
    if (editingEl.blur) editingEl.blur();
    editingEl = null;
    post("text-editing", { id: null });
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
    // What the element is actually painted with. A class like `bg-primary`
    // names a token only this page can resolve — the editor has its own theme,
    // not the project's — so the inspector would otherwise show the name and
    // an empty swatch. Read once, with the class list it belongs to.
    const cs = getComputedStyle(el) || {};
    return {
      ...describe(el),
      colors: {
        background: cs.backgroundColor || null,
        text: cs.color || null,
        border: cs.borderTopColor || null,
      },
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

  /** The element the editor says is being worked on, and the grid currently
   *  laid out over it. */
  let busyId = null;
  let busyGrid = { cols: 0, rows: 0 };

  /**
   * Lay squares over an element, sized so they stay roughly square whatever
   * the element's shape is, and capped so a full-page section does not become
   * a thousand animated nodes.
   *
   * Rebuilt only when the count changes: repaint runs on every scroll, and
   * re-creating the grid each time would restart every animation and leave
   * the wave stuttering instead of travelling.
   */
  function paintBusy(r) {
    const cols = Math.max(1, Math.min(18, Math.round(r.width / 26)));
    const rows = Math.max(1, Math.min(12, Math.round(r.height / 26)));
    if (busyGrid.cols === cols && busyGrid.rows === rows) return;
    busyGrid = { cols: cols, rows: rows };
    busyBox.style.gridTemplateColumns = "repeat(" + cols + ",1fr)";
    busyBox.style.gridTemplateRows = "repeat(" + rows + ",1fr)";
    busyBox.textContent = "";
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const cell = document.createElement("i");
        // Diagonal wave: neighbours are a beat apart, so it reads as movement
        // across the section rather than every square blinking together.
        cell.style.animationDelay = (((x + y) * 110) % 1600) + "ms";
        busyBox.appendChild(cell);
      }
    }
  }

  function repaint() {
    const busyEl = busyId ? byId(busyId) : null;
    if (busyEl && busyEl.isConnected) {
      const r = position(busyBox, busyEl);
      busyBox.style.display = "grid";
      paintBusy(r);
    } else {
      busyBox.style.display = "none";
    }
    if (hoverEl && hoverEl.isConnected) {
      const r = position(hoverBox, hoverEl);
      badge.textContent = labelOf(hoverEl);
      badge.style.display = "block";
      // Above the element when there is room, tucked inside its top-left when
      // it is against the top of the frame.
      const above = r.y >= BADGE_H + 4;
      badge.style.left = r.x + "px";
      badge.style.top = (above ? r.y - BADGE_H - 2 : r.y + 2) + "px";
    } else {
      hoverBox.style.display = "none";
      badge.style.display = "none";
    }
    // While a drag is in flight the grabbing cursor covers the document;
    // before one, grab is offered only where a drag could actually start —
    // so the cursor also answers "can I move this?" before the user tries.
    if (drag && drag.active) setCursor("grabbing");
    else if (
      mode === "inspect" &&
      dragEnabled &&
      !insertArmed &&
      !resizing &&
      // A caret on the canvas outranks it: the double-click way into the text
      // tool leaves the select tool's drag armed, and a grab cursor over the
      // words you are typing is the wrong answer to "what happens if I click".
      !editingEl &&
      !(marquee && marquee.active) &&
      hoverEl &&
      hoverEl.isConnected &&
      // Only the selection can be picked up (see `dragOwner`): anywhere else
      // a drag draws a marquee, and a grab cursor there would be a promise
      // the gesture does not keep.
      dragOwner(hoverEl)
    ) {
      setCursor("grab", selectedEl.getAttribute("data-dedup-id"));
    } else setCursor(null);
    if (selectedEl && selectedEl.isConnected) {
      const r = position(selectBox, selectedEl);
      positionHandles(r);
    } else {
      selectBox.style.display = "none";
      hideHandles();
    }
    paintMulti();
  }

  /** One outline per element of a multi-selection — or, while a marquee is
   *  being drawn, per element it would select, so the answer to "what am I
   *  about to get" is on screen before the pointer comes up. */
  function paintMulti() {
    let els = multiEls;
    if (marquee && marquee.active) {
      els = marquee.additive ? unionById(marquee.base, marquee.hits) : marquee.hits;
    }
    els = els.filter((el) => el.isConnected);
    while (multiBoxes.length < els.length) {
      const box = makeBox("transparent");
      box.style.borderWidth = "1.5px";
      box.setAttribute("data-dedup-multi", "");
      document.documentElement.appendChild(box);
      multiBoxes.push(box);
    }
    for (let i = 0; i < multiBoxes.length; i++) {
      if (i < els.length) position(multiBoxes[i], els[i]);
      else multiBoxes[i].style.display = "none";
    }
  }

  function hideHandles() {
    for (const el of handleEls) el.style.display = "none";
  }

  /** Lay the eight grips on the selection's rect, sized in screen px. */
  function positionHandles(r) {
    // A resize in flight keeps its grips no matter what: they are under the
    // pointer, and hiding one mid-gesture drops its pointer capture.
    if (!resizing) {
      const id = selectedEl && selectedEl.getAttribute("data-dedup-id");
      // No grips unless the editor said this element's classes are editable,
      // and none while a reparent drag owns the pointer.
      if (!resizableId || id !== resizableId || (drag && drag.active)) {
        hideHandles();
        return;
      }
    }
    // Constant on-screen size: the page is drawn at `canvasZoom`, so a grip
    // that should read as 9px on screen is 9/zoom in page units.
    const size = 9 / (canvasZoom || 1);
    const half = size / 2;
    handleEls.forEach((el, i) => {
      const [, fx, fy] = HANDLES[i];
      Object.assign(el.style, {
        display: "block",
        width: size + "px",
        height: size + "px",
        left: r.x + r.width * fx - half + "px",
        top: r.y + r.height * fy - half + "px",
        borderWidth: Math.max(1, 1.5 / (canvasZoom || 1)) + "px",
      });
    });
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
        multiEls = [];
        repaint();
      }
    } else if (m.type === "select-ids") {
      // The editor's multi-selection, mirrored: broadcast to every frame, so
      // each outlines the ones it holds and drops the rest. With `report`
      // the frame holding any of them answers the way a marquee would — the
      // editor needs each element's payload, and only the page has those.
      const ids = Array.isArray(m.ids) ? m.ids : [];
      const els = [];
      for (const id of ids) {
        const el = typeof id === "string" ? byId(id) : null;
        if (el) els.push(el);
      }
      setSelection(inDocumentOrder(els));
      if (m.report && els.length > 0) reportSelection();
    } else if (m.type === "clear") {
      selectedEl = null;
      multiEls = [];
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
    } else if (m.type === "probe-drop") {
      // Something is being dragged over this page from outside it — an
      // element from another artboard, or a piece parked on the canvas. The
      // pointer is captured elsewhere, so this page hears nothing directly:
      // the editor relays the point, and the answer is the same slot an
      // in-page drag would land in, drawn the same way.
      const target =
        typeof m.x === "number" && typeof m.y === "number"
          ? dropTargetAt(m.x, m.y, null)
          : null;
      showDropIndicator(target);
      post("probe-result", {
        seq: m.seq,
        id: target ? target.el.getAttribute("data-dedup-id") : null,
        position: target ? target.position : null,
      });
    } else if (m.type === "probe-clear") {
      hideDropIndicator();
    } else if (m.type === "text-edit-begin") {
      beginTextEdit(m.id);
    } else if (m.type === "text-edit-end") {
      endTextEdit();
    } else if (m.type === "set-edit-mode") {
      dragEnabled = !!m.drag;
      insertArmed = !!m.insert;
      if (!insertArmed) hideDropIndicator();
      // The marquee belongs to the select tool; leaving it mid-drag ends it.
      if (!dragEnabled || insertArmed) cancelMarquee();
      repaint();
    } else if (m.type === "set-resizable") {
      // The editor answers "may this element's size be edited?" from the
      // write-back's own report, so the grips appear on exactly the elements
      // a class edit would land on.
      resizableId = m.id && m.enabled ? m.id : null;
      repaint();
    } else if (m.type === "set-zoom") {
      // Handles are drawn in page units but must read as a fixed size on
      // screen, so they need to know how far the canvas is scaled.
      canvasZoom = typeof m.zoom === "number" && m.zoom > 0 ? m.zoom : 1;
      repaint();
    } else if (m.type === "set-mode") {
      mode = m.mode === "browse" ? "browse" : "inspect";
      if (mode === "browse") {
        hoverEl = null;
        selectedEl = null;
        multiEls = [];
        cancelMarquee();
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
    } else if (m.type === "set-busy") {
      busyId = typeof m.id === "string" ? m.id : null;
      // The grid is rebuilt for whatever it lands on next.
      if (!busyId) busyGrid = { cols: 0, rows: 0 };
      repaint();
    } else if (m.type === "copy-element") {
      reportElementHtml(m.id);
    } else if (m.type === "navigate") {
      // Snap this frame back to its pinned route after a navigation spawned
      // a new artboard. Soft first (react-router listens to popstate, no
      // reload); hard fallback if the router didn't take it.
      const target = withFlags(String(m.path || "/"));
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
      if (target && location.pathname !== target) location.replace(withFlags(target));
      else location.reload();
    }
  });

  function select(el) {
    selectedEl = el;
    multiEls = [];
    repaint();
    post("selected", { payload: payload(el) });
  }

  // --- multi-selection ------------------------------------------------------
  // A selection is a set of *source* elements, so it is unique by dedup id:
  // two rows of one `.map()` are one element to the editor, and counting them
  // twice would put "2 elements selected" over a delete that removes one.

  function currentSelection() {
    return multiEls.length > 0 ? multiEls : selectedEl ? [selectedEl] : [];
  }

  function uniqueById(els) {
    const seen = new Set();
    const out = [];
    for (const el of els) {
      const id = el.getAttribute("data-dedup-id");
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(el);
    }
    return out;
  }

  function unionById(a, b) {
    return uniqueById([...a, ...b]);
  }

  /** Page order, whatever order the elements were picked in — it is the
   *  order a copy of them is pasted in, so it has to be the one on screen. */
  function inDocumentOrder(els) {
    const want = new Set(els);
    const out = [];
    for (const el of document.querySelectorAll("[data-dedup-id]")) {
      if (want.has(el)) out.push(el);
    }
    return out;
  }

  function setSelection(els) {
    const list = uniqueById(els);
    selectedEl = list.length === 1 ? list[0] : null;
    multiEls = list.length > 1 ? list : [];
    repaint();
  }

  /** Tell the editor what is selected now, in whichever shape fits. */
  function reportSelection() {
    const els = currentSelection();
    if (els.length === 0) post("deselected", {});
    else if (els.length === 1) post("selected", { payload: payload(els[0]) });
    else post("selected-many", { payloads: els.map(payload) });
  }

  // --- marquee --------------------------------------------------------------
  // The rule for which drag is which lives in `dragOwner`: a drag that starts
  // inside the one selected element picks it up, and every other drag in the
  // select tool draws a marquee. What the rectangle selects is decided by
  // marquee.mjs, not here.

  /**
   * The element a press at `el` would pick up, or null when the press should
   * draw a marquee instead. Only a single selection can be dragged, and only
   * from inside itself: select, then move — Figma's order. Asking for it the
   * other way round (any press on any element is a drag) left no room on a
   * page for a marquee at all, because a page has no empty space: every pixel
   * of it is inside some element.
   */
  function dragOwner(el) {
    if (!el || !selectedEl || multiEls.length > 0) return null;
    if (!selectedEl.isConnected || !selectedEl.contains(el)) return null;
    return structurallyEditable(selectedEl) ? selectedEl : null;
  }

  /** The elements the marquee `m` currently selects. */
  function marqueeTargets(m) {
    const all = [];
    for (const el of document.querySelectorAll("[data-dedup-id]")) {
      if (!el.hasAttribute("data-dedup-ui")) all.push(el);
    }
    const indexOf = new Map();
    all.forEach((el, i) => indexOf.set(el, i));
    const nodes = all.map((el) => {
      const r = el.getBoundingClientRect();
      const parent = tagged(el.parentElement);
      return {
        parent: parent && indexOf.has(parent) ? indexOf.get(parent) : -1,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      };
    });
    const rect = marqueeRect(m.x, m.y, m.x1, m.y1);
    return marqueeHits(nodes, rect).map((i) => all[i]);
  }

  function paintMarquee(m) {
    // Drawn only as far as the page goes: the pointer is captured and can be
    // well past the frame's edge, where there is nothing to draw on.
    const x0 = Math.max(0, Math.min(m.x, m.x1));
    const y0 = Math.max(0, Math.min(m.y, m.y1));
    const x1 = Math.min(window.innerWidth, Math.max(m.x, m.x1));
    const y1 = Math.min(window.innerHeight, Math.max(m.y, m.y1));
    Object.assign(marqueeBox.style, {
      display: "block",
      left: x0 + "px",
      top: y0 + "px",
      width: Math.max(0, x1 - x0) + "px",
      height: Math.max(0, y1 - y0) + "px",
    });
  }

  /** Put a marquee away without selecting anything. */
  function cancelMarquee() {
    if (!marquee) return;
    const wasActive = marquee.active;
    marquee = null;
    marqueeBox.style.display = "none";
    // The pointer is usually still down; the click its release produces must
    // not select whatever it lands on.
    if (wasActive) suppressClick = true;
  }

  /** ~60/sec, like the resize: hit-testing reads every tagged element's
   *  rect, which is too much to do per pointer event on a long page. The
   *  release always computes afresh, so a throttled-away move is never the
   *  answer. */
  const MARQUEE_THROTTLE_MS = 16;

  function moveMarquee(e) {
    const m = marquee;
    if (!m.active) {
      const moved = Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y);
      if (moved < DRAG_THRESHOLD) return;
      m.active = true;
      hoverEl = null;
      // Same reason a re-parent drag captures: without it the frame goes
      // deaf at its own edge and a marquee dragged past it never ends.
      try {
        document.documentElement.setPointerCapture(m.pointerId);
      } catch {
        // No capture: the marquee still works inside the frame.
      }
    }
    // Otherwise the browser reads the drag as a text selection.
    e.preventDefault();
    m.x1 = e.clientX;
    m.y1 = e.clientY;
    const now = Date.now();
    if (now - m.lastHit >= MARQUEE_THROTTLE_MS) {
      m.lastHit = now;
      m.hits = marqueeTargets(m);
    }
    paintMarquee(m);
    repaint();
  }

  function endMarquee(e) {
    const m = marquee;
    marquee = null;
    marqueeBox.style.display = "none";
    if (!m.active) {
      // Never travelled: an ordinary click, and the click handler's to read.
      repaint();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    suppressClick = true;
    m.x1 = e.clientX;
    m.y1 = e.clientY;
    const hits = marqueeTargets(m);
    setSelection(inDocumentOrder(m.additive ? unionById(m.base, hits) : hits));
    reportSelection();
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
   *
   * The edges that mean before/after lie along the axis the siblings are laid
   * out on. In a row that is x: people drag sideways there, and reading y
   * instead made nearly every sideways drop land in the middle band, nesting
   * the element inside its neighbour rather than beside it. In `row-reverse`
   * the DOM's `before` renders on the right, so the fraction is flipped —
   * whichever side the pointer is on is the side the element goes.
   */
  function dropTargetAt(x, y, exclude) {
    let el = tagged(document.elementFromPoint(x, y));
    while (el && exclude && (el === exclude || exclude.contains(el))) {
      el = tagged(el.parentElement);
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.height < 1) return null;
    const row = rowLayout(el.parentElement);
    let rel;
    if (row && r.width >= 1) {
      rel = (x - r.left) / r.width;
      if (row.reverse) rel = 1 - rel;
    } else {
      rel = (y - r.top) / r.height;
    }
    const acceptsChildren = !VOID_TAGS.has(el.tagName.toLowerCase());
    const position =
      acceptsChildren && rel > 0.3 && rel < 0.7
        ? "inside"
        : rel < 0.5
          ? "before"
          : "after";
    return { el, position, rect: r };
  }

  /**
   * Does this container lay its children out along the x axis? A drop
   * `before` a sibling in a row renders to its *left*; a ghost stacked above
   * it would be a confident lie about where the element is going. Only flex
   * is read — a grid's direction depends on the tracks, and guessing there
   * would be the same lie with more steps.
   */
  function rowLayout(el) {
    if (!el) return null;
    const cs = getComputedStyle(el) || {};
    const display = cs.display || "";
    if (display !== "flex" && display !== "inline-flex") return null;
    const dir = cs.flexDirection || "row";
    if (!dir.startsWith("row")) return null;
    return { reverse: dir.endsWith("reverse") };
  }

  /**
   * The dragged element's footprint, drawn where releasing would put it:
   * beside the target in a row, above or below it in a column, and *last*
   * inside a container — which is where the write-back's `inside` puts it.
   */
  function showGhost(target, dragged) {
    const g =
      dragged && dragged.isConnected ? dragged.getBoundingClientRect() : null;
    if (!g || g.width < 1 || g.height < 1) {
      dropGhost.style.display = "none";
      return;
    }
    const { rect: r, position } = target;
    const row = rowLayout(
      position === "inside" ? target.el : target.el.parentElement,
    );
    // The cross axis belongs to the container — a sibling in a column is as
    // wide as the column — so clamp it; the main axis is the element's own.
    const w = Math.max(2, row ? g.width : Math.min(g.width, r.width));
    const h = Math.max(2, row ? Math.min(g.height, r.height) : g.height);
    let x = r.x;
    let y = r.y;
    // Which end of the target it lands at, once row-reverse has had its say.
    const after = position === "inside" || position === "after";
    const end = row && row.reverse ? !after : after;
    if (position === "inside") {
      if (row) x = end ? r.x + Math.max(0, r.width - w) : r.x;
      else y = end ? r.y + Math.max(0, r.height - h) : r.y;
    } else if (row) {
      x = end ? r.x + r.width : r.x - w;
    } else {
      y = end ? r.y + r.height : r.y - h;
    }
    Object.assign(dropGhost.style, {
      display: "block",
      left: x + "px",
      top: y + "px",
      width: w + "px",
      height: h + "px",
    });
  }

  /** The element in flight fades, so the ghost is the one that reads as
   * going somewhere. Inline, and put back exactly as found — an element is
   * entitled to an inline opacity of its own. */
  function liftDragged(g) {
    g.opacity = g.el.style.opacity;
    g.el.style.opacity = "0.4";
  }

  function dropLifted(g) {
    if (!g || g.opacity === undefined) return;
    if (g.opacity) g.el.style.opacity = g.opacity;
    else g.el.style.removeProperty("opacity");
    g.opacity = undefined;
  }

  /** `dragged` is the element being re-parented, and only a drag has one:
   * the insert palette places something that does not exist yet, so it gets
   * the line alone. */
  function showDropIndicator(target, dragged) {
    if (!target) {
      hideDropIndicator();
      return;
    }
    showGhost(target, dragged);
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
    // Beside the target in a row, above or below it in a column: the line
    // marks the gap the element will fill, on the axis the siblings run along.
    const row = rowLayout(target.el.parentElement);
    if (row) {
      const end = (position === "after") !== row.reverse;
      Object.assign(dropLine.style, {
        display: "block",
        left: (end ? rect.x + rect.width - 1 : rect.x - 1) + "px",
        top: rect.y + "px",
        width: "2px",
        height: rect.height + "px",
      });
      return;
    }
    Object.assign(dropLine.style, {
      display: "block",
      left: rect.x + "px",
      top: (position === "before" ? rect.y - 1 : rect.y + rect.height - 1) + "px",
      width: rect.width + "px",
      height: "2px",
    });
  }

  function hideDropIndicator() {
    dropLine.style.display = "none";
    dropBox.style.display = "none";
    dropGhost.style.display = "none";
  }

  // --- resize ---------------------------------------------------------------
  //
  // A resize is a class edit like any other: the editor turns the size this
  // reports into `w-[…]`/`h-[…]` and stages it, so it previews, undoes, saves
  // and commits exactly the way dragging a padding stepper does. Nothing here
  // writes to the page permanently — the inline size below is live feedback
  // for the duration of the gesture and is handed back to the staged-class
  // preview on release.
  const MIN_SIZE = 8;
  /** ~60/sec: fast enough to feel continuous, slow enough that a drag is not
   * hundreds of staged edits and postMessage round trips. */
  const RESIZE_THROTTLE_MS = 16;
  let resizeSeq = 0;

  function startResize(e, dir) {
    if (!selectedEl || !selectedEl.isConnected) return;
    const r = selectedEl.getBoundingClientRect();
    resizing = {
      dir,
      el: selectedEl,
      x: e.clientX,
      y: e.clientY,
      w: r.width,
      h: r.height,
      // One id for the whole gesture: the editor folds every step into a
      // single undo entry, the way a scrub does.
      group: "resize-" + ++resizeSeq,
      sent: null,
      pending: null,
      lastSent: 0,
    };
    e.preventDefault();
    e.stopPropagation();
    try {
      e.target.setPointerCapture(e.pointerId);
    } catch {
      // Capture is an optimisation; the document listeners still fire.
    }
    post("resize-start", { id: selectedEl.getAttribute("data-dedup-id") });
  }

  function moveResize(e) {
    const g = resizing;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    const west = g.dir.includes("w");
    const east = g.dir.includes("e");
    const north = g.dir.includes("n");
    const south = g.dir.includes("s");

    let width = g.w;
    let height = g.h;
    if (east) width = g.w + dx;
    if (west) width = g.w - dx;
    if (south) height = g.h + dy;
    if (north) height = g.h - dy;
    width = Math.max(MIN_SIZE, Math.round(width));
    height = Math.max(MIN_SIZE, Math.round(height));

    // Immediate feedback, inline: waiting for the editor to stage a class and
    // echo a preview rule back is a full postMessage round trip per pointer
    // move, and the gesture would visibly trail the cursor.
    if (east || west) g.el.style.width = width + "px";
    if (north || south) g.el.style.height = height + "px";

    // Throttle: pointermove fires far faster than the editor needs, and every
    // report costs a staged edit plus a round trip back to every frame.
    // Deliberately a clock rather than requestAnimationFrame — one less global
    // to depend on, and the pending value below is what makes it safe.
    g.pending = {
      width: east || west ? width : null,
      height: north || south ? height : null,
    };
    const now = Date.now();
    if (now - g.lastSent < RESIZE_THROTTLE_MS) return;
    flushResize(g, now);
  }

  /** Send the pending size, if it differs from the last one sent. */
  function flushResize(g, now) {
    const next = g.pending;
    if (!next) return;
    if (g.sent && g.sent.width === next.width && g.sent.height === next.height) {
      return;
    }
    g.sent = next;
    g.lastSent = now || Date.now();
    post("resize", {
      id: g.el.getAttribute("data-dedup-id"),
      group: g.group,
      width: next.width,
      height: next.height,
    });
  }

  function endResize() {
    const g = resizing;
    resizing = null;
    if (!g) return;
    // The throttle can swallow the last move, and the last move is the size
    // the user actually chose — always commit it before letting go.
    flushResize(g, 0);
    // Hand the element back to the staged-class preview: the editor has by now
    // staged `w-[…]`, and leaving an inline size on top would mask whatever it
    // actually resolved to — including a size the class could not express.
    g.el.style.removeProperty("width");
    g.el.style.removeProperty("height");
    post("resize-end", {});
    repaint();
  }

  for (let i = 0; i < handleEls.length; i++) {
    const dir = HANDLES[i][0];
    handleEls[i].addEventListener("pointerdown", (e) => {
      if (mode !== "inspect" || e.button !== 0) return;
      startResize(e, dir);
    });
  }

  // Drag begins only after the pointer travels a few px, so a plain click on
  // an element still selects it.
  const DRAG_THRESHOLD = 4;

  /** Whether a point (this frame's CSS px) is off the page entirely. */
  function outsideFrame(x, y) {
    return x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
  }

  document.addEventListener(
    "pointerdown",
    (e) => {
      if (mode !== "inspect" || !dragEnabled || insertArmed) return;
      if (e.button !== 0 || isEditing(e.target)) return;
      suppressClick = false;
      // The grips are chrome with a gesture of their own.
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-dedup-ui")) {
        return;
      }
      const el = tagged(e.target);
      // Which drag this press could become. Inside the single selection it is
      // the re-parent drag, of the selected element; anywhere else — or with
      // Shift, which always means "add to the selection" — it is a marquee.
      const owner = e.shiftKey ? null : dragOwner(el);
      if (owner) {
        drag = {
          el: owner,
          x: e.clientX,
          y: e.clientY,
          active: false,
          target: null,
          pointerId: e.pointerId,
          outside: false,
        };
        return;
      }
      marquee = {
        x: e.clientX,
        y: e.clientY,
        x1: e.clientX,
        y1: e.clientY,
        pointerId: e.pointerId,
        active: false,
        additive: !!e.shiftKey,
        // What Shift adds to: the selection as it stood when the drag began.
        base: e.shiftKey ? currentSelection().slice() : [],
        hits: [],
        lastHit: 0,
      };
    },
    true,
  );

  document.addEventListener(
    "pointermove",
    (e) => {
      if (resizing) {
        e.preventDefault();
        e.stopPropagation();
        moveResize(e);
        repaint();
        return;
      }
      if (insertArmed && mode === "inspect") {
        showDropIndicator(dropTargetAt(e.clientX, e.clientY, null));
        return;
      }
      if (marquee) {
        moveMarquee(e);
        return;
      }
      if (!drag) return;
      if (!drag.active) {
        const moved =
          Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
        if (moved < DRAG_THRESHOLD) return;
        drag.active = true;
        hoverEl = null;
        liftDragged(drag);
        repaint();
        // Keep receiving the pointer after it leaves this frame. Without
        // capture the iframe goes deaf at its own edge, and an element could
        // never be dragged out onto the canvas or into another artboard.
        try {
          document.documentElement.setPointerCapture(drag.pointerId);
        } catch {
          // No capture (an old engine, a synthetic event): the drag still
          // works inside the frame, which is all it ever did.
        }
        post("drag-start", { id: drag.el.getAttribute("data-dedup-id") });
      }
      e.preventDefault();
      // Off this page: the editor owns what happens out there — empty canvas
      // (park it) or another artboard (which it probes). Coordinates stay in
      // this frame's CSS px; only the editor knows where the frame is.
      if (outsideFrame(e.clientX, e.clientY)) {
        drag.target = null;
        hideDropIndicator();
        drag.outside = true;
        const component = drag.el.getAttribute("data-dedup-component");
        const tag = drag.el.tagName.toLowerCase();
        post("drag-outside", {
          x: e.clientX,
          y: e.clientY,
          id: drag.el.getAttribute("data-dedup-id"),
          label: component ? `${component} · ${tag}` : tag,
        });
        return;
      }
      if (drag.outside) {
        drag.outside = false;
        post("drag-outside", { x: null, y: null });
      }
      drag.target = dropTargetAt(e.clientX, e.clientY, drag.el);
      showDropIndicator(drag.target, drag.el);
    },
    true,
  );

  document.addEventListener(
    "pointerup",
    (e) => {
      if (resizing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        endResize();
        return;
      }
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
      if (marquee) {
        // Before the drag branch and returning from it: a marquee release is
        // a selection and nothing else — never a `drop`.
        endMarquee(e);
        return;
      }
      if (!drag) return;
      const finished = drag;
      drag = null;
      hideDropIndicator();
      dropLifted(finished);
      repaint();
      if (!finished.active) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      post("drag-end", {});
      if (finished.outside && outsideFrame(e.clientX, e.clientY)) {
        // Released off the page. The element itself is described so the
        // editor can name it without waiting on a selection round-trip.
        post("drop-outside", {
          id: finished.el.getAttribute("data-dedup-id"),
          x: e.clientX,
          y: e.clientY,
          element: payload(finished.el),
        });
        return;
      }
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
    if (drag?.outside) post("drag-outside", { x: null, y: null });
    dropLifted(drag);
    drag = null;
    hideDropIndicator();
    cancelMarquee();
    repaint();
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
      // ⌘C/⌘X/⌘V only when the page holds no text selection of its own: the
      // browser's copy is what someone highlighting a paragraph means, and
      // taking it would be the wrong answer to an unambiguous gesture.
      const textSelected = !(window.getSelection()?.isCollapsed ?? true);
      const forwarded =
        (meta &&
          (e.key === "s" ||
            e.key === "z" ||
            (!textSelected && (e.key === "c" || e.key === "x" || e.key === "v")) ||
            /^[123]$/.test(e.key))) ||
        (!meta &&
          (e.key === "Escape" ||
            e.key === "Delete" ||
            e.key === "Backspace" ||
            e.key === "v" ||
            e.key === "h" ||
            e.key === "b" ||
            e.key === "t"));
      if (!forwarded) return;
      if (marquee?.active && e.key === "Escape") {
        // Escape mid-marquee takes back the marquee, not the selection that
        // was there before it — so it is not forwarded as the editor's
        // "deselect".
        cancelMarquee();
        repaint();
        e.preventDefault();
        return;
      }
      if (drag?.active && e.key === "Escape") {
        dropLifted(drag);
        drag = null;
        hideDropIndicator();
        repaint();
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
      if (marquee && marquee.active) return;
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
      // The click a marquee's release produces: already answered.
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      // A click that ended a drag or placed an element is not a selection.
      if (drag?.active || insertArmed) return;
      const el = tagged(e.target);
      if (el && e.shiftKey && dragEnabled) {
        // Shift-click adds one element to the selection, or takes it out.
        const id = el.getAttribute("data-dedup-id");
        const current = currentSelection();
        const without = current.filter((c) => c.getAttribute("data-dedup-id") !== id);
        setSelection(
          inDocumentOrder(without.length < current.length ? without : [...current, el]),
        );
        reportSelection();
        return;
      }
      if (el) select(el);
      else if (dragEnabled) {
        // Nothing of the project's under the pointer: the page's own empty
        // space, which in the select tool means "select nothing".
        setSelection([]);
        reportSelection();
      }
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
    refreshFreeze();
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
