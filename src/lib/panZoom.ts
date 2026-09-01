// Pan and zoom, shared by every canvas-like surface.
//
// There are two of them now — the artboard canvas and the drift view — and
// they must feel identical, because they are the same gesture vocabulary
// pointed at different content. Two implementations would diverge in exactly
// the places people notice: how far a wheel tick moves, whether zoom anchors
// on the cursor, where the clamp sits.
//
// Each surface owns its own transform rather than sharing one. Switching tabs
// is a change of scene, not a change of viewport: carrying the canvas's pan
// into the drift view would open it on empty space several thousand pixels
// from any card.

import { useEffect, useRef, useState } from "react";

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export interface Transform {
  zoom: number;
  pan: { x: number; y: number };
}

/**
 * Zoom about a point in container coordinates, keeping whatever is under that
 * point exactly where it is. Returns null when the clamp swallowed the change,
 * so callers can skip a no-op write.
 */
export function zoomToward(
  t: Transform,
  cx: number,
  cy: number,
  factor: number,
): Transform | null {
  const zoom = clampZoom(t.zoom * factor);
  if (zoom === t.zoom) return null;
  const k = zoom / t.zoom;
  return {
    zoom,
    pan: { x: cx - (cx - t.pan.x) * k, y: cy - (cy - t.pan.y) * k },
  };
}

export interface PanZoomOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  /** Read the live transform — a getter, not a value, so the wheel listener
   *  installed once never closes over a stale one. */
  read: () => Transform;
  write: (t: Transform) => void;
  /** Which pointer buttons start a drag. The canvas reserves the left button
   *  for selection and only pans on middle-drag; a read-only surface can pan
   *  with either. */
  dragButtons?: number[];
  /** Only start a drag when the press landed on the background. */
  isBackground?: (target: EventTarget | null) => boolean;
}

/**
 * Wheel to pan, ⌘/Ctrl-wheel (and pinch) to zoom at the cursor, drag to pan.
 * Returns handlers to spread onto the surface plus whether a drag is running,
 * which is only ever used to swap the cursor.
 */
export function usePanZoom({
  containerRef,
  read,
  write,
  dragButtons = [0, 1],
  isBackground,
}: PanZoomOptions) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const t = read();
      if (e.metaKey || e.ctrlKey) {
        const rect = el.getBoundingClientRect();
        const next = zoomToward(
          t,
          e.clientX - rect.left,
          e.clientY - rect.top,
          Math.exp(-e.deltaY * 0.01),
        );
        if (next) write(next);
      } else {
        write({
          zoom: t.zoom,
          pan: { x: t.pan.x - e.deltaX, y: t.pan.y - e.deltaY },
        });
      }
    };
    // Not passive: panning and zooming both have to stop the page doing its
    // own scroll with the same wheel event.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerRef, read, write]);

  return {
    dragging,
    onPointerDown(e: React.PointerEvent<HTMLElement>) {
      if (!dragButtons.includes(e.button)) return;
      if (isBackground && !isBackground(e.target)) return;
      e.preventDefault();
      drag.current = { x: e.clientX, y: e.clientY };
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove(e: React.PointerEvent<HTMLElement>) {
      const d = drag.current;
      if (!d) return;
      const t = read();
      write({
        zoom: t.zoom,
        pan: { x: t.pan.x + e.clientX - d.x, y: t.pan.y + e.clientY - d.y },
      });
      drag.current = { x: e.clientX, y: e.clientY };
    },
    onPointerUp() {
      drag.current = null;
      setDragging(false);
    },
    onPointerCancel() {
      drag.current = null;
      setDragging(false);
    },
  };
}
