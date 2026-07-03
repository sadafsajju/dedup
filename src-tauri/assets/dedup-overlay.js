// dedup canvas overlay — injected into the user's app by the tagger plugin.
// Hover highlights tagged elements with a component badge; click selects and
// reports to the dedup editor over postMessage (FR-2.2). Dependency-free.
(() => {
  "use strict";
  if (window.__dedupOverlay) return;
  window.__dedupOverlay = true;

  const ACCENT = "#4c7fff";
  const Z = 2147483646;

  let hoverEl = null;
  let selectedEl = null;
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

  function applyStaged() {
    for (const [id, cls] of stagedClasses) {
      const els = document.querySelectorAll(
        `[data-dedup-id="${CSS.escape(id)}"]`,
      );
      for (const el of els) {
        if (el.getAttribute("class") !== cls) el.setAttribute("class", cls);
      }
    }
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
      if (typeof m.className === "string") {
        for (const el of document.querySelectorAll(
          `[data-dedup-id="${CSS.escape(m.id)}"]`,
        )) {
          el.setAttribute("class", m.className);
        }
      }
      repaint();
    } else if (m.type === "clear-staged") {
      // After save the source equals the staged state; HMR owns it again.
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
  // semantics; links/buttons in the user's app don't fire).
  document.addEventListener(
    "click",
    (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = tagged(e.target);
      if (el) select(el);
    },
    true,
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
