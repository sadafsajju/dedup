// Canvas markup — the hand-drawn layer the user draws over their running app.
//
// dedup's whole argument is that some findings only exist in pixels. The reply
// to a finding you can only see is a mark you make on top of it: circle the
// thing, write what is wrong with it. rough.js is here for that last part — a
// machine-perfect rectangle drawn over a machine-perfect UI reads as part of
// the UI, and a wobbly one reads as somebody's pen. That distinction is the
// whole job of this layer, so it is worth a dependency.
//
// Two rules make it behave on a canvas that pans and zooms, and both are the
// kind of thing that only shows up once it is on screen:
//
//  1. **Every mark carries its own seed.** rough re-randomises on every call,
//     so a shape regenerated on a pan, a zoom or any React re-render would
//     jitter in place — the ink would visibly crawl. With the seed stored,
//     geometry is a pure function of the annotation and can be generated once
//     and memoised.
//  2. **Geometry is generated once, at artboard scale**, and the stroke is
//     held to a constant *screen* width by `vector-effect: non-scaling-stroke`
//     at render time. Regenerating per zoom step would be slower and worse:
//     the wobble would breathe while you pinch. Note this is the opposite of
//     the rule overlay chrome follows (drawn in screen pixels because it *is*
//     chrome) — a mark belongs to the page it was drawn on, so it scales with
//     it and only the nib stays put.
//
// Coordinates are **artboard-local**, and a mark belongs to a route rather
// than to a spot on the canvas. Pages get closed, reopened and reordered; the
// note the user wrote on /pricing has to still be on /pricing when it returns.

import rough from "roughjs";
import type { Options } from "roughjs/bin/core";

export type AnnotationKind = "box" | "ellipse" | "arrow" | "pen";

export interface Point {
  x: number;
  y: number;
}

export interface Annotation {
  id: string;
  /** The artboard this mark lives on. */
  route: string;
  kind: AnnotationKind;
  /** Artboard-local. Start and end for box/ellipse/arrow; the whole stroke
   *  for pen. */
  points: Point[];
  color: string;
  /** rough.js randomness seed — see the header; without it the ink crawls. */
  seed: number;
  /** What the user wrote about it. Empty means the mark is a pointer only. */
  note: string;
}

/** Ink colours. Deliberately literal rather than theme variables: these are
 *  drawn over the *user's* app, not over dedup's chrome, so they answer to
 *  that page's contrast rather than to dedup's light/dark. */
export const PENS = ["#e5484d", "#f5a524", "#30a46c", "#3e63dd"] as const;

export const KIND_LABEL: Record<AnnotationKind, string> = {
  box: "Box",
  ellipse: "Circle",
  arrow: "Arrow",
  pen: "Pen",
};

/** How the prompt describes each kind when a note travels to the chat agent. */
const KIND_VERB: Record<AnnotationKind, string> = {
  box: "boxed",
  ellipse: "circled",
  arrow: "drew an arrow at",
  pen: "scribbled over",
};

/** Below this a drag is a click that wobbled, not a shape. */
const MIN_DRAG = 6;
/** Freehand sampling: closer points than this add nothing but work. */
export const MIN_POINT_GAP = 3;
/** A stroke long enough to hit this is a doodle, and rough gets slow. */
export const MAX_PEN_POINTS = 400;
/** Notes are a sentence, not a document — they ride in an AI prompt. */
export const MAX_NOTE = 400;

const generator = rough.generator();

/** A fresh randomness seed for one mark. rough's own `newSeed` is a static on
 *  a class this module never names, and the value is just an int32 — spelled
 *  out here rather than reaching through a deep import for it. */
export const newSeed = (): number => Math.floor(Math.random() * 2 ** 31);

let counter = 0;
export function newAnnotationId(): string {
  counter += 1;
  return `mark-${Date.now().toString(36)}-${counter}`;
}

/** The seed is a parameter because a mark is drawn before it is committed:
 *  the in-flight shape and the stored one must be the same shape, and a fresh
 *  seed on commit would make it change under the cursor as the button lifts. */
export function makeAnnotation(
  kind: AnnotationKind,
  route: string,
  points: Point[],
  color: string,
  seed: number = newSeed(),
): Annotation {
  return { id: newAnnotationId(), route, kind, points, color, seed, note: "" };
}

/** The rectangle two drag points describe, whichever way they were dragged. */
export function rectOf(points: Point[]): { x: number; y: number; w: number; h: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The mark's own box, for hanging its note chip off. */
export function boundsOf(a: Annotation): { x: number; y: number; w: number; h: number } {
  return rectOf(a.points);
}

/**
 * Whether this is a mark at all. A press with no drag leaves a dot nobody
 * meant to draw and nothing can select, so the gesture is dropped instead —
 * the same reasoning behind the canvas treating a moved click as a pan.
 */
export function isDrawable(kind: AnnotationKind, points: Point[]): boolean {
  if (points.length < 2) return false;
  if (kind === "pen") return points.length >= 2;
  const r = rectOf(points);
  return Math.hypot(r.w, r.h) >= MIN_DRAG;
}

/**
 * Add a point to a freehand stroke, or return the stroke unchanged when the
 * point is too close to the last one or the cap is reached. Returning the same
 * reference is what lets the drawing component skip a re-render per mouse
 * move.
 */
export function appendPoint(points: Point[], p: Point): Point[] {
  if (points.length >= MAX_PEN_POINTS) return points;
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_GAP) return points;
  return [...points, p];
}

/** The two barbs of an arrow head, as segments from the tip. */
export function arrowHead(from: Point, to: Point): [Point, Point][] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (len < 1) return [];
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  // Scaled to the shaft so a short arrow does not end in a head bigger than
  // itself, clamped so a long one does not grow a banner.
  const size = Math.min(24, Math.max(9, len * 0.28));
  const spread = 0.42;
  return [angle + Math.PI - spread, angle + Math.PI + spread].map(
    (t) =>
      [to, { x: to.x + Math.cos(t) * size, y: to.y + Math.sin(t) * size }] as [
        Point,
        Point,
      ],
  );
}

function optionsFor(kind: AnnotationKind, seed: number, color: string): Options {
  return {
    seed,
    stroke: color,
    // Rendered with a non-scaling stroke, so this is screen pixels at any zoom.
    strokeWidth: 2.2,
    // A freehand line is already the user's own wobble; roughening it again
    // reads as a smear rather than as ink, and the second pass doubles it.
    roughness: kind === "pen" ? 0.5 : 1.15,
    bowing: kind === "pen" ? 0.6 : 1.4,
    disableMultiStroke: kind === "pen",
    fill: undefined,
  };
}

/**
 * The SVG path data for one mark. Pure in the annotation: same mark, same
 * paths, every time — which is the point of storing the seed.
 */
export function pathsFor(
  kind: AnnotationKind,
  points: Point[],
  seed: number,
  color: string,
): string[] {
  if (points.length < 2) return [];
  const opts = optionsFor(kind, seed, color);
  const drawables = [];
  if (kind === "box") {
    const r = rectOf(points);
    drawables.push(generator.rectangle(r.x, r.y, r.w, r.h, opts));
  } else if (kind === "ellipse") {
    const r = rectOf(points);
    drawables.push(generator.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h, opts));
  } else if (kind === "arrow") {
    const from = points[0];
    const to = points[points.length - 1];
    drawables.push(generator.line(from.x, from.y, to.x, to.y, opts));
    for (const [a, b] of arrowHead(from, to)) {
      drawables.push(generator.line(a.x, a.y, b.x, b.y, opts));
    }
  } else {
    const pts = points.map((p) => [p.x, p.y] as [number, number]);
    // `curve` through two points is a degenerate spline; a straight segment is
    // what the user drew anyway.
    drawables.push(
      pts.length > 2 ? generator.curve(pts, opts) : generator.linearPath(pts, opts),
    );
  }
  return drawables.flatMap((d) => generator.toPaths(d).map((p) => p.d));
}

/** Convenience over `pathsFor` for a stored mark. */
export const pathsForAnnotation = (a: Annotation): string[] =>
  pathsFor(a.kind, a.points, a.seed, a.color);

/**
 * The marks that have something to say, as prompt lines.
 *
 * A shape with no note is a pointer, and a pointer with no words is not
 * context — sending "the user drew a box somewhere" would be noise the model
 * has to guess at. dedup does not resolve which element is under a mark
 * (that answer lives inside the frame, and the overlay is not asked for it),
 * so the honest thing to send is the words plus the page they were written on.
 */
export function annotationNotes(
  list: Annotation[],
  routes?: string[] | null,
  limit = 12,
): string[] {
  return list
    .filter((a) => a.note.trim() && (!routes || routes.includes(a.route)))
    .slice(0, limit)
    .map((a) => `On ${a.route}, the user ${KIND_VERB[a.kind]} something and wrote: "${a.note.trim()}"`);
}

// --- persistence -------------------------------------------------------------

const STORAGE = (root: string) => `dedup:marks:${root}`;
/** localStorage is not a vault, and a canvas past this is not being read. */
export const MAX_ANNOTATIONS = 300;

const isPoint = (p: unknown): p is Point =>
  !!p &&
  typeof p === "object" &&
  Number.isFinite((p as Point).x) &&
  Number.isFinite((p as Point).y);

/** Same rule as the remembered canvas: a route is a path on the user's dev
 *  server and nothing else. */
const isRoutePath = (r: unknown): r is string =>
  typeof r === "string" && r.startsWith("/") && !r.startsWith("//");

function validate(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Partial<Annotation>;
  if (typeof a.id !== "string" || !a.id) return null;
  if (!isRoutePath(a.route)) return null;
  if (a.kind !== "box" && a.kind !== "ellipse" && a.kind !== "arrow" && a.kind !== "pen") {
    return null;
  }
  if (!Array.isArray(a.points) || a.points.length < 2) return null;
  const points = a.points.filter(isPoint).slice(0, MAX_PEN_POINTS);
  if (points.length < 2) return null;
  // The colour is written straight into a `stroke` attribute, so it is held to
  // the shape dedup writes rather than to whatever a hand-edited blob says.
  const color = typeof a.color === "string" && /^#[0-9a-f]{6}$/i.test(a.color)
    ? a.color
    : PENS[0];
  return {
    id: a.id,
    route: a.route,
    kind: a.kind,
    points,
    color,
    seed: Number.isFinite(a.seed) ? (a.seed as number) : newSeed(),
    note: typeof a.note === "string" ? a.note.slice(0, MAX_NOTE) : "",
  };
}

/**
 * The marks to restore for this project. Everything is re-validated rather
 * than trusted — it is dedup's own blob, but it is also the only state here
 * that survives a restart, and a mark with a NaN in it is a path attribute
 * that silently draws nothing.
 */
export function loadAnnotations(root: string): Annotation[] {
  try {
    const raw = localStorage.getItem(STORAGE(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Annotation[] = [];
    for (const item of parsed) {
      const a = validate(item);
      if (a) out.push(a);
      if (out.length >= MAX_ANNOTATIONS) break;
    }
    return out;
  } catch {
    // A corrupt entry costs the marks, never a project that won't open.
    return [];
  }
}

export function saveAnnotations(root: string, list: Annotation[]) {
  try {
    localStorage.setItem(
      STORAGE(root),
      JSON.stringify(list.slice(0, MAX_ANNOTATIONS)),
    );
  } catch {
    // Best-effort, like the rest of what dedup remembers about a canvas.
  }
}
