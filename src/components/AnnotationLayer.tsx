// The markup layer: hand-drawn marks over the page artboards, and the notes
// hung off them.
//
// It is a single layer *above* the iframes rather than something inside them,
// which decides most of its shape. Clicks inside an artboard happen in another
// document and never reach the canvas, so drawing over one means covering it —
// this layer takes pointer events only while the annotate tool is armed, and
// is inert (`pointer-events: none`) the rest of the time so selecting, typing
// and browsing carry on underneath it untouched.
//
// The marks themselves live in canvas space, inside a `<g>` carrying the same
// transform as the artboards, so ink stays stuck to the pixels it was drawn
// over. Their notes do not: a chip is chrome, and chrome is drawn at screen
// size — a note that shrank to nothing at 25% zoom would be a note nobody
// reads at the zoom level where you look at a whole page at once.
import { useEffect, useMemo, useRef, useState } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import {
  appendPoint,
  boundsOf,
  isDrawable,
  makeAnnotation,
  newSeed,
  pathsFor,
  pathsForAnnotation,
  type Annotation,
  type AnnotationKind,
  type Point,
} from "../lib/annotate";

interface Draft {
  kind: AnnotationKind;
  route: string;
  color: string;
  seed: number;
  points: Point[];
}

/** One mark's paths, memoised on the mark. Regenerating on every render would
 *  be wasted work, not a wobble — the seed keeps the geometry identical — but
 *  a canvas re-renders on every pan frame and there is no reason to pay it. */
function Mark({ a }: { a: Annotation }) {
  const paths = useMemo(() => pathsForAnnotation(a), [a]);
  return (
    <g>
      {paths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={a.color}
          strokeWidth={2.2}
          strokeLinecap="round"
          // The one line that keeps a sketch legible across a 0.25–2 zoom
          // range: the ink scales with the page, the nib does not.
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}

/** The note attached to one mark: read-only text most of the time, an input
 *  while it is being written. Local draft state, committed on Enter or blur —
 *  a store write per keystroke would also be a localStorage write per
 *  keystroke. */
function NoteChip({
  a,
  x,
  y,
  editable,
}: {
  a: Annotation;
  x: number;
  y: number;
  editable: boolean;
}) {
  const editing = useStore((s) => s.noteEditing === a.id);
  const setNote = useStore((s) => s.setNote);
  const setNoteEditing = useStore((s) => s.setNoteEditing);
  const removeAnnotation = useStore((s) => s.removeAnnotation);
  const [draft, setDraft] = useState(a.note);
  useEffect(() => {
    if (editing) setDraft(a.note);
  }, [editing, a.note]);

  if (!editable && !a.note) return null;

  const commit = () => {
    setNote(a.id, draft);
    setNoteEditing(null);
  };

  return (
    <div
      className={`absolute flex max-w-[16rem] items-center gap-1 rounded-md border border-line bg-surface-1/95 px-1.5 py-1 text-2xs shadow-lg backdrop-blur ${
        // Outside the annotate tool a chip is a label, and a label that
        // swallowed clicks would put a dead patch over the running app.
        editable ? "pointer-events-auto" : "pointer-events-none"
      }`}
      // Anchored to the mark's top-left and lifted clear of it, so the chip
      // never covers the thing it is about.
      style={{ left: x, top: y, transform: "translateY(-100%)" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: a.color }}
      />
      {editing ? (
        <input
          autoFocus
          value={draft}
          placeholder="What's wrong with it?"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              // Escape here is "stop writing", not "undo the mark" — the
              // shape is already drawn and the user can rub it out with ×.
              e.preventDefault();
              e.stopPropagation();
              setNoteEditing(null);
            }
          }}
          className="w-44 bg-transparent text-ink outline-none placeholder:text-ink-faint"
        />
      ) : (
        <button
          disabled={!editable}
          onClick={() => setNoteEditing(a.id)}
          className={`truncate text-left ${
            a.note ? "text-ink" : "text-ink-faint italic"
          } ${editable ? "hover:text-accent" : "cursor-default"}`}
        >
          {a.note || "Add a note"}
        </button>
      )}
      {editable && (
        <button
          onClick={() => removeAnnotation(a.id)}
          title="Remove this mark"
          className="shrink-0 rounded p-0.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
        >
          <Cross2Icon width={11} height={11} />
        </button>
      )}
    </div>
  );
}

export function AnnotationLayer({
  routes,
  boxes,
}: {
  routes: string[];
  /** Where each open artboard sits on the canvas surface, and its size — the
   *  same layout the canvas draws, so a mark follows its page when it moves. */
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
}) {
  const tool = useStore((s) => s.tool);
  const zoom = useStore((s) => s.zoom);
  const pan = useStore((s) => s.pan);
  const annotations = useStore((s) => s.annotations);
  const annotateKind = useStore((s) => s.annotateKind);
  const annotateColor = useStore((s) => s.annotateColor);
  const addAnnotation = useStore((s) => s.addAnnotation);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const armed = tool === "annotate";

  // A mark belongs to a page, so it is only on screen when that page is.
  const offsets = boxes;
  const visible = annotations.filter((a) => a.route in offsets);

  // Escape cancels the stroke in progress before it cancels anything else —
  // the editor's global handler would drop the tool instead, which is a
  // bigger undo than the user asked for.
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setDraft(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draft]);

  // Leaving the tool mid-stroke leaves nothing behind.
  useEffect(() => {
    if (!armed) setDraft(null);
  }, [armed]);

  /** Client coordinates → the artboard they landed on, plus a point local to
   *  it. Nearest artboard rather than a strict hit test: an arrow drawn from
   *  the margin into a page is a normal thing to draw, and refusing the
   *  gesture because it began four pixels outside the frame would just feel
   *  broken. Nearest in both directions, now that pages can sit anywhere. */
  const locate = (e: React.PointerEvent): { route: string; point: Point } | null => {
    const el = rootRef.current;
    if (!el || routes.length === 0) return null;
    const r = el.getBoundingClientRect();
    const cx = (e.clientX - r.left - pan.x) / zoom;
    const cy = (e.clientY - r.top - pan.y) / zoom;
    let best = routes[0];
    let bestD = Infinity;
    for (const route of routes) {
      const b = offsets[route];
      if (!b) continue;
      // Distance from the point to the box (0 inside it).
      const dx = Math.max(b.x - cx, 0, cx - (b.x + b.width));
      const dy = Math.max(b.y - cy, 0, cy - (b.y + b.height));
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = route;
      }
    }
    const at = offsets[best] ?? { x: 0, y: 0 };
    return { route: best, point: { x: cx - at.x, y: cy - at.y } };
  };

  return (
    <div
      ref={rootRef}
      className={`absolute inset-0 z-20 ${
        armed ? "cursor-crosshair" : "pointer-events-none"
      }`}
      onPointerDown={
        armed
          ? (e) => {
              if (e.button !== 0) return;
              const hit = locate(e);
              if (!hit) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDraft({
                kind: annotateKind,
                route: hit.route,
                color: annotateColor,
                // Fixed now, kept on commit: a shape that re-rolled its
                // randomness when the button came up would visibly change
                // into a different shape at the moment of drawing it.
                seed: newSeed(),
                points: [hit.point, hit.point],
              });
            }
          : undefined
      }
      onPointerMove={
        armed
          ? (e) => {
              if (!draft) return;
              const hit = locate(e);
              if (!hit) return;
              // The stroke stays on the page it started on, so a drag that
              // wanders past the artboard edge does not teleport to its
              // neighbour's coordinates.
              const from = offsets[hit.route] ?? { x: 0, y: 0 };
              const to = offsets[draft.route] ?? { x: 0, y: 0 };
              const local = {
                x: hit.point.x + from.x - to.x,
                y: hit.point.y + from.y - to.y,
              };
              setDraft((d) =>
                !d
                  ? d
                  : d.kind === "pen"
                    ? { ...d, points: appendPoint(d.points, local) }
                    : { ...d, points: [d.points[0], local] },
              );
            }
          : undefined
      }
      onPointerUp={
        armed
          ? () => {
              if (!draft) return;
              if (isDrawable(draft.kind, draft.points)) {
                addAnnotation(
                  makeAnnotation(
                    draft.kind,
                    draft.route,
                    draft.points,
                    draft.color,
                    draft.seed,
                  ),
                );
              }
              setDraft(null);
            }
          : undefined
      }
      onPointerCancel={armed ? () => setDraft(null) : undefined}
    >
      <svg className="h-full w-full overflow-visible">
        <g
          transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}
          // The ink must never eat a click: in annotate mode the root above
          // handles the gesture, and in every other mode this layer is inert.
          pointerEvents="none"
        >
          {visible.map((a) => (
            <g key={a.id} transform={`translate(${offsets[a.route].x} ${offsets[a.route].y})`}>
              <Mark a={a} />
            </g>
          ))}
          {draft && isDrawable(draft.kind, draft.points) && (
            <g transform={`translate(${offsets[draft.route]?.x ?? 0} ${offsets[draft.route]?.y ?? 0})`}>
              {pathsFor(draft.kind, draft.points, draft.seed, draft.color).map(
                (d, i) => (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={draft.color}
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
                ),
              )}
            </g>
          )}
        </g>
      </svg>
      {visible.map((a) => {
        const b = boundsOf(a);
        return (
          <NoteChip
            key={a.id}
            a={a}
            x={pan.x + (offsets[a.route].x + b.x) * zoom}
            y={pan.y + (offsets[a.route].y + b.y) * zoom - 6}
            editable={armed}
          />
        );
      })}
    </div>
  );
}
