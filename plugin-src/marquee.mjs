// Which elements a marquee selects — the one rule, pure so it can be tested
// without a browser (`pnpm test:marquee`). The overlay imports it and is
// bundled around it; nothing else decides this.
//
// Figma's containment rule, restated for a document: the marquee selects the
// *outermost* elements it touches, and looks through any element that
// encloses it. A page is nested boxes all the way down, so "everything the
// rectangle intersects" would select a section, its wrapper, its heading and
// the text inside it for one drag over a heading.

/** A rect from two corners, in whichever order the pointer drew them. */
export function marqueeRect(x0, y0, x1, y1) {
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

/** Do two rects share any area? Touching edges do not count, and neither
 *  does anything with no area of its own — an element that renders nothing
 *  cannot be pointed at, so it cannot be dragged across either. */
function overlaps(a, b) {
  if (a.width <= 0 || a.height <= 0) return false;
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

/** Does `outer` hold all of `inner`? */
function encloses(outer, inner) {
  return (
    outer.x <= inner.x &&
    outer.y <= inner.y &&
    outer.x + outer.width >= inner.x + inner.width &&
    outer.y + outer.height >= inner.y + inner.height
  );
}

/**
 * The indices of the nodes a marquee selects.
 *
 * `nodes` is the tagged tree flattened in document order; each names its
 * nearest tagged ancestor by index (`parent`, -1 at the top) and carries its
 * on-screen rect. Walking down from the top, each node is one of three things:
 *
 *  - not under the marquee: skipped, but its children are still looked at —
 *    a child can overflow its parent, and a `display: contents` wrapper has
 *    no box at all while everything inside it does;
 *  - a container enclosing the marquee: looked through. This is the rule
 *    that keeps a drag *inside* a section from selecting the section: the
 *    container the drag started in is never selected merely for being
 *    around it. Only a container, though — an element with nothing tagged
 *    inside it has nothing to look through *to*, so a small drag within a
 *    paragraph selects the paragraph;
 *  - touched by it: selected, and its descendants are not — the outermost
 *    element wins.
 */
export function marqueeHits(nodes, rect) {
  const children = new Map();
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
