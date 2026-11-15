"use strict";
(() => {
  // plugin-src/marquee.mjs
  function marqueeRect(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      width: Math.abs(x1 - x0),
      height: Math.abs(y1 - y0)
    };
  }
  function overlaps(a, b) {
    if (a.width <= 0 || a.height <= 0) return false;
    return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
  }
  function encloses(outer, inner) {
    return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
  }
  function marqueeHits(nodes, rect) {
    const children = /* @__PURE__ */ new Map();
    for (let i = 0; i < nodes.length; i++) {
      const p = nodes[i].parent;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(i);
    }
    const hits = [];
    const visit = (index) => {
      const node = nodes[index];
      const inside = children.get(index) ?? [];
      if (overlaps(node, rect) && (inside.length === 0 || !encloses(node, rect))) {
        hits.push(index);
        return;
      }
      for (const child of inside) visit(child);
    };
    for (const top of children.get(-1) ?? []) visit(top);
    return hits;
  }

  // plugin-src/overlay.js
  (() => {
    "use strict";
    if (window.__dedupOverlay) return;
    window.__dedupOverlay = true;
    const ACCENT = "#4c7fff";
    const Z = 2147483646;
    let hoverEl = null;
    let selectedEl = null;
    let mode = "inspect";
    let dragEnabled = false;
    let insertArmed = false;
    let drag = null;
    let resizing = null;
    let multiEls = [];
    let marquee = null;
    let suppressClick = false;
    let program = { classes: {}, texts: {}, structural: [] };
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
        boxSizing: "border-box"
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
      whiteSpace: "nowrap"
    });
    const BADGE_H = 22;
    const dropLine = document.createElement("div");
    dropLine.setAttribute("data-dedup-ui", "");
    Object.assign(dropLine.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      height: "2px",
      background: ACCENT,
      borderRadius: "2px",
      zIndex: String(Z + 2)
    });
    const marqueeBox = makeBox("rgba(76,127,255,0.10)");
    marqueeBox.style.zIndex = String(Z + 2);
    const multiBoxes = [];
    const dropBox = makeBox("rgba(76,127,255,0.12)");
    dropBox.style.borderStyle = "dashed";
    dropBox.style.zIndex = String(Z + 2);
    const dropGhost = makeBox("rgba(76,127,255,0.14)");
    dropGhost.style.borderRadius = "3px";
    dropGhost.style.boxShadow = "0 8px 24px rgba(23,42,89,0.22)";
    dropGhost.style.zIndex = String(Z + 1);
    const cursorStyle = document.createElement("style");
    cursorStyle.setAttribute("data-dedup-ui", "");
    let cursorRule = "";
    function setCursor(kind, id) {
      const sel = id ? `[data-dedup-id="${cssEscapeAttr(id)}"]` : "";
      const rule = kind === "grabbing" ? "*{cursor:grabbing !important}" : kind === "grab" && sel ? `${sel},${sel} *{cursor:grab !important}` : "";
      if (rule === cursorRule) return;
      cursorRule = rule;
      cursorStyle.textContent = rule;
    }
    const busyStyle = document.createElement("style");
    busyStyle.setAttribute("data-dedup-ui", "");
    busyStyle.textContent = "@keyframes dedup-busy{0%,100%{opacity:.08}50%{opacity:.5}}[data-dedup-busy]>i{display:block;border-radius:2px;background:" + ACCENT + ";animation:dedup-busy 1.6s ease-in-out infinite}@media (prefers-reduced-motion:reduce){[data-dedup-busy]>i{animation:none;opacity:.22}}";
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
      padding: "3px"
    });
    const HANDLES = [
      ["nw", 0, 0, "nwse-resize"],
      ["n", 0.5, 0, "ns-resize"],
      ["ne", 1, 0, "nesw-resize"],
      ["e", 1, 0.5, "ew-resize"],
      ["se", 1, 1, "nwse-resize"],
      ["s", 0.5, 1, "ns-resize"],
      ["sw", 0, 1, "nesw-resize"],
      ["w", 0, 0.5, "ew-resize"]
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
        zIndex: String(Z + 3)
      });
      return el;
    });
    let canvasZoom = 1;
    let resizableId = null;
    const previewStyle = document.createElement("style");
    previewStyle.setAttribute("data-dedup-ui", "");
    let deviceH = window.innerHeight;
    const freezeStyle = document.createElement("style");
    freezeStyle.setAttribute("data-dedup-ui", "");
    const VH_VALUE_RE = /^\s*(-?\d*\.?\d+)(dvh|svh|lvh|vh)\s*$/i;
    const VH_PROPS = ["height", "min-height", "max-height"];
    function pinnedPx(rawValue) {
      const m = rawValue ? VH_VALUE_RE.exec(rawValue) : null;
      return m ? parseFloat(m[1]) / 100 * deviceH + "px" : null;
    }
    function collectViewportRules(rules, out) {
      for (const rule of rules) {
        if (rule.cssRules) {
          collectViewportRules(rule.cssRules, out);
          continue;
        }
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
        } catch {
        }
      }
      return out;
    }
    const inlineVh = /* @__PURE__ */ new Map();
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
        if (!el.isConnected) {
          inlineVh.delete(el);
          continue;
        }
        for (const { prop, num } of coeffs) {
          el.style.setProperty(prop, num / 100 * deviceH + "px", "important");
        }
      }
    }
    function refreshFreeze() {
      const h = deviceH + "px";
      let css = ".h-screen,.h-dvh,.h-svh,.h-lvh{height:" + h + " !important}.min-h-screen,.min-h-dvh,.min-h-svh,.min-h-lvh{min-height:" + h + " !important}.max-h-screen,.max-h-dvh,.max-h-svh,.max-h-lvh{max-height:" + h + " !important}";
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
      return component ? `${component} \xB7 ${tag}` : tag;
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
        domId: getOrAssignDomId(el)
      };
    }
    let domIdSeq = 0;
    function getOrAssignDomId(el) {
      let id = el.getAttribute("data-dedup-dom");
      if (!id) {
        id = "d" + (++domIdSeq).toString(36) + Date.now().toString(36).slice(-4);
        el.setAttribute("data-dedup-dom", id);
      }
      return id;
    }
    const byId = (id) => document.querySelector(`[data-dedup-id="${CSS.escape(id)}"]`);
    const allById = (id) => document.querySelectorAll(`[data-dedup-id="${CSS.escape(id)}"]`);
    const stagedFrom = /* @__PURE__ */ new Map();
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
        if (decls) rules.push(`html [data-dedup-id="${cssEscapeAttr(id)}"]{${decls}}`);
      }
      for (const [id, from] of [...stagedFrom]) {
        if (program.classes[id]) continue;
        for (const el of allById(id)) el.setAttribute("class", from);
        stagedFrom.delete(id);
      }
      previewStyle.textContent = rules.join("\n");
      for (const [id, patch] of Object.entries(program.texts)) {
        for (const el of allById(id)) {
          if (el === editingEl) continue;
          if (el.textContent !== patch.to) el.textContent = patch.to;
        }
      }
    }
    function declarationsFor(cls) {
      const out = [];
      for (const token of cls.split(/\s+/)) {
        if (!token || token.includes(":")) continue;
        const decls = styleFor(token);
        if (!decls) continue;
        for (const [prop, value] of decls) out.push(`${prop}:${value}`);
      }
      return out.join(";");
    }
    function cssEscapeAttr(v) {
      return v.replace(/["\\]/g, "\\$&");
    }
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
    let applied = [];
    function origin(node) {
      return { node, parent: node.parentNode, next: node.nextSibling };
    }
    function restore(entry) {
      const { node, parent, next } = entry;
      if (!parent || !parent.isConnected) return;
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
    function placeNode(node, ref, position2) {
      if (position2 === "inside") ref.appendChild(node);
      else if (position2 === "before") ref.parentNode?.insertBefore(node, ref);
      else ref.parentNode?.insertBefore(node, ref.nextSibling);
    }
    function applyStructural() {
      resetStructural();
      const lastAfter = /* @__PURE__ */ new Map();
      for (const op of program.structural) {
        if (op.op === "remove") {
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
          node.setAttribute("data-dedup-staged", "insert");
          if (op.pendingId) node.setAttribute("data-dedup-id", op.pendingId);
          applied.push({ kind: "insert", node });
          placeNode(node, ref, op.position);
          if (op.position === "after") lastAfter.set(op.id, node);
        }
      }
    }
    function reportElementHtml(id) {
      const el = byId(id);
      if (!el) return;
      const clone = el.cloneNode(true);
      for (const node of [clone, ...clone.querySelectorAll("*")]) {
        if (node !== clone && node.hasAttribute("data-dedup-ui")) {
          node.remove();
          continue;
        }
        for (const attr of [...node.attributes]) {
          if (attr.name.startsWith("data-dedup-")) node.removeAttribute(attr.name);
        }
        node.removeAttribute("contenteditable");
      }
      post("element-html", { id, html: clone.outerHTML });
    }
    let editingEl = null;
    let editingOriginal = "";
    function isEditing(node) {
      return !!editingEl && (node === editingEl || editingEl.contains(node));
    }
    function beginTextEdit(id) {
      const el = byId(id);
      if (!el) return;
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
      }
      post("text-editing", { id });
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
      true
    );
    document.addEventListener(
      "input",
      () => {
        if (!editingEl) return;
        post("text-input", {
          id: editingEl.getAttribute("data-dedup-id"),
          text: editingEl.textContent
        });
      },
      true
    );
    document.addEventListener(
      "focusout",
      (e) => {
        if (isEditing(e.target)) endTextEdit();
      },
      true
    );
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
          const ok = op.position === "inside" ? el.parentElement === ref : el.parentElement === ref.parentElement;
          if (!ok) return true;
        }
      }
      return false;
    }
    let structuralSig = "";
    function applyProgram() {
      const sig = JSON.stringify(program.structural);
      if (sig !== structuralSig) {
        structuralSig = sig;
        endTextEdit();
        applyStructural();
      }
      applyValues();
      repaint();
    }
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
        return `${(a / b * 100).toFixed(4)}%`;
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
      "rounded-full": [["border-radius", "9999px"]]
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
      inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)"
    };
    const SPACING_SIDES = { "": ["top", "right", "bottom", "left"], t: ["top"], r: ["right"], b: ["bottom"], l: ["left"], x: ["left", "right"], y: ["top", "bottom"] };
    function styleFor(token) {
      if (STATIC[token]) return STATIC[token];
      let m;
      if (m = token.match(/^(-?)([pm])(t|r|b|l|x|y)?-(.+)$/)) {
        const base = m[2] === "p" ? "padding" : "margin";
        const sides = SPACING_SIDES[m[3] ?? ""];
        return spacingDecl(sides.map((s) => `${base}-${s}`), m[1] + m[4]);
      }
      if (m = token.match(/^gap(-[xy])?-(.+)$/)) {
        const prop = m[1] === "-x" ? "column-gap" : m[1] === "-y" ? "row-gap" : "gap";
        return spacingDecl([prop], m[2]);
      }
      if (m = token.match(/^(min-|max-)?([wh])-(.+)$/)) {
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
      if (m = token.match(/^text-(left|center|right|justify)$/)) {
        return [["text-align", m[1]]];
      }
      if (m = token.match(/^text-(.+)$/)) {
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
      if (m = token.match(/^bg-(.+)$/)) {
        const color = colorValue(m[1]);
        return color === null ? null : [["background-color", color]];
      }
      if (m = token.match(/^border-(0|2|4|8)$/)) {
        return [["border-width", `${m[1]}px`]];
      }
      if (m = token.match(/^border-(.+)$/)) {
        const color = colorValue(m[1]);
        return color === null ? null : [["border-color", color]];
      }
      if (m = token.match(/^rounded-(.+)$/)) {
        if (RADII[m[1]]) {
          return [["border-radius", `var(--radius-${m[1]}, ${RADII[m[1]]})`]];
        }
        if (/^\[.+\]$/.test(m[1])) return [["border-radius", m[1].slice(1, -1)]];
        return null;
      }
      if ((m = token.match(/^shadow-(.+)$/)) && SHADOWS[m[1]]) {
        return [["box-shadow", `var(--shadow-${m[1]}, ${SHADOWS[m[1]]})`]];
      }
      if (m = token.match(/^leading-(.+)$/)) {
        const named = { none: "1", tight: "1.25", snug: "1.375", normal: "1.5", relaxed: "1.625", loose: "2" }[m[1]];
        if (named) return [["line-height", named]];
        if (/^\d+(\.\d+)?$/.test(m[1])) return [["line-height", SPACE(m[1])]];
        return null;
      }
      if (m = token.match(/^tracking-(.+)$/)) {
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
      const cs = getComputedStyle(el) || {};
      return {
        ...describe(el),
        colors: {
          background: cs.backgroundColor || null,
          text: cs.color || null,
          border: cs.borderTopColor || null
        },
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        instanceCount: document.querySelectorAll(
          `[data-dedup-id="${CSS.escape(id)}"]`
        ).length,
        ancestry
        // innermost-first, includes the element itself
      };
    }
    function position(box, el) {
      const r = el.getBoundingClientRect();
      Object.assign(box.style, {
        display: "block",
        left: r.x + "px",
        top: r.y + "px",
        width: r.width + "px",
        height: r.height + "px"
      });
      return r;
    }
    let busyId = null;
    let busyGrid = { cols: 0, rows: 0 };
    function paintBusy(r) {
      const cols = Math.max(1, Math.min(18, Math.round(r.width / 26)));
      const rows = Math.max(1, Math.min(12, Math.round(r.height / 26)));
      if (busyGrid.cols === cols && busyGrid.rows === rows) return;
      busyGrid = { cols, rows };
      busyBox.style.gridTemplateColumns = "repeat(" + cols + ",1fr)";
      busyBox.style.gridTemplateRows = "repeat(" + rows + ",1fr)";
      busyBox.textContent = "";
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const cell = document.createElement("i");
          cell.style.animationDelay = (x + y) * 110 % 1600 + "ms";
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
        const above = r.y >= BADGE_H + 4;
        badge.style.left = r.x + "px";
        badge.style.top = (above ? r.y - BADGE_H - 2 : r.y + 2) + "px";
      } else {
        hoverBox.style.display = "none";
        badge.style.display = "none";
      }
      if (drag && drag.active) setCursor("grabbing");
      else if (mode === "inspect" && dragEnabled && !insertArmed && !resizing && // A caret on the canvas outranks it: the double-click way into the text
      // tool leaves the select tool's drag armed, and a grab cursor over the
      // words you are typing is the wrong answer to "what happens if I click".
      !editingEl && !(marquee && marquee.active) && hoverEl && hoverEl.isConnected && // Only the selection can be picked up (see `dragOwner`): anywhere else
      // a drag draws a marquee, and a grab cursor there would be a promise
      // the gesture does not keep.
      dragOwner(hoverEl)) {
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
    function positionHandles(r) {
      if (!resizing) {
        const id = selectedEl && selectedEl.getAttribute("data-dedup-id");
        if (!resizableId || id !== resizableId || drag && drag.active) {
          hideHandles();
          return;
        }
      }
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
          borderWidth: Math.max(1, 1.5 / (canvasZoom || 1)) + "px"
        });
      });
    }
    function post(type, data) {
      window.parent.postMessage({ __dedup: true, type, ...data }, "*");
    }
    function describeArg(v) {
      if (typeof v === "string") return v;
      if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
      try {
        return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
      } catch {
        return String(v);
      }
    }
    let logBudget = 200;
    setInterval(() => {
      logBudget = Math.min(200, logBudget + 20);
    }, 1e3);
    function forward(level, args) {
      if (logBudget <= 0) return;
      logBudget--;
      let text = "";
      try {
        text = Array.prototype.map.call(args, describeArg).join(" ");
      } catch {
        text = "(unserializable console arguments)";
      }
      if (text.length > 2e3) text = text.slice(0, 2e3) + "\u2026";
      post("page-log", { level, text, path: location.pathname });
    }
    for (const level of ["error", "warn"]) {
      const original = console[level];
      console[level] = function(...args) {
        try {
          forward(level, args);
        } catch {
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
          `[data-dedup-id="${CSS.escape(m.id)}"]`
        );
        if (el) select(el);
        else {
          selectedEl = null;
          multiEls = [];
          repaint();
        }
      } else if (m.type === "select-ids") {
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
        program = {
          classes: m.classes || {},
          texts: m.texts || {},
          structural: Array.isArray(m.structural) ? m.structural : []
        };
        applyProgram();
      } else if (m.type === "probe-drop") {
        const target = typeof m.x === "number" && typeof m.y === "number" ? dropTargetAt(m.x, m.y, null) : null;
        showDropIndicator(target);
        post("probe-result", {
          seq: m.seq,
          id: target ? target.el.getAttribute("data-dedup-id") : null,
          position: target ? target.position : null
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
        if (!dragEnabled || insertArmed) cancelMarquee();
        repaint();
      } else if (m.type === "set-resizable") {
        resizableId = m.id && m.enabled ? m.id : null;
        repaint();
      } else if (m.type === "set-zoom") {
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
        if (typeof window.__dedupRelease === "function") window.__dedupRelease();
      } else if (m.type === "hover-id") {
        hoverEl = m.id ? byId(m.id) : null;
        repaint();
      } else if (m.type === "list-layers") {
        reportLayers(true);
      } else if (m.type === "set-busy") {
        busyId = typeof m.id === "string" ? m.id : null;
        if (!busyId) busyGrid = { cols: 0, rows: 0 };
        repaint();
      } else if (m.type === "copy-element") {
        reportElementHtml(m.id);
      } else if (m.type === "navigate") {
        const target = withFlags(String(m.path || "/"));
        try {
          history.replaceState(null, "", target);
          window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
        } catch {
        }
        setTimeout(() => {
          if (location.pathname !== target) location.replace(target);
        }, 400);
      } else if (m.type === "set-viewport") {
        if (typeof m.height === "number" && m.height > 0 && m.height !== deviceH) {
          deviceH = m.height;
          refreshFreeze();
          reportHeight();
        }
      } else if (m.type === "reload") {
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
    function currentSelection() {
      return multiEls.length > 0 ? multiEls : selectedEl ? [selectedEl] : [];
    }
    function uniqueById(els) {
      const seen = /* @__PURE__ */ new Set();
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
    function reportSelection() {
      const els = currentSelection();
      if (els.length === 0) post("deselected", {});
      else if (els.length === 1) post("selected", { payload: payload(els[0]) });
      else post("selected-many", { payloads: els.map(payload) });
    }
    function dragOwner(el) {
      if (!el || !selectedEl || multiEls.length > 0) return null;
      if (!selectedEl.isConnected || !selectedEl.contains(el)) return null;
      return structurallyEditable(selectedEl) ? selectedEl : null;
    }
    function marqueeTargets(m) {
      const all = [];
      for (const el of document.querySelectorAll("[data-dedup-id]")) {
        if (!el.hasAttribute("data-dedup-ui")) all.push(el);
      }
      const indexOf = /* @__PURE__ */ new Map();
      all.forEach((el, i) => indexOf.set(el, i));
      const nodes = all.map((el) => {
        const r = el.getBoundingClientRect();
        const parent = tagged(el.parentElement);
        return {
          parent: parent && indexOf.has(parent) ? indexOf.get(parent) : -1,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height
        };
      });
      const rect = marqueeRect(m.x, m.y, m.x1, m.y1);
      return marqueeHits(nodes, rect).map((i) => all[i]);
    }
    function paintMarquee(m) {
      const x0 = Math.max(0, Math.min(m.x, m.x1));
      const y0 = Math.max(0, Math.min(m.y, m.y1));
      const x1 = Math.min(window.innerWidth, Math.max(m.x, m.x1));
      const y1 = Math.min(window.innerHeight, Math.max(m.y, m.y1));
      Object.assign(marqueeBox.style, {
        display: "block",
        left: x0 + "px",
        top: y0 + "px",
        width: Math.max(0, x1 - x0) + "px",
        height: Math.max(0, y1 - y0) + "px"
      });
    }
    function cancelMarquee() {
      if (!marquee) return;
      const wasActive = marquee.active;
      marquee = null;
      marqueeBox.style.display = "none";
      if (wasActive) suppressClick = true;
    }
    const MARQUEE_THROTTLE_MS = 16;
    function moveMarquee(e) {
      const m = marquee;
      if (!m.active) {
        const moved = Math.abs(e.clientX - m.x) + Math.abs(e.clientY - m.y);
        if (moved < DRAG_THRESHOLD) return;
        m.active = true;
        hoverEl = null;
        try {
          document.documentElement.setPointerCapture(m.pointerId);
        } catch {
        }
      }
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
    const VOID_TAGS = /* @__PURE__ */ new Set([
      "area",
      "base",
      "br",
      "col",
      "embed",
      "hr",
      "img",
      "input",
      "link",
      "meta",
      "param",
      "source",
      "track",
      "wbr"
    ]);
    function structurallyEditable(el) {
      return !!el && !el.hasAttribute("data-dedup-dyn") && !el.hasAttribute("data-dedup-core") && !!el.parentElement?.closest("[data-dedup-id]");
    }
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
      const position2 = acceptsChildren && rel > 0.3 && rel < 0.7 ? "inside" : rel < 0.5 ? "before" : "after";
      return { el, position: position2, rect: r };
    }
    function rowLayout(el) {
      if (!el) return null;
      const cs = getComputedStyle(el) || {};
      const display = cs.display || "";
      if (display !== "flex" && display !== "inline-flex") return null;
      const dir = cs.flexDirection || "row";
      if (!dir.startsWith("row")) return null;
      return { reverse: dir.endsWith("reverse") };
    }
    function showGhost(target, dragged) {
      const g = dragged && dragged.isConnected ? dragged.getBoundingClientRect() : null;
      if (!g || g.width < 1 || g.height < 1) {
        dropGhost.style.display = "none";
        return;
      }
      const { rect: r, position: position2 } = target;
      const row = rowLayout(
        position2 === "inside" ? target.el : target.el.parentElement
      );
      const w = Math.max(2, row ? g.width : Math.min(g.width, r.width));
      const h = Math.max(2, row ? Math.min(g.height, r.height) : g.height);
      let x = r.x;
      let y = r.y;
      const after = position2 === "inside" || position2 === "after";
      const end = row && row.reverse ? !after : after;
      if (position2 === "inside") {
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
        height: h + "px"
      });
    }
    function liftDragged(g) {
      g.opacity = g.el.style.opacity;
      g.el.style.opacity = "0.4";
    }
    function dropLifted(g) {
      if (!g || g.opacity === void 0) return;
      if (g.opacity) g.el.style.opacity = g.opacity;
      else g.el.style.removeProperty("opacity");
      g.opacity = void 0;
    }
    function showDropIndicator(target, dragged) {
      if (!target) {
        hideDropIndicator();
        return;
      }
      showGhost(target, dragged);
      const { rect, position: position2 } = target;
      if (position2 === "inside") {
        dropLine.style.display = "none";
        Object.assign(dropBox.style, {
          display: "block",
          left: rect.x + "px",
          top: rect.y + "px",
          width: rect.width + "px",
          height: rect.height + "px"
        });
        return;
      }
      dropBox.style.display = "none";
      const row = rowLayout(target.el.parentElement);
      if (row) {
        const end = position2 === "after" !== row.reverse;
        Object.assign(dropLine.style, {
          display: "block",
          left: (end ? rect.x + rect.width - 1 : rect.x - 1) + "px",
          top: rect.y + "px",
          width: "2px",
          height: rect.height + "px"
        });
        return;
      }
      Object.assign(dropLine.style, {
        display: "block",
        left: rect.x + "px",
        top: (position2 === "before" ? rect.y - 1 : rect.y + rect.height - 1) + "px",
        width: rect.width + "px",
        height: "2px"
      });
    }
    function hideDropIndicator() {
      dropLine.style.display = "none";
      dropBox.style.display = "none";
      dropGhost.style.display = "none";
    }
    const MIN_SIZE = 8;
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
        lastSent: 0
      };
      e.preventDefault();
      e.stopPropagation();
      try {
        e.target.setPointerCapture(e.pointerId);
      } catch {
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
      if (east || west) g.el.style.width = width + "px";
      if (north || south) g.el.style.height = height + "px";
      g.pending = {
        width: east || west ? width : null,
        height: north || south ? height : null
      };
      const now = Date.now();
      if (now - g.lastSent < RESIZE_THROTTLE_MS) return;
      flushResize(g, now);
    }
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
        height: next.height
      });
    }
    function endResize() {
      const g = resizing;
      resizing = null;
      if (!g) return;
      flushResize(g, 0);
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
    const DRAG_THRESHOLD = 4;
    function outsideFrame(x, y) {
      return x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight;
    }
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (mode !== "inspect" || !dragEnabled || insertArmed) return;
        if (e.button !== 0 || isEditing(e.target)) return;
        suppressClick = false;
        if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-dedup-ui")) {
          return;
        }
        const el = tagged(e.target);
        const owner = e.shiftKey ? null : dragOwner(el);
        if (owner) {
          drag = {
            el: owner,
            x: e.clientX,
            y: e.clientY,
            active: false,
            target: null,
            pointerId: e.pointerId,
            outside: false
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
          lastHit: 0
        };
      },
      true
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
          const moved = Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y);
          if (moved < DRAG_THRESHOLD) return;
          drag.active = true;
          hoverEl = null;
          liftDragged(drag);
          repaint();
          try {
            document.documentElement.setPointerCapture(drag.pointerId);
          } catch {
          }
          post("drag-start", { id: drag.el.getAttribute("data-dedup-id") });
        }
        e.preventDefault();
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
            label: component ? `${component} \xB7 ${tag}` : tag
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
      true
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
              position: target.position
            });
          }
          return;
        }
        if (marquee) {
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
          post("drop-outside", {
            id: finished.el.getAttribute("data-dedup-id"),
            x: e.clientX,
            y: e.clientY,
            element: payload(finished.el)
          });
          return;
        }
        if (!finished.target) return;
        post("drop", {
          id: finished.el.getAttribute("data-dedup-id"),
          to: finished.target.el.getAttribute("data-dedup-id"),
          position: finished.target.position
        });
      },
      true
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
    document.addEventListener(
      "keydown",
      (e) => {
        if (isEditing(e.target)) {
          if (e.key === "Escape") {
            post("text-input", {
              id: editingEl.getAttribute("data-dedup-id"),
              text: editingOriginal
            });
            endTextEdit();
            e.preventDefault();
          } else if (e.key === "Enter" && !e.shiftKey) {
            endTextEdit();
            e.preventDefault();
          }
          return;
        }
        const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLElement && e.target.isContentEditable;
        if (typing) return;
        const meta = e.metaKey || e.ctrlKey;
        const textSelected = !(window.getSelection()?.isCollapsed ?? true);
        const forwarded = meta && (e.key === "s" || e.key === "z" || !textSelected && (e.key === "c" || e.key === "x" || e.key === "v") || /^[123]$/.test(e.key)) || !meta && (e.key === "Escape" || e.key === "Delete" || e.key === "Backspace" || e.key === "v" || e.key === "h" || e.key === "b" || e.key === "t");
        if (!forwarded) return;
        if (marquee?.active && e.key === "Escape") {
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
      true
    );
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
      true
    );
    document.addEventListener(
      "mouseleave",
      () => {
        hoverEl = null;
        repaint();
      },
      true
    );
    document.addEventListener(
      "click",
      (e) => {
        if (mode === "browse") return;
        if (isEditing(e.target)) return;
        endTextEdit();
        e.preventDefault();
        e.stopImmediatePropagation();
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        if (drag?.active || insertArmed) return;
        const el = tagged(e.target);
        if (el && e.shiftKey && dragEnabled) {
          const id = el.getAttribute("data-dedup-id");
          const current = currentSelection();
          const without = current.filter((c) => c.getAttribute("data-dedup-id") !== id);
          setSelection(
            inDocumentOrder(without.length < current.length ? without : [...current, el])
          );
          reportSelection();
          return;
        }
        if (el) select(el);
        else if (dragEnabled) {
          setSelection([]);
          reportSelection();
        }
      },
      true
    );
    let lastLayersSig = "";
    function buildLayers() {
      const walk = (el, out2) => {
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
              children: []
            };
            walk(child, node.children);
            if (node.children.length === 0) {
              const t = (child.textContent || "").trim().replace(/\s+/g, " ");
              if (t) node.text = t.length > 40 ? t.slice(0, 40) + "\u2026" : t;
            }
            out2.push(node);
          } else {
            walk(child, out2);
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
    let lastReportedHeight = 0;
    let lastMeta = "";
    let heightTimer = null;
    const unpinnedEls = /* @__PURE__ */ new Set();
    function unpin(el) {
      unpinnedEls.add(el);
      el.style.setProperty("height", "auto", "important");
      el.style.setProperty("max-height", "none", "important");
    }
    function unpinPageScrollers() {
      for (const el of unpinnedEls) {
        if (el.isConnected) unpin(el);
        else unpinnedEls.delete(el);
      }
      const body = document.body;
      if (!body) return;
      for (let pass = 0; pass < 3; pass++) {
        let found = false;
        for (const el of [body, ...body.querySelectorAll("*")]) {
          if (el.hasAttribute("data-dedup-ui") || unpinnedEls.has(el)) continue;
          if (el.clientHeight < window.innerHeight * 0.9 || el.clientWidth < window.innerWidth * 0.6 || el.scrollHeight <= el.clientHeight + 8) {
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
        const meta = `${document.title} ${location.pathname}`;
        if (meta !== lastMeta) {
          lastMeta = meta;
          post("page-meta", {
            title: document.title,
            path: location.pathname,
            gesture: Date.now() - lastGesture < 1500
          });
        }
        reportLayers(false);
      }, 200);
    }
    let lastGesture = 0;
    const markGesture = () => {
      lastGesture = Date.now();
    };
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
    document.addEventListener("load", reportHeight, true);
    function scrollableAncestor(el, dx, dy) {
      while (el && el !== document.documentElement && el.nodeType === 1) {
        const cs = getComputedStyle(el);
        if (dy !== 0 && (cs.overflowY === "auto" || cs.overflowY === "scroll") && el.scrollHeight > el.clientHeight && (dy < 0 && el.scrollTop > 0 || dy > 0 && el.scrollTop + el.clientHeight < el.scrollHeight - 1)) {
          return el;
        }
        if (dx !== 0 && (cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth && (dx < 0 && el.scrollLeft > 0 || dx > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 1)) {
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
          y: e.clientY
        });
      },
      { passive: false, capture: true }
    );
    window.addEventListener("scroll", repaint, true);
    window.addEventListener("resize", repaint, true);
    setInterval(() => {
      if (!editingEl && structuralDrifted()) applyStructural();
      applyValues();
      repaint();
    }, 500);
    post("overlay-ready", { held: window.__dedupHeld === true });
  })();
})();
