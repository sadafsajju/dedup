// Message bridge to the overlay scripts running inside the canvas iframes
// (FR-2.2). Each page artboard is its own frame pinned to a route; the Canvas
// registers every frame under its route, commands broadcast to all of them
// (staged edits and tool mode must stay consistent across pages).

import type { DropPosition } from "./types";

/**
 * One staged structural op as the overlay understands it — addressed by
 * dedupId, never by DOM reference, so it can be re-applied verbatim after
 * React re-renders the nodes it touched.
 */
export type OverlayStructuralOp =
  | { op: "remove"; id: string }
  | {
      op: "insert";
      id: string;
      /** Stamped onto the preview node as its `data-dedup-id`, so a staged
       * insert is selectable before it has a source node. */
      pendingId: string;
      position: DropPosition;
      html: string;
    }
  | { op: "move"; id: string; to: string; position: DropPosition };

type OverlayCommand =
  | { type: "select-id"; id: string }
  | { type: "clear" }
  /** The whole staged program as state — see syncCanvas in lib/store. */
  | {
      type: "stage";
      classes: Record<string, { from: string; to: string }>;
      texts: Record<string, { from: string; to: string }>;
      structural: OverlayStructuralOp[];
    }
  /** Arm/disarm canvas gestures: dragging elements, click-to-insert. */
  | { type: "set-edit-mode"; drag: boolean; insert: boolean }
  /** Whether the selected element may be resized by its corner grips — the
   * write-back's own verdict on whether its className is editable, so a grip
   * never appears on something a size edit would be refused for. */
  | { type: "set-resizable"; id: string | null; enabled: boolean }
  /** Canvas zoom, so the grips keep a constant on-screen size. */
  | { type: "set-zoom"; zoom: number }
  /** Permission to put the caret in an element (answers text-edit-request). */
  | { type: "text-edit-begin"; id: string }
  /** Take the caret back off the canvas (leaving the text tool). */
  | { type: "text-edit-end" }
  /** Highlight an element as if hovered on the canvas (Layers tree rows). */
  | { type: "hover-id"; id: string | null }
  /** Force a layer-tree report (they otherwise push on DOM mutations). */
  | { type: "list-layers" }
  /** Ask for one element's rendered HTML — a copy's staged preview. */
  | { type: "copy-element"; id: string }
  /** Mark an element as the one the AI is currently working on, or null to
   * stop. The canvas draws it; the editor is the only side that knows. */
  | { type: "set-busy"; id: string | null }
  /** Let a held frame resume: flushes the timers the hold queued. */
  | { type: "release-hold" }
  | { type: "list-files" }
  | { type: "list-sizes" }
  | { type: "set-mode"; mode: "inspect" | "browse" }
  | { type: "set-viewport"; height: number }
  | { type: "navigate"; path: string }
  /** Fresh document load. `path` reloads *at* that route rather than wherever
   * the frame currently sits — how a newly enabled mock session reaches a
   * frame the app already bounced to its login page. */
  | { type: "reload"; path?: string };

const frames = new Map<string, HTMLIFrameElement>();

export function registerCanvasIframe(
  el: HTMLIFrameElement | null,
  route = "/",
) {
  if (el) frames.set(route, el);
  else frames.delete(route);
}

/** Which page artboard a window belongs to — keys incoming overlay messages
 * (page heights, wheel coordinates) to the frame that sent them. */
export function routeOfWindow(win: unknown): string | null {
  for (const [route, el] of frames) {
    if (el.contentWindow === win) return route;
  }
  return null;
}

export function sendToOverlay(cmd: OverlayCommand) {
  for (const el of frames.values()) {
    el.contentWindow?.postMessage({ __dedup: true, ...cmd }, "*");
  }
}

/** Command one specific page frame (e.g. snap it back to its pinned route). */
export function sendToFrame(route: string, cmd: OverlayCommand) {
  frames.get(route)?.contentWindow?.postMessage({ __dedup: true, ...cmd }, "*");
}

/** Source files behind one page artboard's rendered elements (FR-5.1 canvas
 * scope) — the scan is scoped to the artboard the user selected. Resolves
 * null when the frame doesn't answer (dev server down, untagged project) —
 * callers fall back to a full scan. */
export function requestFrameFiles(
  route: string,
  timeoutMs = 1500,
): Promise<string[] | null> {
  const el = frames.get(route);
  if (!el?.contentWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (files: string[] | null) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(files);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function onMessage(e: MessageEvent) {
      const m = e.data;
      if (!m || m.__dedup !== true || m.type !== "files") return;
      // Every frame answers a list-files broadcast; only the selected
      // artboard's answer defines the scope.
      if (routeOfWindow(e.source) !== route) return;
      finish(Array.isArray(m.files) ? (m.files as string[]) : null);
    }
    window.addEventListener("message", onMessage);
    sendToFrame(route, { type: "list-files" });
  });
}

/** Rendered on-page size per component (`file#name` → w×h) as measured by
 * one artboard's overlay — the component gallery sizes its cards to match
 * the site. Null when the frame doesn't answer (older overlay bundle, dev
 * server down) — callers fall back to harness-measured sizes. */
export function requestFrameSizes(
  route: string,
  timeoutMs = 1500,
): Promise<Record<string, { w: number; h: number }> | null> {
  const el = frames.get(route);
  if (!el?.contentWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (sizes: Record<string, { w: number; h: number }> | null) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(sizes);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function onMessage(e: MessageEvent) {
      const m = e.data;
      if (!m || m.__dedup !== true || m.type !== "component-sizes") return;
      if (routeOfWindow(e.source) !== route) return;
      finish(
        m.sizes && typeof m.sizes === "object"
          ? (m.sizes as Record<string, { w: number; h: number }>)
          : null,
      );
    }
    window.addEventListener("message", onMessage);
    sendToFrame(route, { type: "list-sizes" });
  });
}

/**
 * One element's rendered HTML — the picture half of a copy (the source half
 * comes from the write-back).
 *
 * Broadcast, not addressed to a route: an element can be on any artboard, and
 * the one holding it is the one that answers. Frames without it stay silent
 * rather than racing a null back, so the only way to get null here is that no
 * frame has it — a dev server that is down, or an id the canvas has since
 * re-rendered away.
 */
export function requestElementHtml(
  id: string,
  timeoutMs = 1500,
): Promise<string | null> {
  if (frames.size === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = (html: string | null) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(html);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    function onMessage(e: MessageEvent) {
      const m = e.data;
      if (!m || m.__dedup !== true || m.type !== "element-html") return;
      if (m.id !== id || typeof m.html !== "string") return;
      finish(m.html as string);
    }
    window.addEventListener("message", onMessage);
    sendToOverlay({ type: "copy-element", id });
  });
}
