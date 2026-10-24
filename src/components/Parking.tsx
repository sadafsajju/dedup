// Dragging elements off their artboard: onto the empty canvas (parked) or
// into another artboard (moved), and parked pieces back into a page.
//
// A drag that starts in a page is heard only by that page's overlay — it
// captures the pointer, so it keeps reporting past its own edge
// (`drag-outside`, `drop-outside`). Everything beyond the frame is decided
// here, in the editor, because only the editor knows where the frames are.
// Over another artboard, the editor *probes* it: that page's overlay is told
// the point in its own coordinates, draws the slot an in-page drag would land
// in, and answers with it. The same probe serves a parked card being dragged
// in, which is the editor's own pointer to begin with.
//
// What a park or a move *means* in source lives in lib/parking and the store;
// this is geometry and gestures.
import { useEffect, useRef, useState } from "react";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useStore } from "../lib/store";
import { frameBox, routeOfWindow, sendToFrame } from "../lib/bridge";
import {
  artboardAt,
  frameToScreen,
  screenToFrame,
  screenToSurface,
  visibleParked,
  type Box,
  type ParkedPiece,
  type Point,
} from "../lib/parking";
import { VIEWPORTS } from "../lib/types";
import type { DropPosition, SelectedElement } from "../lib/types";

const toBox = (r: DOMRect): Box => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** The artboards on screen right now. Read from the DOM at the moment of the
 *  gesture, never cached: the canvas pans and zooms under a drag. */
function boardsOnScreen(): { route: string; box: Box }[] {
  return [...document.querySelectorAll<HTMLElement>("[data-artboard]")].map((el) => ({
    route: el.dataset.artboard as string,
    box: toBox(el.getBoundingClientRect()),
  }));
}

function viewportWidth(): number {
  const id = useStore.getState().viewportId;
  return (VIEWPORTS.find((v) => v.id === id) ?? VIEWPORTS[0]).width;
}

// --- the probe: "where would this land in that page?" -----------------------
// One drag at a time, so one probe at a time — module state, like the
// overlay's own drag state.
let probeRoute: string | null = null;
let probeSeq = 0;
let probeAnswer: { seq: number; id: string; position: DropPosition } | null = null;

/** Point the probe at whatever artboard `screen` is over (other than
 *  `exclude`, the page the drag came from). Returns that artboard's route. */
function probeAt(screen: Point, exclude: string | null): string | null {
  const over = artboardAt(
    screen,
    boardsOnScreen().filter((b) => b.route !== exclude),
  );
  if (over !== probeRoute) {
    if (probeRoute) sendToFrame(probeRoute, { type: "probe-clear" });
    probeRoute = over;
    probeAnswer = null;
  }
  if (over) {
    const box = frameBox(over);
    if (box) {
      const local = screenToFrame(toBox(box), viewportWidth(), screen);
      sendToFrame(over, { type: "probe-drop", x: local.x, y: local.y, seq: ++probeSeq });
    }
  }
  return over;
}

/** Finish probing: the slot last answered for the artboard still under the
 *  pointer, if any, with the drawn slot taken down. */
function endProbe(): { route: string; id: string; position: DropPosition } | null {
  const answer =
    probeRoute && probeAnswer ? { route: probeRoute, id: probeAnswer.id, position: probeAnswer.position } : null;
  if (probeRoute) sendToFrame(probeRoute, { type: "probe-clear" });
  probeRoute = null;
  probeAnswer = null;
  return answer;
}

/** The surface point under a screen point, given the canvas container. */
function surfaceAt(container: HTMLElement | null, screen: Point): Point {
  const r = container?.getBoundingClientRect();
  const { pan, zoom } = useStore.getState();
  return screenToSurface({ x: r?.left ?? 0, y: r?.top ?? 0 }, pan, zoom, screen);
}

/**
 * Overlay → editor for drags that leave their page. Mounted once, by the
 * canvas. `containerRef` is the canvas root, for surface coordinates.
 */
export function useDragOffArtboard(containerRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const m = e.data;
      if (!m || m.__dedup !== true) return;

      if (m.type === "probe-result") {
        // Only an answer from the page being probed, and never an older one
        // than the newest already in hand — postMessage keeps order per frame,
        // but a route change can strand a reply in flight.
        if (routeOfWindow(e.source) !== probeRoute) return;
        if (probeAnswer && (m.seq as number) < probeAnswer.seq) return;
        probeAnswer = m.id
          ? { seq: m.seq as number, id: m.id as string, position: m.position as DropPosition }
          : null;
        return;
      }

      if (m.type !== "drag-outside" && m.type !== "drop-outside") return;
      const route = routeOfWindow(e.source);
      const s = useStore.getState();
      if (!route) return;

      if (m.type === "drag-outside") {
        if (m.x === null || m.x === undefined) {
          // Back over its own page: the page draws its own slot again.
          endProbe();
          s.setDragOut(null);
          return;
        }
        const box = frameBox(route);
        if (!box) return;
        const screen = frameToScreen(toBox(box), viewportWidth(), { x: m.x as number, y: m.y as number });
        const over = probeAt(screen, route);
        s.setDragOut({
          route,
          id: m.id as string,
          label: (m.label as string) ?? "element",
          screen,
          over,
        });
        return;
      }

      // drop-outside
      const box = frameBox(route);
      s.setDragOut(null);
      if (!box) {
        endProbe();
        return;
      }
      const width = viewportWidth();
      const screen = frameToScreen(toBox(box), width, { x: m.x as number, y: m.y as number });
      const over = artboardAt(
        screen,
        boardsOnScreen().filter((b) => b.route !== route),
      );
      const answer = endProbe();
      const element = m.element as SelectedElement;
      if (over) {
        if (answer && answer.route === over) {
          void s.moveAcross({ id: m.id as string, element, drop: { id: answer.id, position: answer.position } });
        } else {
          s.setNotice("Nothing to drop onto there — aim at an element in that page.");
        }
        return;
      }
      // Empty canvas: park it, centred on the pointer.
      const at = surfaceAt(containerRef.current, screen);
      const topLeft = frameToScreen(toBox(box), width, { x: element.rect.x, y: element.rect.y });
      const scale = box.width / width;
      void s.parkElement({
        id: m.id as string,
        route,
        element,
        at: { x: at.x - element.rect.width / 2, y: at.y - element.rect.height / 2 },
        // Where it is on screen now, clipped to the window — the snapshot
        // API rasterises the window, not the page.
        rect: clipToWindow({
          x: topLeft.x,
          y: topLeft.y,
          width: element.rect.width * scale,
          height: element.rect.height * scale,
        }),
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [containerRef]);
}

function clipToWindow(r: { x: number; y: number; width: number; height: number }) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const width = Math.min(r.x + r.width, window.innerWidth) - x;
  const height = Math.min(r.y + r.height, window.innerHeight) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

/** What is being dragged off its page, following the pointer, and what a
 *  release here would do. Screen-positioned chrome, like the overlay's. */
export function DragOutGhost() {
  const drag = useStore((s) => s.dragOut);
  if (!drag) return null;
  return (
    <div
      className="panel pointer-events-none fixed z-50 rounded-md px-2 py-1 text-2xs"
      style={{ left: drag.screen.x + 14, top: drag.screen.y + 14 }}
    >
      <span className="font-medium text-ink">{drag.label}</span>
      <span className="text-ink-faint">
        {drag.over ? ` → into ${drag.over === "/" ? "Home" : drag.over}` : " → park on the canvas"}
      </span>
    </div>
  );
}

/** The parked pieces, on the canvas surface (inside its pan/zoom transform,
 *  so they move with the artboards). */
export function ParkedPieces({ zoom }: { zoom: number }) {
  const parked = useStore((s) => s.parked);
  return (
    <>
      {visibleParked(parked).map((p) => (
        <ParkedCard key={p.id} piece={p} zoom={zoom} />
      ))}
    </>
  );
}

function ParkedCard({ piece, zoom }: { piece: ParkedPiece; zoom: number }) {
  const moveParked = useStore((s) => s.moveParked);
  const placeParked = useStore((s) => s.placeParked);
  const deleteParked = useStore((s) => s.deleteParked);
  const [offset, setOffset] = useState<Point | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const start = useRef<{ screen: Point; pointer: number } | null>(null);

  // Chrome on the card (caption, delete) is drawn at a fixed screen size,
  // like every other piece of canvas chrome: scaled with the page it would be
  // unreadable zoomed out.
  const chromeScale = 1 / (zoom > 0 ? zoom : 1);
  const unsaved = piece.removal !== null;

  return (
    <div
      className="absolute"
      style={{
        left: piece.x + (offset?.x ?? 0),
        top: piece.y + (offset?.y ?? 0),
        width: piece.width,
        height: piece.height,
      }}
    >
      <div
        className="absolute left-0 bottom-full flex items-center gap-1 whitespace-nowrap pb-1 text-2xs"
        style={{ transform: `scale(${chromeScale})`, transformOrigin: "0 100%" }}
      >
        <span className="font-medium text-ink">{piece.clip.label}</span>
        <span className="text-ink-faint">
          parked from {piece.fromRoute === "/" ? "Home" : piece.fromRoute}
          {unsaved ? " · not saved yet" : ""}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            if (confirmDelete || unsaved) deleteParked(piece.id);
            else setConfirmDelete(true);
          }}
          onBlur={() => setConfirmDelete(false)}
          title={
            unsaved
              ? "Delete — the element is removed from its page when you save"
              : "Delete this piece — dedup holds the only copy, so it is gone for good"
          }
          className={`rounded px-1 ${confirmDelete ? "bg-danger text-white" : "text-ink-faint hover:text-ink"}`}
        >
          {confirmDelete ? "Delete for good?" : <Cross2Icon width={10} height={10} />}
        </button>
      </div>
      <div
        role="button"
        aria-label={`Parked ${piece.clip.label} — drag into an artboard to place it`}
        title="Drag into an artboard to place it"
        className={`h-full w-full cursor-grab overflow-hidden rounded-sm bg-white shadow-xl outline outline-2 outline-dashed ${
          over ? "outline-accent opacity-60" : "outline-accent/50"
        } ${offset ? "cursor-grabbing" : ""}`}
        style={{ outlineOffset: 2 * chromeScale, outlineWidth: 2 * chromeScale }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          start.current = { screen: { x: e.clientX, y: e.clientY }, pointer: e.pointerId };
        }}
        onPointerMove={(e) => {
          const s0 = start.current;
          if (!s0) return;
          const dx = e.clientX - s0.screen.x;
          const dy = e.clientY - s0.screen.y;
          if (!offset && Math.abs(dx) + Math.abs(dy) < 4) return;
          setOffset({ x: dx / zoom, y: dy / zoom });
          setOver(probeAt({ x: e.clientX, y: e.clientY }, null));
        }}
        onPointerUp={(e) => {
          const s0 = start.current;
          start.current = null;
          if (!s0 || !offset) return; // a click, not a drag
          const answer = endProbe();
          const moved = { x: piece.x + offset.x, y: piece.y + offset.y };
          setOffset(null);
          setOver(null);
          if (answer) {
            void placeParked(piece.id, { id: answer.id, position: answer.position });
          } else if (artboardAt({ x: e.clientX, y: e.clientY }, boardsOnScreen())) {
            useStore.getState().setNotice("Nothing to drop onto there — aim at an element in that page.");
          } else {
            moveParked(piece.id, moved);
          }
        }}
        onPointerCancel={() => {
          start.current = null;
          endProbe();
          setOffset(null);
          setOver(null);
        }}
      >
        {piece.picture ? (
          <img src={piece.picture} alt="" draggable={false} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ink-faint" style={{ fontSize: 12 * chromeScale }}>
            {piece.clip.label}
          </div>
        )}
      </div>
    </div>
  );
}
