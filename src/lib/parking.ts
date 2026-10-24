// Parked pieces: elements dragged off every artboard onto the empty canvas.
//
// In Figma a layer outside a frame still exists in the file. A codebase has no
// "outside" — every element lives in a file, and only pages render — so a
// piece dropped on the canvas *leaves its page* (a staged removal, saved like
// any other) and dedup keeps it: the source a paste would write, the markup a
// paste previews with, and a picture for its card. Drag the card into any
// artboard and it is pasted there, by the same rules as ⌘V.
//
// The lifecycle rides the staged program rather than a parallel one, so undo,
// redo, discard and save all mean what they already mean:
//
//   dragged out  → `removal` = the element whose staged removal took it off
//                  its page. Undo that removal and the piece is gone — it is
//                  back in the page, so there is nothing left to park.
//   saved        → `removal` cleared: the page no longer has it, and this is
//                  the only copy. From here on it is stored to disk.
//   dropped in   → `placement` = the pending insert that puts it into a page;
//                  the card hides. Undo the insert and the card comes back.
//   saved again  → placed for real; the piece is done and removed.
//
// Pure, so every one of those transitions is pinned by `pnpm test:parking`.

import type { Clipboard, EditAction } from "./types";

export interface ParkedPiece {
  id: string;
  /** Position on the canvas surface — the same units artboards are laid out
   *  in, so a card pans and zooms with the pages around it. */
  x: number;
  y: number;
  /** The element's own size on the page it came from, in CSS px. */
  width: number;
  height: number;
  /** What a paste writes and previews — a cut's clipboard, minus the flag. */
  clip: Omit<Clipboard, "cut">;
  /** A PNG `data:` URL of the element as it looked, or null if the capture
   *  failed (the card then shows its label alone). */
  picture: string | null;
  /** The artboard it was dragged off, for the card's caption. */
  fromRoute: string;
  /** While unsaved: the dedup id whose staged removal took it off its page. */
  removal: string | null;
  /** While placed but unsaved: the pending insert putting it into a page. */
  placement: string | null;
  createdAt: number;
}

/**
 * Bring the parked pieces in line with the staged program. Returns the same
 * array when nothing changed, so a caller can tell by identity.
 */
export function reconcileParked(parked: ParkedPiece[], actions: EditAction[]): ParkedPiece[] {
  const removed = new Set(
    actions.filter((a) => a.kind === "remove").map((a) => a.target.dedupId),
  );
  const inserted = new Set(
    actions.flatMap((a) => (a.kind === "insert" ? [a.id] : [])),
  );
  let changed = false;
  const next: ParkedPiece[] = [];
  for (const p of parked) {
    if (p.removal !== null && !removed.has(p.removal)) {
      changed = true; // its removal was undone: back in the page
      continue;
    }
    if (p.placement !== null && !inserted.has(p.placement)) {
      changed = true; // its placement was undone: back on the canvas
      next.push({ ...p, placement: null });
      continue;
    }
    next.push(p);
  }
  return changed ? next : parked;
}

/**
 * What a successful save does to the pieces. Applied in the *same* state
 * update that empties the staged program — applied after it, `reconcile`
 * would see every removal gone and throw the pieces away.
 */
export function settleParked(parked: ParkedPiece[]): ParkedPiece[] {
  return parked
    .filter((p) => p.placement === null) // placed for real: done
    .map((p) => (p.removal === null ? p : { ...p, removal: null }));
}

/** The cards to draw: everything not currently placed into a page. */
export function visibleParked(parked: ParkedPiece[]): ParkedPiece[] {
  return parked.filter((p) => p.placement === null);
}

/**
 * What goes to disk. Only pieces whose removal has been *saved* — an unsaved
 * one still exists in its page, and the staged removal it hangs on does not
 * survive a restart. A pending placement doesn't either, so it is stored as
 * still parked.
 */
export function persistable(parked: ParkedPiece[]): ParkedPiece[] {
  return parked
    .filter((p) => p.removal === null)
    .map((p) => (p.placement === null ? p : { ...p, placement: null }));
}

/** Pieces read back from disk, or nothing. Anything malformed is dropped
 *  rather than drawn: a card that cannot be pasted is worse than none. */
export function sanitizeParked(raw: unknown): ParkedPiece[] {
  if (!Array.isArray(raw)) return [];
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const str = (v: unknown) => typeof v === "string";
  const out: ParkedPiece[] = [];
  for (const p of raw as Record<string, unknown>[]) {
    const c = (p?.clip ?? null) as Record<string, unknown> | null;
    if (
      !p ||
      !str(p.id) ||
      !num(p.x) ||
      !num(p.y) ||
      !num(p.width) ||
      !num(p.height) ||
      !c ||
      !str(c.snippet) ||
      (c.lang !== "jsx" && c.lang !== "html") ||
      !str(c.preview) ||
      !str(c.label) ||
      !str(c.file) ||
      !Array.isArray(c.refs)
    ) {
      continue;
    }
    out.push({
      id: p.id as string,
      x: p.x as number,
      y: p.y as number,
      width: Math.max(1, p.width as number),
      height: Math.max(1, p.height as number),
      clip: {
        snippet: c.snippet as string,
        lang: c.lang,
        preview: c.preview as string,
        label: c.label as string,
        file: c.file as string,
        refs: (c.refs as unknown[]).filter((r): r is string => typeof r === "string"),
      },
      picture: typeof p.picture === "string" && p.picture.startsWith("data:image/") ? p.picture : null,
      fromRoute: str(p.fromRoute) ? (p.fromRoute as string) : "/",
      // From disk, a piece is always settled: nothing staged survives a restart.
      removal: null,
      placement: null,
      createdAt: num(p.createdAt) ? (p.createdAt as number) : 0,
    });
  }
  return out;
}

// --- geometry --------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A point in a frame's own CSS px, on screen. `frame` is the iframe's
 *  on-screen box and `frameWidth` its CSS width — their ratio is the canvas
 *  zoom, measured rather than assumed. */
export function frameToScreen(frame: Box, frameWidth: number, p: Point): Point {
  const scale = frameWidth > 0 ? frame.width / frameWidth : 1;
  return { x: frame.left + p.x * scale, y: frame.top + p.y * scale };
}

/** The inverse: where a screen point falls in a frame's own CSS px. */
export function screenToFrame(frame: Box, frameWidth: number, p: Point): Point {
  const scale = frameWidth > 0 ? frame.width / frameWidth : 1;
  return { x: (p.x - frame.left) / scale, y: (p.y - frame.top) / scale };
}

/** A screen point on the canvas surface, given where the canvas container is
 *  and how it is panned and zoomed. */
export function screenToSurface(container: Point, pan: Point, zoom: number, p: Point): Point {
  const z = zoom > 0 ? zoom : 1;
  return { x: (p.x - container.x - pan.x) / z, y: (p.y - container.y - pan.y) / z };
}

/** Which artboard a screen point is over, if any. Later boards win a tie —
 *  they are drawn on top. */
export function artboardAt(p: Point, boards: { route: string; box: Box }[]): string | null {
  let hit: string | null = null;
  for (const { route, box } of boards) {
    if (p.x >= box.left && p.x < box.left + box.width && p.y >= box.top && p.y < box.top + box.height) {
      hit = route;
    }
  }
  return hit;
}
