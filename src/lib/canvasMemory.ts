// What dedup remembers about the canvas, so reopening a project lands on the
// artboards the user was working on instead of an empty grid.
//
// The rule the pages row is built on is that nothing mounts until the user
// asks for it: each artboard runs their real app — their real dev server,
// auth guards and data fetching — so dedup never opens one on a hunch.
// Remembering does not weaken that rule, it honours it across restarts: the
// user did ask, last time, and this is dedup keeping the answer rather than
// making one up. Asking again every morning is the same guess from the other
// side.
//
// Only choices are stored. `frameOrigins` is deliberately absent: it is the
// automatic guest-origin fallback's verdict about a dev-server run that is
// over, so the next run starts every frame on the shared session and lets
// the fallback decide again with fresh evidence.

import type { SessionMode } from "./origins";

const STORAGE = (root: string) => `dedup:canvas:${root}`;

/** How many page artboards may be mounted at once. The store caps the row at
 * this while opening pages; a remembered row is capped by the same number
 * rather than by a second opinion about it. */
export const MAX_ARTBOARDS = 40;

export interface SavedCanvas {
  /** Open page artboards, in canvas order. */
  routes: string[];
  /** The scan's target, if one was picked — always one of `routes`. */
  selectedRoute: string | null;
  sessionModes: Record<string, SessionMode>;
  heldRoutes: string[];
  offlineRoutes: string[];
  /** Where the user put each artboard, per viewport (artboards are sized by
   *  the viewport, so a layout made for 390px boards would overlap at 1440).
   *  Surface coordinates, the units the canvas lays pages out in. Absent for
   *  a viewport nobody has rearranged: the row then applies. */
  positions?: Record<string, Record<string, { x: number; y: number }>>;
}

/**
 * Where every open artboard goes. Stored positions win; an artboard without
 * one goes to the right of the rightmost so far — which, with nothing stored,
 * is exactly the old row (0, step, 2·step, …). Pure, so the canvas, the
 * markup layer and "focus this page" all lay out the same way.
 */
export function layoutArtboards(
  routes: string[],
  stored: Record<string, { x: number; y: number }> | undefined,
  width: number,
  gap: number,
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  let right = -gap; // the right edge so far, minus the gap the next one needs
  for (const route of routes) {
    const p = stored?.[route];
    if (p) {
      out[route] = { x: p.x, y: p.y };
      right = Math.max(right, p.x + width);
    }
  }
  for (const route of routes) {
    if (out[route]) continue;
    out[route] = { x: right + gap, y: 0 };
    right += gap + width;
  }
  return out;
}

/**
 * A route is a path on the user's own dev server and nothing else — no
 * origin, no scheme, and no protocol-relative `//host`, which a URL join
 * would read as one. Every route here is replayed into an iframe's src.
 */
function isRoutePath(r: unknown): r is string {
  return typeof r === "string" && r.startsWith("/") && !r.startsWith("//");
}

/**
 * The canvas to restore for this project, or null for "start empty".
 *
 * Everything is re-validated rather than trusted. It is dedup's own blob, but
 * it is also the only state that survives to point frames at URLs, and a
 * route that is not a path, or a session mode keyed to an artboard that was
 * never restored, is a stale choice waiting to surprise whoever opens that
 * page next.
 */
export function loadCanvas(root: string): SavedCanvas | null {
  try {
    const raw = localStorage.getItem(STORAGE(root));
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<SavedCanvas>;
    const routes = Array.isArray(saved.routes)
      ? [...new Set(saved.routes.filter(isRoutePath))].slice(0, MAX_ARTBOARDS)
      : [];
    // An empty row is "nothing to restore", which is exactly what a fresh
    // project does anyway — so it is spelled the same way.
    if (!routes.length) return null;

    const open = (r: string) => routes.includes(r);
    const flags = (v: unknown) =>
      Array.isArray(v)
        ? [...new Set(v.filter((r): r is string => typeof r === "string" && open(r)))]
        : [];

    const sessionModes: Record<string, SessionMode> = {};
    for (const [route, mode] of Object.entries(saved.sessionModes ?? {})) {
      if (open(route) && (mode === "auto" || mode === "in" || mode === "out")) {
        sessionModes[route] = mode;
      }
    }

    // Positions: finite numbers, for open artboards, per viewport id.
    const positions: Record<string, Record<string, { x: number; y: number }>> = {};
    for (const [viewport, byRoute] of Object.entries(saved.positions ?? {})) {
      if (!byRoute || typeof byRoute !== "object") continue;
      const kept: Record<string, { x: number; y: number }> = {};
      for (const [route, p] of Object.entries(byRoute)) {
        const pt = p as { x?: unknown; y?: unknown } | null;
        if (
          open(route) &&
          typeof pt?.x === "number" &&
          typeof pt?.y === "number" &&
          Number.isFinite(pt.x) &&
          Number.isFinite(pt.y)
        ) {
          kept[route] = { x: pt.x, y: pt.y };
        }
      }
      if (Object.keys(kept).length > 0) positions[viewport] = kept;
    }

    return {
      positions,
      routes,
      selectedRoute:
        typeof saved.selectedRoute === "string" && open(saved.selectedRoute)
          ? saved.selectedRoute
          : null,
      sessionModes,
      heldRoutes: flags(saved.heldRoutes),
      offlineRoutes: flags(saved.offlineRoutes),
    };
  } catch {
    // A corrupt entry costs one empty canvas, never a project that won't open.
    return null;
  }
}

export function saveCanvas(root: string, canvas: SavedCanvas) {
  try {
    localStorage.setItem(STORAGE(root), JSON.stringify(canvas));
  } catch {
    // Persistence is best-effort; the session still works without it, and
    // forgetting shows the empty canvas — the safe direction to fail in.
  }
}

export function forgetCanvas(root: string) {
  try {
    localStorage.removeItem(STORAGE(root));
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}
