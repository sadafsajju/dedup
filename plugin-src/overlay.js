// dedup canvas overlay — injected into the user's app by the tagger plugin.
// Hover highlights tagged elements with a component badge; click selects and
// reports to the dedup editor over postMessage (FR-2.2). Dependency-free.
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
  // Staged (unsaved) class patches by dedupId — reapplied after HMR swaps
  // the DOM out from under us, so live edits survive until save/discard.
  const stagedClasses = new Map();

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

  function mount() {
    document.documentElement.appendChild(hoverBox);
    document.documentElement.appendChild(selectBox);
    document.documentElement.appendChild(badge);
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
    };
  }

  // Inline-style props we set per element, so we can cleanly undo them.
  const touchedProps = new WeakMap();

  function applyStaged() {
    for (const [id, cls] of stagedClasses) {
      const els = document.querySelectorAll(
        `[data-dedup-id="${CSS.escape(id)}"]`,
      );
      for (const el of els) {
        const fresh = !touchedProps.has(el);
        if (el.getAttribute("class") === cls && !fresh) continue;
        el.setAttribute("class", cls);
        previewStyles(el, cls);
      }
    }
  }

  /** Tailwind JIT only generates CSS for classes present in source — a
   * class staged live may have no rule yet. Mirror the classes we can
   * interpret as inline styles so the preview is visible before save;
   * theme values resolve through Tailwind v4's CSS variables. */
  function previewStyles(el, cls) {
    const prev = touchedProps.get(el);
    if (prev) for (const p of prev) el.style.removeProperty(p);
    const props = [];
    for (const token of cls.split(/\s+/)) {
      if (!token || token.includes(":")) continue; // base classes only
      const decls = styleFor(token);
      if (!decls) continue;
      for (const [prop, value] of decls) {
        el.style.setProperty(prop, value);
        props.push(prop);
      }
    }
    touchedProps.set(el, props);
  }

  function clearPreview(el) {
    const prev = touchedProps.get(el);
    if (prev) {
      for (const p of prev) el.style.removeProperty(p);
      touchedProps.delete(el);
    }
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

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.__dedup !== true) return;
    if (m.type === "select-id") {
      const el = document.querySelector(
        `[data-dedup-id="${CSS.escape(m.id)}"]`,
      );
      if (el) select(el);
    } else if (m.type === "clear") {
      selectedEl = null;
      hoverEl = null;
      repaint();
    } else if (m.type === "set-class") {
      // Live patch (FR-3.7): apply to every instance of the source element.
      stagedClasses.set(m.id, m.className);
      applyStaged();
      repaint();
    } else if (m.type === "reset-class") {
      stagedClasses.delete(m.id);
      for (const el of document.querySelectorAll(
        `[data-dedup-id="${CSS.escape(m.id)}"]`,
      )) {
        clearPreview(el);
        if (typeof m.className === "string") {
          el.setAttribute("class", m.className);
        }
      }
      repaint();
    } else if (m.type === "set-mode") {
      mode = m.mode === "browse" ? "browse" : "inspect";
      if (mode === "browse") {
        hoverEl = null;
        selectedEl = null;
        repaint();
      }
    } else if (m.type === "list-files") {
      // Source files behind everything currently rendered (FR-5.1 canvas
      // scope). dedupId is "file:line:col" — strip the two position segments.
      const files = new Set();
      for (const el of document.querySelectorAll("[data-dedup-id]")) {
        const match = el
          .getAttribute("data-dedup-id")
          .match(/^(.*):\d+:\d+$/);
        if (match) files.add(match[1]);
      }
      post("files", { files: [...files] });
    } else if (m.type === "clear-staged") {
      // After save the source equals the staged state; HMR owns it again.
      for (const id of stagedClasses.keys()) {
        for (const el of document.querySelectorAll(
          `[data-dedup-id="${CSS.escape(id)}"]`,
        )) {
          clearPreview(el);
        }
      }
      stagedClasses.clear();
    }
  });

  function select(el) {
    selectedEl = el;
    repaint();
    post("selected", { payload: payload(el) });
  }

  // --- events ---------------------------------------------------------------

  document.addEventListener(
    "mousemove",
    (e) => {
      if (mode === "browse") return;
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
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = tagged(e.target);
      if (el) select(el);
    },
    true,
  );

  // --- full-page height reporting -------------------------------------------
  // The editor sizes the canvas frame to the page's natural height. Reports
  // are mutation-driven (not resize-driven) so vh-based layouts can't enter a
  // grow → re-measure → grow feedback loop: resizing the frame mutates
  // nothing, so no re-report happens.
  let lastReportedHeight = 0;
  let lastMeta = "";
  let heightTimer = null;
  function reportHeight() {
    if (heightTimer) return;
    heightTimer = setTimeout(() => {
      heightTimer = null;
      const h = Math.ceil(document.documentElement.scrollHeight);
      if (Math.abs(h - lastReportedHeight) > 8) {
        lastReportedHeight = h;
        post("page-size", { height: h });
      }
      // Frame label (Figma artboard name): the page's own title + route.
      const meta = `${document.title} ${location.pathname}`;
      if (meta !== lastMeta) {
        lastMeta = meta;
        post("page-meta", { title: document.title, path: location.pathname });
      }
    }, 200);
  }
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
    applyStaged();
    repaint();
  }, 500);

  post("overlay-ready", {});
})();
